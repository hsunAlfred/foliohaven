import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { finished, pipeline } from 'node:stream/promises';
import {
  ArticleWriteSchema,
  BuildJobRequestSchema,
  CancellationRequestSchema,
  CurrentArtifactSchema,
  EditModeUpdateSchema,
  JobListQuerySchema,
  MediaJobRequestSchema,
  MediaListQuerySchema,
  MediaSourceUpdateSchema,
  RecoveryResolutionSchema,
  TaxonomyMigrationRequestSchema,
  UuidSchema,
  paginateRecoveries,
} from '@foliohaven/core';
import type { TaxonomyMigrationPlan } from '@foliohaven/core';
import { fixedPages } from '@foliohaven/site/registry';
import { createLocalRuntime } from '../runtime/services.js';
import { RepositoryError, stableHash } from '../files/io.js';
import { parseContract } from '../content/errors.js';
import type { ArtifactRecoveryState } from '../build/artifacts/index.js';
import type {
  OperationReservation,
  StoredResponse,
} from '../operations/index.js';
import { jsonValue, safeFailure } from '../operations/value.js';
import { PreviewStore } from '../previews/index.js';
import type { LocalService, LocalServiceOptions } from './types.js';
import {
  authenticate,
  byteRange,
  compatibleHeader,
  fail,
  header,
  HttpError,
  json,
  mutationOrigin,
  query,
  readJson,
  requestUrl,
  sliceStream,
} from './transport.js';

const routes = [
  ['health', /^\/api\/v1\/health$/u, ['GET']],
  ['workspace', /^\/api\/v1\/workspace$/u, ['GET']],
  ['current-artifact', /^\/api\/v1\/artifacts\/current$/u, ['GET']],
  ['edit-mode', /^\/api\/v1\/workspace\/edit-mode$/u, ['PUT']],
  ['articles', /^\/api\/v1\/articles$/u, ['GET', 'POST']],
  ['article-options', /^\/api\/v1\/article-options$/u, ['GET']],
  ['publication', /^\/api\/v1\/articles\/([^/]+)\/publication$/u, ['PATCH']],
  ['article', /^\/api\/v1\/articles\/([^/]+)$/u, ['GET', 'PUT', 'DELETE']],
  ['taxonomy', /^\/api\/v1\/taxonomy$/u, ['GET', 'PUT']],
  ['migrations', /^\/api\/v1\/taxonomy-migrations$/u, ['POST']],
  ['settings', /^\/api\/v1\/site-settings$/u, ['GET', 'PUT']],
  ['previews', /^\/api\/v1\/previews$/u, ['POST']],
  ['preview', /^\/api\/v1\/previews\/([^/]+)\/document$/u, ['GET']],
  ['styles', /^\/api\/v1\/preview-assets\/styles\.css$/u, ['GET']],
  ['sources', /^\/api\/v1\/media\/sources$/u, ['GET', 'POST']],
  ['source', /^\/api\/v1\/media\/sources\/([^/]+)$/u, ['GET', 'PUT', 'DELETE']],
  ['media-jobs', /^\/api\/v1\/media-jobs$/u, ['POST']],
  ['media-file', /^\/api\/v1\/media\/files\/([^/]+)\/([^/]+)$/u, ['GET']],
  ['build-jobs', /^\/api\/v1\/build-jobs$/u, ['POST']],
  ['jobs', /^\/api\/v1\/jobs$/u, ['GET']],
  ['retry-input', /^\/api\/v1\/jobs\/([^/]+)\/retry-input$/u, ['GET']],
  ['job', /^\/api\/v1\/jobs\/([^/]+)$/u, ['GET']],
  ['operation', /^\/api\/v1\/operations\/([^/]+)$/u, ['GET']],
  ['cancellation', /^\/api\/v1\/jobs\/([^/]+)\/cancellation$/u, ['PUT']],
  ['recoveries', /^\/api\/v1\/recoveries$/u, ['GET']],
  [
    'recovery-file',
    /^\/api\/v1\/recoveries\/([^/]+)\/files\/([^/]+)$/u,
    ['GET'],
  ],
  ['resolution', /^\/api\/v1\/recoveries\/([^/]+)\/resolution$/u, ['PUT']],
  ['recovery', /^\/api\/v1\/recoveries\/([^/]+)$/u, ['GET']],
] as const;

function match(ifMatch: string | undefined, current: string): void {
  if (ifMatch === undefined)
    throw new RepositoryError(
      'PRECONDITION_REQUIRED',
      '請附上最新版本If-Match。',
      428,
      current,
    );
  if (!/^"[a-f0-9]{64}"$/u.test(ifMatch))
    throw new RepositoryError(
      'INVALID_IF_MATCH',
      'If-Match必須為單一強版本。',
      400,
      current,
    );
  if (ifMatch !== current)
    throw new RepositoryError(
      'PRECONDITION_FAILED',
      '工作區已更新，請重新讀取。',
      412,
      current,
    );
}

/** Node程序內的組合入口；任意命令、路徑、token及依賴注入均不是HTTP輸入。 */
export async function createLocalService(
  options: LocalServiceOptions,
): Promise<LocalService> {
  if (!/^[\x21-\x7e]{32,512}$/u.test(options.proxyToken))
    throw new HttpError('INVALID_SERVICE_TOKEN', '本機服務驗證設定無效。', 500);
  const {
    repository,
    artifacts,
    media,
    content,
    operations,
    jobs,
    scanInputs,
    scanWorkspaceInputs,
    htmlCache,
    close: closeRuntime,
  } = await createLocalRuntime(options);
  const previews = new PreviewStore({
    repository,
    fixedPages,
    manifest: (session) => media.manifest(undefined, session),
    htmlCache,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const plans = new Map<string, TaxonomyMigrationPlan>();
  const now = () => (options.clock?.() ?? new Date()).getTime();
  const controllers = new Set<AbortController>();
  const requests = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  let closing = false;
  let listening = false;
  let closeTask: Promise<void> | undefined;
  const gated = <T>(fn: () => Promise<T>) =>
    artifacts.withStateGate(async (state) => {
      if (state.recoveryState !== 'ready')
        throw new HttpError(
          'BUILD_RECOVERY_REQUIRED',
          '請先完成產物復原。',
          409,
        );
      return fn();
    });
  const combinedWorkspace = async (
    state: ArtifactRecoveryState,
    signal?: AbortSignal,
  ) => {
    const current = await repository.workspace({
      scanInputs: () => scanWorkspaceInputs(signal),
      ...(signal === undefined ? {} : { signal }),
    });
    const value = {
      ...current.value,
      recoveryState:
        state.recoveryState === 'recovery-required'
          ? ('recovery-required' as const)
          : current.value.recoveryState,
    };
    return {
      value,
      repositoryEtag: current.etag,
      etag: `"${stableHash([current.etag, value])}"`,
    };
  };
  async function post(
    request: IncomingMessage,
    response: ServerResponse,
    kind: string,
    payload: unknown,
    action: (reservation: OperationReservation) => Promise<StoredResponse>,
  ): Promise<void> {
    const key = header(request, 'idempotency-key');
    if (!key)
      throw new HttpError(
        'IDEMPOTENCY_KEY_REQUIRED',
        '請提供Idempotency-Key UUID。',
        428,
      );
    const input = { key, kind, payload };
    const result = await operations.reserve(input);
    if (result.status === 'replay') {
      json(
        response,
        result.response.httpStatus,
        result.response.response,
        result.response.headers,
      );
      return;
    }
    try {
      const value = await action(result.reservation);
      await operations.complete(result.reservation, value);
      json(response, value.httpStatus, value.response, value.headers);
    } catch (error) {
      // 來源已提交而回應保存失敗時，先從真正journal證據恢復原始結果。
      await operations.initialize();
      const summary = await operations.get(result.reservation.id);
      if (summary.status === 'committed') {
        const recovered = await operations.reserve(input);
        if (recovered.status === 'replay') {
          json(
            response,
            recovered.response.httpStatus,
            recovered.response.response,
            recovered.response.headers,
          );
          return;
        }
      }
      await operations.fail(
        result.reservation,
        safeFailure(error, 'OPERATION_FAILED'),
        error instanceof RepositoryError &&
          error.status >= 400 &&
          error.status <= 599
          ? error.status
          : 500,
      );
      throw error;
    }
  }
  async function recoveryStore(id: string) {
    parseContract(UuidSchema, id);
    const [sourceRows, buildRows] = await Promise.all([
      repository.listRecoveries(),
      artifacts.listRecoveries(),
    ]);
    const source = sourceRows.some((row) => row.id === id);
    const artifact = buildRows.some((row) => row.id === id);
    if (source && artifact)
      throw new HttpError(
        'RECOVERY_ID_CONFLICT',
        '復原識別重複，請保留資料。',
        409,
      );
    if (!source && !artifact)
      throw new HttpError('RECOVERY_NOT_FOUND', '復原紀錄不存在。', 404);
    return artifact ? artifacts : repository;
  }
  async function dispatch(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const controller = new AbortController();
    controllers.add(controller);
    const aborted = () => controller.abort();
    request.once('aborted', aborted);
    response.once('close', aborted);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 未知path亦先驗證，避免未驗證的服務探測；health僅精確GET資源豁免。
      if (request.url?.split('?')[0] !== '/api/v1/health')
        authenticate(request, options.proxyToken);
      const url = requestUrl(request);
      const found = routes.find(([, pattern]) => pattern.test(url.pathname));
      if (!found)
        throw new HttpError('RESOURCE_NOT_FOUND', '資源不存在。', 404);
      const [name, pattern, methods] = found;
      const method = request.method ?? '';
      if (!(methods as readonly string[]).includes(method)) {
        response.setHeader('Allow', methods.join(', '));
        throw new HttpError(
          'METHOD_NOT_ALLOWED',
          '此資源不支援指定方法。',
          405,
        );
      }
      if (closing)
        throw new HttpError('SERVICE_STOPPING', '本機服務正在停止。', 503);
      const origin = method === 'GET' ? undefined : mutationOrigin(request);
      if (request.headers.expect === '100-continue') response.writeContinue();
      const timeout =
        name === 'previews'
          ? 10_000
          : name === 'sources' && method === 'POST'
            ? 900_000
            : 15_000;
      timer = setTimeout(() => {
        controller.abort();
        fail(
          response,
          new HttpError('REQUEST_TIMEOUT', '請求超過時間限制。', 408),
          requestId,
        );
      }, timeout);
      timer.unref();
      const body = () => readJson(request, controller.signal);
      const params = pattern.exec(url.pathname);
      const id = params?.[1] ?? '';
      const ifMatch = () => header(request, 'if-match');
      if (name === 'health') {
        json(response, 200, { status: 'ok' });
        return;
      }
      if (name === 'workspace') {
        const value = await artifacts.withStateGate(
          (state) => combinedWorkspace(state, controller.signal),
          { signal: controller.signal },
        );
        json(response, 200, value.value, { ETag: value.etag });
        return;
      }
      if (name === 'current-artifact') {
        const value = CurrentArtifactSchema.parse(await artifacts.current());
        const etag = `"${stableHash(jsonValue(value))}"`;
        const condition = header(request, 'if-none-match');
        // GET 的 If-None-Match 使用 weak comparison；回應本身一律 strong ETag。
        if (
          condition?.trim() === '*' ||
          condition
            ?.split(',')
            .some((item) => item.trim().replace(/^W\//u, '') === etag)
        ) {
          response.writeHead(304, { ETag: etag });
          response.end();
          return;
        }
        json(response, 200, value, { ETag: etag });
        return;
      }
      if (name === 'edit-mode') {
        const input = parseContract(EditModeUpdateSchema, await body());
        const value = await artifacts.withStateGate(async (state) => {
          const current = await combinedWorkspace(state);
          match(ifMatch(), current.etag);
          await repository.setEditMode(input.mode, current.repositoryEtag, {
            scanInputs,
          });
          return combinedWorkspace(state);
        });
        json(response, 200, value.value, { ETag: value.etag });
        return;
      }
      if (name === 'article-options') {
        json(response, 200, await content.listArticleOptions(query(url)));
        return;
      }
      if (name === 'articles') {
        if (method === 'GET') {
          json(response, 200, await content.listArticles(query(url)));
          return;
        }
        const input = parseContract(ArticleWriteSchema, await body());
        await post(
          request,
          response,
          'article-create',
          input,
          async (reservation) =>
            gated(async () => {
              const result = await content.createArticle(input, {
                operation: operations.receipt(reservation, { httpStatus: 201 }),
              });
              const location = `/api/v1/articles/${result.value.id}`;
              return {
                httpStatus: 201,
                response: jsonValue(result.value),
                headers: { ETag: result.etag, Location: location },
                resourceUrl: location,
              };
            }),
        );
        return;
      }
      if (name === 'article' || name === 'publication') {
        if (method === 'GET') {
          const result = await content.getArticle(id);
          json(response, 200, result.value, { ETag: result.etag });
          return;
        }
        if (method === 'DELETE') {
          await gated(() => content.deleteArticle(id, ifMatch()));
          json(response, 204);
          return;
        }
        const input = await body();
        const result = await gated(async () =>
          name === 'publication'
            ? content.patchPublication(id, input, ifMatch())
            : content.putArticle(id, input, ifMatch()),
        );
        json(response, 200, result.value, { ETag: result.etag });
        return;
      }
      if (name === 'taxonomy' || name === 'settings') {
        if (method === 'GET') {
          const result =
            name === 'taxonomy'
              ? await content.getTaxonomy()
              : await content.getSiteSettings();
          json(response, 200, result.value, { ETag: result.etag });
          return;
        }
        const input = await body();
        const result = await gated(async () =>
          name === 'taxonomy'
            ? content.putTaxonomy(input, ifMatch())
            : content.putSiteSettings(input, ifMatch()),
        );
        json(response, 200, result.value, { ETag: result.etag });
        return;
      }
      if (name === 'migrations') {
        const input = parseContract(
          TaxonomyMigrationRequestSchema,
          await body(),
        );
        for (const [key, plan] of plans)
          if (Date.parse(plan.expiresAt) <= now()) plans.delete(key);
        if (!input.confirmed) {
          const plan = await gated(() => content.planMigration(input));
          plans.set(plan.planId, plan);
          json(response, 200, plan);
          return;
        }
        await post(
          request,
          response,
          'taxonomy-migration',
          input,
          async (reservation) => {
            const plan = input.planId ? plans.get(input.planId) : undefined;
            if (
              !plan ||
              Date.parse(plan.expiresAt) <= now() ||
              (['kind', 'from', 'to', 'workspaceRevision'] as const).some(
                (key) => input[key] !== plan[key],
              )
            )
              throw new HttpError(
                'MIGRATION_PLAN_STALE',
                '影響計畫已過期或與原先確認內容不符。',
                409,
              );
            const current = await artifacts.withStateGate(combinedWorkspace);
            if (
              current.value.recoveryState !== 'ready' ||
              current.value.editMode !== 'studio'
            )
              throw new HttpError(
                'WORKSPACE_NOT_WRITABLE',
                '請先完成復原並切換Studio編輯模式。',
                409,
              );
            if (current.value.revision !== input.workspaceRevision)
              throw new HttpError(
                'MIGRATION_PLAN_STALE',
                '工作區已變更，請重新確認影響清單。',
                409,
              );
            const job = await jobs.create({
              type: 'taxonomy',
              payload: input,
              sourceRevision: input.workspaceRevision,
              operation: reservation,
            });
            return {
              httpStatus: 202,
              response: jsonValue(job),
              headers: { Location: `/api/v1/jobs/${job.id}` },
              jobUrl: `/api/v1/jobs/${job.id}`,
            };
          },
        );
        return;
      }
      if (name === 'previews') {
        // 同一editor生命週期使用固定UUID；與Core文章DTO分離，避免新增尚未保存的識別欄位。
        const editorId = compatibleHeader(request, 'editor-id');
        if (!editorId)
          throw new HttpError(
            'EDITOR_ID_REQUIRED',
            '預覽需要有效的編輯工作階段識別。',
            422,
          );
        const result = await previews.create(await body(), {
          editorId,
          studioOrigin: origin ?? '',
          signal: controller.signal,
        });
        json(response, 201, result, { Location: result.documentUrl });
        return;
      }
      if (name === 'preview') {
        const document = previews.document(id);
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(document.html)),
          'Content-Security-Policy': document.csp,
        });
        response.end(document.html);
        return;
      }
      if (name === 'styles') {
        const bytes = await previews.styles();
        response.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Content-Length': String(bytes.length),
        });
        response.end(bytes);
        return;
      }
      if (name === 'sources') {
        if (method === 'GET') {
          const raw = query(url);
          parseContract(MediaListQuerySchema, raw);
          json(response, 200, await media.list(raw));
          return;
        }
        const key = header(request, 'idempotency-key');
        if (!key)
          throw new HttpError(
            'IDEMPOTENCY_KEY_REQUIRED',
            '請提供Idempotency-Key UUID。',
            428,
          );
        parseContract(UuidSchema, key);
        if (
          !/^multipart\/form-data\s*;/iu.test(
            header(request, 'content-type') ?? '',
          )
        )
          throw new HttpError(
            'UNSUPPORTED_CONTENT_TYPE',
            '媒體來源需要multipart/form-data。',
            415,
          );
        const staged = await media.stageUpload(request, {
          signal: controller.signal,
        });
        try {
          await post(
            request,
            response,
            'media-source-create',
            { mediaPayloadHash: staged.payloadHash },
            async (reservation) =>
              gated(async () => {
                const result = await media.register(
                  staged,
                  operations.receipt(reservation, { httpStatus: 201 }),
                );
                const location =
                  result.location ?? `/api/v1/media/sources/${result.value.id}`;
                return {
                  httpStatus: 201,
                  response: jsonValue(result.value),
                  headers: { ETag: result.etag, Location: location },
                  resourceUrl: location,
                };
              }),
          );
        } finally {
          await media.discard(staged);
        }
        return;
      }
      if (name === 'source') {
        parseContract(UuidSchema, id);
        if (method === 'GET') {
          const result = await media.get(id, { signal: controller.signal });
          json(response, 200, result.value, { ETag: result.etag });
          return;
        }
        if (method === 'DELETE') {
          await gated(() =>
            media.remove(id, ifMatch(), { signal: controller.signal }),
          );
          json(response, 204);
          return;
        }
        const input = parseContract(MediaSourceUpdateSchema, await body());
        const result = await gated(() =>
          media.update(id, input, ifMatch(), { signal: controller.signal }),
        );
        json(response, 200, result.value, { ETag: result.etag });
        return;
      }
      if (name === 'media-jobs') {
        const input = parseContract(MediaJobRequestSchema, await body());
        await post(
          request,
          response,
          'media-job-create',
          input,
          async (reservation) => {
            const current = await media.get(input.sourceId, {
              signal: controller.signal,
            });
            const job = await jobs.create({
              type: 'media',
              payload: input,
              sourceRevision: current.inputRevision,
              operation: reservation,
            });
            return {
              httpStatus: 202,
              response: jsonValue(job),
              headers: { Location: `/api/v1/jobs/${job.id}` },
              jobUrl: `/api/v1/jobs/${job.id}`,
            };
          },
        );
        return;
      }
      if (name === 'media-file') {
        parseContract(UuidSchema, id);
        const file = await media.openVariant(
          id,
          params?.[2] ?? '',
          header(request, 'range'),
        );
        try {
          response.writeHead(file.status, file.headers);
          await pipeline(file.stream, response, { signal: controller.signal });
        } finally {
          // A disconnected response can make pipeline reject before it takes
          // ownership of the input stream. Always close its FileHandle here.
          file.stream.destroy();
          await finished(file.stream, { cleanup: true }).catch(() => undefined);
        }
        return;
      }
      if (name === 'build-jobs') {
        const input = parseContract(BuildJobRequestSchema, await body());
        await post(
          request,
          response,
          'build-job-create',
          input,
          async (reservation) => {
            const current = await artifacts.withStateGate(combinedWorkspace);
            if (current.value.recoveryState !== 'ready')
              throw new HttpError('RECOVERY_REQUIRED', '請先完成復原。', 409);
            const job = await jobs.create({
              type: 'build',
              payload: input,
              sourceRevision: current.value.revision,
              operation: reservation,
            });
            return {
              httpStatus: 202,
              response: jsonValue(job),
              headers: { Location: `/api/v1/jobs/${job.id}` },
              jobUrl: `/api/v1/jobs/${job.id}`,
            };
          },
        );
        return;
      }
      if (name === 'jobs') {
        json(
          response,
          200,
          await jobs.list(parseContract(JobListQuerySchema, query(url))),
        );
        return;
      }
      if (name === 'job') {
        json(response, 200, await jobs.get(id));
        return;
      }
      if (name === 'retry-input') {
        json(response, 200, await jobs.retryInput(id));
        return;
      }
      if (name === 'operation') {
        json(response, 200, await operations.get(id));
        return;
      }
      if (name === 'cancellation') {
        parseContract(CancellationRequestSchema, await body());
        const result = await jobs.cancel(id);
        json(response, result.httpStatus, result.job);
        return;
      }
      if (name === 'recoveries') {
        const raw = query(url);
        if (Object.keys(raw).some((key) => !['page', 'pageSize'].includes(key)))
          throw new HttpError('INVALID_QUERY', '復原清單僅接受分頁參數。', 422);
        const parsed = parseContract(JobListQuerySchema, raw);
        const rows = [
          ...(await repository.listRecoveries()),
          ...(await artifacts.listRecoveries()),
        ];
        json(
          response,
          200,
          paginateRecoveries(rows, {
            page: parsed.page,
            pageSize: parsed.pageSize,
          }),
        );
        return;
      }
      if (
        name === 'recovery' ||
        name === 'resolution' ||
        name === 'recovery-file'
      ) {
        const store = await recoveryStore(id);
        if (name === 'recovery') {
          const result = await store.recovery(id);
          json(response, 200, result.value, { ETag: result.etag });
          return;
        }
        if (name === 'resolution') {
          const input = parseContract(RecoveryResolutionSchema, await body());
          json(
            response,
            200,
            await store.resolveRecovery(id, input, ifMatch()),
          );
          return;
        }
        const fileId = params?.[2] ?? '';
        const file = await store.recoveryFile(id, fileId);
        try {
          const range = byteRange(header(request, 'range'), file.byteSize);
          const source = range ? sliceStream(file.stream, range) : file.stream;
          response.writeHead(range ? 206 : 200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="recovery-${fileId}.bin"`,
            'Content-Length': String(
              range ? range.end - range.start + 1 : file.byteSize,
            ),
            'Accept-Ranges': 'bytes',
            ETag: `"${file.sha256}"`,
            ...(range
              ? {
                  'Content-Range': `bytes ${range.start}-${range.end}/${file.byteSize}`,
                }
              : {}),
          });
          await pipeline(source, response, { signal: controller.signal });
        } finally {
          file.stream.destroy();
        }
        return;
      }
      throw new HttpError('RESOURCE_NOT_FOUND', '資源不存在。', 404);
    } catch (error) {
      fail(response, error, requestId);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      request.off('aborted', aborted);
      response.off('close', aborted);
    }
  }
  const serve = (request: IncomingMessage, response: ServerResponse) => {
    const task = dispatch(request, response);
    requests.add(task);
    void task.finally(() => requests.delete(task));
  };
  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      requestTimeout: 900_000,
      headersTimeout: 15_000,
      keepAliveTimeout: 5_000,
    },
    serve,
  );
  server.on('checkContinue', serve);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    const status =
      'code' in error && error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
    const requestId = randomUUID();
    const body = JSON.stringify({
      error: {
        code: status === 431 ? 'HEADERS_TOO_LARGE' : 'INVALID_HTTP',
        message: 'HTTP請求格式或標頭不符合限制。',
        requestId,
        retryable: false,
        issues: [],
      },
    });
    socket.end(
      `HTTP/1.1 ${status} ${status === 431 ? 'Request Header Fields Too Large' : 'Bad Request'}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nX-Request-Id: ${requestId}\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  });
  try {
    jobs.start();
  } catch (error) {
    previews.close();
    plans.clear();
    await closeRuntime();
    throw error;
  }
  return {
    async listen(input = {}) {
      const port = input.port ?? 3001;
      if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
        throw new HttpError(
          'INVALID_SERVICE_PORT',
          '本機服務連接埠無效。',
          500,
        );
      if (listening || closing)
        throw new HttpError(
          'SERVICE_ALREADY_STARTED',
          '本機服務已啟動或停止。',
          409,
        );
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      listening = true;
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new HttpError(
          'SERVICE_BIND_FAILED',
          '本機服務無法取得連接位址。',
          500,
        );
      return {
        host: '127.0.0.1',
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
      };
    },
    async close() {
      if (closeTask) return closeTask;
      closing = true;
      closeTask = (async () => {
        try {
          const stopped = new Promise<void>((resolve) => {
            if (!listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          });
          for (const controller of controllers) controller.abort();
          for (const socket of sockets) socket.destroy();
          await jobs.close();
          await Promise.allSettled([...requests]);
          await stopped;
          previews.close();
          plans.clear();
        } finally {
          await closeRuntime();
        }
      })();
      return closeTask;
    },
  };
}
