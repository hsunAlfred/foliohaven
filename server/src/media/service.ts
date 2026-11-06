import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, rename, rm } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  MediaAssetSchema,
  MediaSourceSchema,
  MediaSourceResourceSchema,
  MediaSourceUpdateSchema,
  MediaListQuerySchema,
  ManagedMediaPathSchema,
  UuidSchema,
  CONTENT_LIMITS,
  analyzeHtml,
  filterMediaSources,
  siteRelativePath,
  siteIconMediaRefs,
} from '@foliohaven/core';
import type {
  JsonValue,
  MediaAsset,
  MediaManifest,
  MediaSourceResource,
  MediaJobRequest,
} from '@foliohaven/core';
import type { OperationReceipt, ReadSession } from '../files/types.js';
import {
  atomicJson,
  copyDurable,
  isMissing,
  readJson,
  representationEtag,
  requireEtagMatch,
  record,
  sha256,
  safeMkdir,
  safePath,
  syncDirectory,
} from '../files/io.js';
import { FileRevisionCache } from '../files/revision-cache.js';
import type { MediaDigestCache } from './storage.js';
import { acquireFileLease } from '../runtime/lease.js';
import { mapConcurrent } from '../runtime/parallel.js';
import { acquireMediaSlot } from './pool.js';
import { runMediaWorker } from './process.js';
import type { WorkerResult } from './process.js';
import { cancelled, MediaError } from './errors.js';
import {
  hashOutputs,
  metadataBytes,
  processingDigest,
  readSourceState,
  sourceKeys,
  stagedEtag,
  streamHash,
} from './storage.js';
import type {
  Binding,
  MediaServiceOptions,
  MediaSourceResult,
  MediaSourceList,
  MediaTaskOptions,
  SourceState,
  StagedMedia,
} from './types.js';
import { receiveUpload } from './upload.js';
import { openMediaVariant } from './files.js';
import { MediaReceipts, parseBinding } from './receipts.js';

const imagePreset = 'article-image-v2';
const nativeImagePreset = 'article-image-v3';
const siteIconsPreset = 'site-icons-v1';
const videoPreset = 'article-video-v1';
function presetForImage(mimeType: string) {
  return ['image/svg+xml', 'image/x-icon'].includes(mimeType)
    ? nativeImagePreset
    : imagePreset;
}
function project(
  id: string,
  result: WorkerResult,
  version?: string,
): MediaAsset {
  return MediaAssetSchema.parse({
    id,
    kind: result.inspection.kind,
    sourceSha256: '0'.repeat(64),
    presetVersion:
      version ??
      (result.inspection.kind === 'image'
        ? presetForImage(result.inspection.mimeType)
        : videoPreset),
    tools: result.tools,
    outputs: result.outputs.map(({ variant, ...output }) => ({
      ...output,
      publicPath: `/media/${id}/${variant}`,
    })),
  });
}
function resource(
  state: SourceState,
  inspection: WorkerResult['inspection'],
  asset: MediaAsset | null,
): MediaSourceResource {
  return MediaSourceResourceSchema.parse({
    id: state.source.id,
    kind: state.source.kind,
    displayName: state.source.displayName,
    posterTimeSeconds: state.source.posterTimeSeconds ?? null,
    mimeType: inspection.mimeType,
    byteSize: state.byteSize,
    width: inspection.width,
    height: inspection.height,
    durationSeconds: inspection.durationSeconds,
    sourceSha256: state.sourceRevision,
    asset,
  });
}
function replay(value: MediaSourceResource): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function versioned(
  state: SourceState,
  value: MediaSourceResource,
): MediaSourceResult {
  return {
    value,
    etag: representationEtag(state.etag, value),
    inputRevision: state.etag.slice(1, -1),
  };
}

interface InspectedSource {
  readonly sourceRevision: string;
  readonly inspection: WorkerResult['inspection'];
}
class InspectionRequired extends Error {}

export class MediaService {
  readonly #options: MediaServiceOptions;
  readonly #root: string;
  readonly #receipts: MediaReceipts;
  readonly #digests: MediaDigestCache | undefined;
  constructor(options: MediaServiceOptions) {
    this.#options = options;
    this.#root = resolve(options.repositoryRoot);
    this.#receipts = new MediaReceipts(this.#root);
    this.#digests = options.reuseFileDigests
      ? new FileRevisionCache()
      : undefined;
  }
  #sourceState(session: ReadSession, id: string): Promise<SourceState> {
    return readSourceState(this.#root, session, id, this.#digests);
  }
  #outputs(
    processingHash: string,
    outputs: Parameters<typeof hashOutputs>[2],
  ): Promise<boolean> {
    return hashOutputs(this.#root, processingHash, outputs, this.#digests);
  }
  get repositoryRoot(): string {
    return this.#root;
  }
  async #phase(phase: string, id: string) {
    await this.#options.onPhase?.(phase, id);
  }
  #timeout(kind: 'image' | 'video'): number {
    return kind === 'image'
      ? (this.#options.deadlines?.imageMs ?? 60_000)
      : (this.#options.deadlines?.videoMs ?? 1_800_000);
  }
  async #binding(id: string, state: SourceState): Promise<Binding | null> {
    try {
      const value = parseBinding(
        await readJson(this.#root, `.alfred/media-records/${id}.json`),
        id,
      );
      if (
        value !== null &&
        value.sourceRevision === state.sourceRevision &&
        value.metaRevision === state.metaRevision
      )
        return value;
    } catch {
      // The binding is a derived index. A durable immutable receipt remains
      // authoritative even if projecting this file failed or was interrupted.
    }
    return this.#receipts.binding(state);
  }
  async #saveBinding(binding: Binding): Promise<void> {
    await safeMkdir(this.#root, '.alfred/media-records');
    await atomicJson(
      this.#root,
      `.alfred/media-records/${binding.asset.id}.json`,
      binding,
    );
  }
  async #saveInspection(
    id: string,
    sourceRevision: string,
    inspection: WorkerResult['inspection'],
  ): Promise<void> {
    try {
      await safeMkdir(this.#root, '.alfred/media-inspections');
      await atomicJson(this.#root, `.alfred/media-inspections/${id}.json`, {
        schemaVersion: 1,
        sourceRevision,
        inspection,
      });
    } catch {
      process.stderr.write(
        `${JSON.stringify({ level: 'warning', code: 'MEDIA_INSPECTION_CACHE_UNAVAILABLE', sourceId: id })}\n`,
      );
    }
  }
  #inspectionFits(
    state: SourceState,
    inspection: WorkerResult['inspection'],
  ): boolean {
    const mimes: Readonly<Record<string, string>> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      avif: 'image/avif',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
    };
    return (
      mimes[extname(state.source.source).slice(1)] === inspection.mimeType &&
      MediaSourceResourceSchema.safeParse({
        id: state.source.id,
        kind: state.source.kind,
        displayName: state.source.displayName,
        posterTimeSeconds: state.source.posterTimeSeconds ?? null,
        mimeType: inspection.mimeType,
        byteSize: state.byteSize,
        width: inspection.width,
        height: inspection.height,
        durationSeconds: inspection.durationSeconds,
        sourceSha256: state.sourceRevision,
        asset: null,
      }).success
    );
  }
  async #cachedInspection(
    state: SourceState,
  ): Promise<WorkerResult['inspection'] | null> {
    try {
      const value = await readJson(
        this.#root,
        `.alfred/media-inspections/${state.source.id}.json`,
      );
      if (
        !record(value) ||
        value.schemaVersion !== 1 ||
        value.sourceRevision !== state.sourceRevision ||
        !record(value.inspection)
      )
        return null;
      const inspection =
        value.inspection as unknown as WorkerResult['inspection'];
      return this.#inspectionFits(state, inspection) ? inspection : null;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  async #snapshot(
    id: string,
    requireReady = false,
  ): Promise<{ state: SourceState; directory: string; path: string }> {
    const directory = `.alfred/media-work/${randomUUID()}`;
    await safeMkdir(this.#root, directory);
    try {
      const read = (
        requireReady
          ? this.#options.repository.withBuildInputLock
          : this.#options.repository.withConsistentRead
      ).bind(this.#options.repository);
      return await read(async (session) => {
        const state = await this.#sourceState(session, id);
        const path = await safePath(
          this.#root,
          `${directory}/${state.source.source}`,
        );
        await copyDurable(
          await safePath(this.#root, sourceKeys(id, state.source.source)[0]),
          path,
        );
        if ((await streamHash(path)).sha256 !== state.sourceRevision)
          throw new MediaError(
            'MEDIA_SOURCE_CHANGED',
            '媒體來源在複製期間變更。',
            412,
          );
        return { state, directory, path };
      });
    } catch (error) {
      await rm(await safePath(this.#root, directory), {
        recursive: true,
        force: true,
      });
      throw error;
    }
  }
  async #inspect(
    path: string,
    extension: string,
    kind: 'image' | 'video',
    posterTimeSeconds: number | undefined,
    options: MediaTaskOptions,
  ): Promise<WorkerResult> {
    const lease = await acquireMediaSlot(
      this.#options.coordinationRoot ?? this.#root,
      kind,
      this.#options.lockTimeoutMs ?? 10_000,
      options.signal,
    );
    try {
      await this.#phase('slot-acquired', kind);
      return await runMediaWorker(
        {
          action: 'inspect',
          sourcePath: path,
          extension,
          kind,
          timeoutMs: this.#timeout(kind),
          ...(posterTimeSeconds === undefined ? {} : { posterTimeSeconds }),
        },
        lease.fd,
        options,
      );
    } finally {
      await lease.release();
    }
  }
  async stageSource(
    source: AsyncIterable<Uint8Array>,
    fields: {
      filename: string;
      mimeType: string;
      displayName?: string;
      posterTimeSeconds?: number;
    },
    options: MediaTaskOptions = {},
    afterParts?: Promise<{ displayName?: string; posterTimeSeconds?: number }>,
  ): Promise<StagedMedia> {
    const extension = extname(
      fields.filename.replaceAll('\\', '/').split('/').at(-1) ?? '',
    )
      .slice(1)
      .toLowerCase();
    if (!/^(?:jpe?g|png|webp|avif|svg|ico|mp4|mov|webm)$/u.test(extension))
      throw new MediaError('MEDIA_FORMAT_UNSUPPORTED', '來源副檔名不受支援。');
    const kind = /^(?:mp4|mov|webm)$/u.test(extension) ? 'video' : 'image';
    const guarded = async function* () {
      for await (const chunk of source) {
        cancelled(options.signal);
        yield chunk;
      }
      cancelled(options.signal);
    };
    const binary = await this.#options.repository.stageBinary(
      guarded(),
      kind === 'image'
        ? CONTENT_LIMITS.imageSourceBytes
        : CONTENT_LIMITS.videoSourceBytes,
    );
    try {
      if (afterParts !== undefined)
        fields = { ...fields, ...(await afterParts) };
      const path = await safePath(
        this.#root,
        `.alfred/staging/${binary.preparedBinaryId}.part`,
      );
      const result = await this.#inspect(
        path,
        extension,
        kind,
        fields.posterTimeSeconds,
        options,
      );
      const declaredMime = fields.mimeType.toLowerCase();
      if (
        declaredMime !== result.inspection.mimeType &&
        !(
          result.inspection.mimeType === 'image/x-icon' &&
          declaredMime === 'image/vnd.microsoft.icon'
        )
      )
        throw new MediaError(
          'MEDIA_MIME_MISMATCH',
          '宣告MIME與實際媒體格式不符。',
        );
      const metadata = MediaSourceSchema.safeParse({
        schemaVersion: 1,
        id: randomUUID(),
        kind,
        source: `original.${extension}`,
        displayName:
          fields.displayName ??
          fields.filename.replaceAll('\\', '/').split('/').at(-1),
        ...(fields.posterTimeSeconds === undefined
          ? {}
          : { posterTimeSeconds: fields.posterTimeSeconds }),
      });
      if (!metadata.success)
        throw new MediaError(
          'MEDIA_METADATA_INVALID',
          '媒體名稱或Poster設定不合法。',
        );
      return {
        binary,
        source: metadata.data,
        inspection: result.inspection,
        payloadHash: processingDigest({
          sourceSha256: binary.revision,
          kind,
          source: metadata.data.source,
          displayName: metadata.data.displayName,
          posterTimeSeconds: metadata.data.posterTimeSeconds ?? null,
        }),
      };
    } catch (error) {
      await this.#options.repository.discardBinary(binary);
      throw error;
    }
  }
  stageUpload(
    request: IncomingMessage,
    options: MediaTaskOptions = {},
  ): Promise<StagedMedia> {
    return receiveUpload(this, request, {
      ...options,
      uploadMs: this.#options.deadlines?.uploadMs ?? 900_000,
      idleMs: this.#options.deadlines?.idleMs ?? 30_000,
    });
  }
  async discard(staged: StagedMedia): Promise<void> {
    await this.#options.repository.discardBinary(staged.binary);
  }
  async register(
    staged: StagedMedia,
    receipt?: OperationReceipt,
  ): Promise<MediaSourceResult> {
    const source = MediaSourceSchema.parse(staged.source);
    const meta = metadataBytes(source);
    const keys = sourceKeys(source.id, source.source);
    const path = await safePath(
      this.#root,
      `.alfred/staging/${staged.binary.preparedBinaryId}.part`,
    );
    const actual = await streamHash(path);
    if (
      actual.sha256 !== staged.binary.revision ||
      actual.byteSize !== staged.binary.byteSize
    )
      throw new MediaError('MEDIA_STAGE_CHANGED', '媒體暫存已變更。', 409);
    const rawEtag = await stagedEtag(
      this.#root,
      source.id,
      source.source,
      staged.binary.preparedBinaryId,
      meta,
    );
    const location = `/api/v1/media/sources/${source.id}`;
    const value = resource(
      {
        source,
        sourceRevision: actual.sha256,
        metaRevision: sha256(meta),
        byteSize: actual.byteSize,
        etag: rawEtag,
      },
      staged.inspection,
      null,
    );
    const operation =
      receipt === undefined
        ? undefined
        : {
            ...receipt,
            httpStatus: 201,
            resourceUrl: location,
            response: replay(value),
            headers: {
              ETag: representationEtag(rawEtag, value),
              Location: location,
            },
          };
    try {
      const result = await this.#options.repository.commit({
        kind: 'create',
        changes: [
          {
            resourceKey: keys[0],
            expectedRevision: null,
            content: staged.binary,
          },
          { resourceKey: keys[1], expectedRevision: null, content: meta },
        ],
        ...(operation === undefined ? {} : { operation }),
      });
      if (result.etag !== rawEtag)
        throw new MediaError(
          'MEDIA_ETAG_INVARIANT',
          '媒體交易版本不一致。',
          500,
        );
      await this.#saveInspection(source.id, actual.sha256, staged.inspection);
      return {
        value,
        etag: representationEtag(rawEtag, value),
        inputRevision: rawEtag.slice(1, -1),
        transactionId: result.transactionId,
        location,
      };
    } finally {
      await this.discard(staged);
    }
  }
  async #resourceForState(
    state: SourceState,
    options: MediaTaskOptions = {},
    fallback?: WorkerResult['inspection'],
  ): Promise<MediaSourceResource | null> {
    cancelled(options.signal);
    const binding = await this.#verifiedBinding(state);
    if (binding !== null)
      return resource(state, binding.inspection, binding.asset);
    const inspection =
      fallback && this.#inspectionFits(state, fallback)
        ? fallback
        : await this.#cachedInspection(state);
    if (inspection !== null) return resource(state, inspection, null);
    await this.#phase('inspection-required', state.source.id);
    return null;
  }
  async #verifiedBinding(state: SourceState): Promise<Binding | null> {
    const binding = await this.#binding(state.source.id, state);
    return binding !== null &&
      (await this.#outputs(
        binding.processingHash,
        binding.asset.outputs.map((output) => ({
          variant: output.publicPath.split('/').at(-1) ?? '',
          sha256: output.sha256,
          byteSize: output.byteSize,
        })),
      ))
      ? binding
      : null;
  }
  async #inspectOutsideWriter(
    id: string,
    options: MediaTaskOptions,
  ): Promise<InspectedSource> {
    const snapshot = await this.#snapshot(id);
    try {
      const checked = await this.#inspect(
        snapshot.path,
        extname(snapshot.state.source.source).slice(1),
        snapshot.state.source.kind,
        snapshot.state.source.posterTimeSeconds,
        options,
      );
      await this.#saveInspection(
        id,
        snapshot.state.sourceRevision,
        checked.inspection,
      );
      return {
        sourceRevision: snapshot.state.sourceRevision,
        inspection: checked.inspection,
      };
    } finally {
      await rm(await safePath(this.#root, snapshot.directory), {
        recursive: true,
        force: true,
      });
    }
  }
  async get(
    id: string,
    options: MediaTaskOptions = {},
  ): Promise<MediaSourceResult> {
    let inspected: InspectedSource | undefined;
    for (let attempt = 0; attempt <= 3; attempt++) {
      cancelled(options.signal);
      const current = await this.#options.repository.withConsistentRead(
        async (session) => {
          const state = await this.#sourceState(session, id);
          const value = await this.#resourceForState(
            state,
            options,
            inspected?.sourceRevision === state.sourceRevision
              ? inspected.inspection
              : undefined,
          );
          return value === null ? null : versioned(state, value);
        },
      );
      if (current !== null) return current;
      if (attempt === 3) break;
      // 原生工具永遠在writer外執行；當次inspection不依賴可選disk cache成功。
      inspected = await this.#inspectOutsideWriter(id, options);
    }
    throw new MediaError(
      'MEDIA_SOURCE_CHANGED',
      '媒體來源持續改變，請重新讀取後再試。',
      409,
      true,
    );
  }
  async #withInspectionRetry<T>(
    id: string,
    operation: (inspected: InspectedSource | undefined) => Promise<T>,
    options: MediaTaskOptions,
  ): Promise<T> {
    let inspected: InspectedSource | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await operation(inspected);
      } catch (error) {
        if (!(error instanceof InspectionRequired)) throw error;
        if (attempt === 2) break;
        inspected = await this.#inspectOutsideWriter(id, options);
      }
    }
    throw new MediaError(
      'MEDIA_SOURCE_CHANGED',
      '媒體來源持續改變，請重新讀取後再試。',
      409,
      true,
    );
  }
  async list(query: unknown = {}): Promise<MediaSourceList> {
    const parsed = MediaListQuerySchema.parse(query);
    const page = await this.#options.repository.withConsistentRead(
      async (session) => {
        let nodes: Dirent[];
        try {
          nodes = await readdir(await safePath(this.#root, 'media/source'), {
            withFileTypes: true,
          });
        } catch (error) {
          if (!isMissing(error)) throw error;
          nodes = [];
        }
        const rows = await mapConcurrent(
          nodes.filter((node) => node.name !== '.gitkeep'),
          async (node) => {
            if (
              !node.isDirectory() ||
              node.isSymbolicLink() ||
              !UuidSchema.safeParse(node.name).success
            )
              throw new MediaError(
                'MEDIA_SOURCE_INVALID',
                '媒體來源目錄包含無效項目。',
              );
            const raw = await session.read(
              `media/source/${node.name}/meta.json`,
            );
            if (
              raw === null ||
              raw.bytes.length > CONTENT_LIMITS.mediaMetaBytes
            )
              throw new MediaError(
                'MEDIA_METADATA_INVALID',
                '媒體設定缺失或超過限制。',
              );
            let value: unknown;
            try {
              value = JSON.parse(
                new TextDecoder('utf8', {
                  fatal: true,
                  ignoreBOM: true,
                }).decode(raw.bytes),
              );
            } catch {
              throw new MediaError(
                'MEDIA_METADATA_INVALID',
                '媒體設定不是有效JSON。',
              );
            }
            const item = MediaSourceSchema.safeParse(value);
            if (!item.success || item.data.id !== node.name)
              throw new MediaError(
                'MEDIA_METADATA_INVALID',
                '媒體設定不合法。',
              );
            return {
              id: node.name,
              kind: item.data.kind,
              displayName: item.data.displayName,
              source: item.data.source,
            };
          },
        );
        const selected = filterMediaSources(rows, parsed);
        const items = await mapConcurrent(selected.items, async (row) => {
          const state = await this.#sourceState(session, row.id);
          return {
            id: row.id,
            value: await this.#resourceForState(state),
          };
        });
        return { ...selected, items };
      },
    );
    return {
      items: await Promise.all(
        // Uninspected sources retain get()'s decoder-outside-writer retry path.
        page.items.map(
          async (row) => row.value ?? (await this.get(row.id)).value,
        ),
      ),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }
  async update(
    id: string,
    input: unknown,
    ifMatch: string | undefined,
    options: MediaTaskOptions = {},
  ): Promise<MediaSourceResult> {
    const update = MediaSourceUpdateSchema.parse(input);
    requireEtagMatch(ifMatch, (await this.get(id, options)).etag);
    const snapshot = await this.#snapshot(id);
    try {
      const { posterTimeSeconds: _old, ...base } = snapshot.state.source;
      const candidate = MediaSourceSchema.safeParse({
        ...base,
        displayName: update.displayName,
        ...(update.posterTimeSeconds === undefined
          ? {}
          : { posterTimeSeconds: update.posterTimeSeconds }),
      });
      if (!candidate.success)
        throw new MediaError('MEDIA_METADATA_INVALID', '媒體設定不合法。');
      const checked = await this.#inspect(
        snapshot.path,
        extname(candidate.data.source).slice(1),
        candidate.data.kind,
        candidate.data.posterTimeSeconds,
        options,
      );
      const bytes = metadataBytes(candidate.data);
      const keys = sourceKeys(id, candidate.data.source);
      let value: MediaSourceResource | null | undefined;
      const result = await this.#withInspectionRetry(
        id,
        (inspected) =>
          this.#options.repository.commit({
            kind: 'save',
            changes: [
              {
                resourceKey: keys[1],
                expectedRevision: snapshot.state.metaRevision,
                content: bytes,
              },
            ],
            precondition: {
              ifMatch,
              resourceKeys: keys,
              representationEtag: async (session, raw) => {
                const current = await this.#sourceState(session, id);
                const value = await this.#resourceForState(
                  current,
                  options,
                  inspected?.sourceRevision === current.sourceRevision
                    ? inspected.inspection
                    : current.sourceRevision === snapshot.state.sourceRevision
                      ? checked.inspection
                      : undefined,
                );
                if (value === null) throw new InspectionRequired();
                return representationEtag(raw, value);
              },
            },
            validate: async (session) => {
              const current = await this.#sourceState(session, id);
              if (current.sourceRevision !== snapshot.state.sourceRevision)
                throw new MediaError(
                  'MEDIA_SOURCE_CHANGED',
                  '原檔已變更。',
                  412,
                );
              value = await this.#resourceForState(
                {
                  ...current,
                  source: candidate.data,
                  metaRevision: sha256(bytes),
                },
                options,
                checked.inspection,
              );
            },
          }),
        options,
      );
      if (value === undefined || value === null)
        throw new MediaError(
          'MEDIA_RESULT_INVARIANT',
          '媒體保存結果缺失。',
          500,
        );
      return {
        ...versioned(
          {
            ...snapshot.state,
            source: candidate.data,
            metaRevision: sha256(bytes),
            etag: result.etag,
          },
          value,
        ),
        transactionId: result.transactionId,
      };
    } finally {
      await rm(await safePath(this.#root, snapshot.directory), {
        recursive: true,
        force: true,
      });
    }
  }
  async #assertUnreferenced(session: ReadSession, id: string): Promise<void> {
    const sources = await session.loadContent({ mode: 'preview' });
    const prefix = `/media/${id}/`;
    const refs = [
      sources.site.social.defaultImage,
      sources.site.favicon,
      ...siteIconMediaRefs(sources.site),
      ...Object.values(sources.site.pageSEO).map(
        (settings) => settings.ogImage,
      ),
      ...sources.categories.map((item) => item.seo.ogImage),
      ...sources.tags.map((item) => item.seo.ogImage),
      ...(this.#options.fixedPages ?? []).flatMap((page) => [
        ...page.mediaRefs,
        page.seo.ogImage,
      ]),
      ...sources.articles.flatMap((article) => {
        const analysis = analyzeHtml(article.contentHtml, { mode: 'draft' });
        return [
          article.meta.featuredImage,
          article.meta.seo.ogImage,
          ...analysis.mediaReferenceValues,
          ...analysis.links.map((link) => link.href),
        ];
      }),
    ];
    if (
      refs.some((ref) => {
        if (ref === null || ref === undefined) return false;
        try {
          return (
            siteRelativePath(ref, sources.site.siteUrl)?.startsWith(prefix) ??
            false
          );
        } catch {
          return ref.startsWith(prefix);
        }
      })
    )
      throw new MediaError(
        'MEDIA_IN_USE',
        '媒體仍有文章、草稿、設定或固定頁引用。',
        409,
      );
  }
  async remove(
    id: string,
    ifMatch: string | undefined,
    options: MediaTaskOptions = {},
  ): Promise<void> {
    const state = await this.#options.repository.withConsistentRead((session) =>
      this.#sourceState(session, id),
    );
    const keys = sourceKeys(id, state.source.source);
    await this.#withInspectionRetry(
      id,
      (inspected) =>
        this.#options.repository.commit({
          kind: 'delete',
          changes: [
            {
              resourceKey: keys[0],
              expectedRevision: state.sourceRevision,
              content: null,
            },
            {
              resourceKey: keys[1],
              expectedRevision: state.metaRevision,
              content: null,
            },
          ],
          precondition: {
            ifMatch,
            resourceKeys: keys,
            representationEtag: async (session, raw) => {
              const current = await this.#sourceState(session, id);
              const value = await this.#resourceForState(
                current,
                options,
                inspected?.sourceRevision === current.sourceRevision
                  ? inspected.inspection
                  : undefined,
              );
              if (value === null) throw new InspectionRequired();
              return representationEtag(raw, value);
            },
          },
          trash: { kind: 'media', id },
          validate: (session) => this.#assertUnreferenced(session, id),
        }),
      options,
    );
  }
  async process(
    id: string,
    options: MediaTaskOptions & {
      preset?: 'article-image' | 'article-video' | 'site-icons';
      jobId?: string;
    } = {},
  ): Promise<MediaAsset> {
    if (options.jobId !== undefined) {
      const completed = await this.#receipts.read(options.jobId);
      if (completed !== null) {
        if (
          completed.result.sourceId !== id ||
          (options.preset !== undefined && options.preset !== completed.preset)
        )
          throw new MediaError(
            'MEDIA_JOB_RECEIPT_MISMATCH',
            '工作識別已對應其他媒體處理輸入。',
            409,
          );
        return completed.result.asset;
      }
    }
    const snapshot = await this.#snapshot(id, true);
    let releaseCache: (() => Promise<void>) | undefined;
    let releaseSlot: (() => Promise<void>) | undefined;
    let candidate: string | undefined;
    try {
      cancelled(options.signal);
      const state = snapshot.state;
      const kind = state.source.kind;
      const requestedPreset =
        options.preset ??
        (kind === 'image' ? 'article-image' : 'article-video');
      if (
        (kind === 'image' && requestedPreset === 'article-video') ||
        (kind === 'video' && requestedPreset !== 'article-video')
      )
        throw new MediaError(
          'MEDIA_PRESET_MISMATCH',
          '處理preset與來源類型不符。',
        );
      const checked = await this.#inspect(
        snapshot.path,
        extname(state.source.source).slice(1),
        kind,
        state.source.posterTimeSeconds,
        options,
      );
      const presetVersion =
        requestedPreset === 'site-icons'
          ? siteIconsPreset
          : kind === 'image'
            ? presetForImage(checked.inspection.mimeType)
            : videoPreset;
      const processingHash = processingDigest({
        sourceSha256: state.sourceRevision,
        presetVersion,
        posterTimeSeconds:
          kind === 'video'
            ? (state.source.posterTimeSeconds ??
              Math.min(1, (checked.inspection.durationSeconds ?? 0) / 2))
            : null,
        tools: checked.tools,
      });
      const cacheLease = await acquireFileLease({
        root: this.#options.coordinationRoot ?? this.#root,
        name: `media-cache-${processingHash}`,
        owner: 'media-pipeline',
        timeoutMs: this.#options.lockTimeoutMs ?? 10_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (cacheLease === null)
        throw new MediaError('MEDIA_BUSY', '媒體cache正由其他程序使用。', 409);
      releaseCache = () => cacheLease.release();
      const directory = `.alfred/media/${processingHash}`;
      await safeMkdir(this.#root, '.alfred/media');
      let result: WorkerResult | undefined;
      const slot = await acquireMediaSlot(
        this.#options.coordinationRoot ?? this.#root,
        kind,
        this.#options.lockTimeoutMs ?? 10_000,
        options.signal,
      );
      releaseSlot = () => slot.release();
      try {
        const stored = (await readJson(
          this.#root,
          `${directory}/cache.json`,
        )) as WorkerResult;
        project(id, stored, presetVersion);
        if (await this.#outputs(processingHash, stored.outputs)) {
          const verified = await runMediaWorker(
            {
              action: 'verify',
              ...(requestedPreset === 'site-icons' ? { iconSet: true } : {}),
              sourcePath: snapshot.path,
              extension: extname(state.source.source).slice(1),
              kind,
              outputDirectory: await safePath(this.#root, directory),
              timeoutMs: this.#timeout(kind),
              ...(state.source.posterTimeSeconds === undefined
                ? {}
                : { posterTimeSeconds: state.source.posterTimeSeconds }),
            },
            slot.fd,
            options,
          );
          if (processingDigest(verified) === processingDigest(stored))
            result = verified;
        }
      } catch (error) {
        cancelled(options.signal);
        if (
          error instanceof MediaError &&
          [
            'MEDIA_TIMEOUT',
            'MEDIA_TOOL_UNAVAILABLE',
            'MEDIA_PROGRESS_FAILED',
          ].includes(error.code)
        )
          throw error;
      }
      if (result === undefined) {
        candidate = `.alfred/media/${processingHash}-${randomUUID()}.part`;
        await safeMkdir(this.#root, candidate);
        await this.#phase('before-encode', id);
        result = await runMediaWorker(
          {
            action: 'process',
            ...(requestedPreset === 'site-icons' ? { iconSet: true } : {}),
            sourcePath: snapshot.path,
            extension: extname(state.source.source).slice(1),
            kind,
            outputDirectory: await safePath(this.#root, candidate),
            timeoutMs: this.#timeout(kind),
            ...(state.source.posterTimeSeconds === undefined
              ? {}
              : { posterTimeSeconds: state.source.posterTimeSeconds }),
          },
          slot.fd,
          options,
        );
        project(id, result, presetVersion);
        for (const output of result.outputs) {
          const handle = await open(
            await safePath(this.#root, `${candidate}/${output.variant}`),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        await atomicJson(this.#root, `${candidate}/cache.json`, result);
        const destination = await safePath(this.#root, directory);
        try {
          const existing = await lstat(destination);
          if (existing.isSymbolicLink() || !existing.isDirectory())
            throw new MediaError(
              'MEDIA_CACHE_INVALID',
              '媒體cache不是受控目錄。',
              409,
            );
          await rm(destination, { recursive: true });
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await rename(await safePath(this.#root, candidate), destination);
        candidate = undefined;
        await syncDirectory(await safePath(this.#root, '.alfred/media'));
      }
      const asset = MediaAssetSchema.parse({
        ...project(id, result, presetVersion),
        sourceSha256: state.sourceRevision,
      });
      await this.#phase('before-binding', id);
      return await this.#options.repository.withBuildInputLock(
        async (session) => {
          if (options.jobId !== undefined) {
            const previous = await this.#receipts.committedResult(
              options.jobId,
              {
                sourceId: id,
                preset: requestedPreset,
              },
            );
            if (previous !== null) return previous.result.asset;
          }
          const current = await this.#sourceState(session, id);
          if (
            current.sourceRevision !== state.sourceRevision ||
            current.metaRevision !== state.metaRevision
          )
            throw new MediaError(
              'MEDIA_SOURCE_CHANGED',
              '媒體處理期間來源已變更，請建立新工作。',
              412,
            );
          cancelled(options.signal);
          const binding: Binding = {
            schemaVersion: 1,
            sourceRevision: state.sourceRevision,
            metaRevision: state.metaRevision,
            processingHash,
            inspection: checked.inspection,
            asset,
          };
          if (options.jobId === undefined) {
            await this.#saveBinding(binding);
            return asset;
          }
          await this.#receipts.commit(
            options.jobId,
            binding,
            (this.#options.clock?.() ?? new Date()).toISOString(),
          );
          try {
            await this.#phase('receipt-committed', id);
            await this.#saveBinding(binding);
          } catch {
            process.stderr.write(
              `${JSON.stringify({ level: 'warning', code: 'MEDIA_BINDING_PROJECTION_UNAVAILABLE', sourceId: id, jobId: options.jobId })}\n`,
            );
          }
          return asset;
        },
      );
    } finally {
      await releaseSlot?.();
      await releaseCache?.();
      if (candidate !== undefined)
        await rm(await safePath(this.#root, candidate), {
          recursive: true,
          force: true,
        });
      await rm(await safePath(this.#root, snapshot.directory), {
        recursive: true,
        force: true,
      });
    }
  }
  async committedResult(
    jobId: string,
    payload: Pick<MediaJobRequest, 'sourceId' | 'preset'>,
  ) {
    return this.#receipts.committedResult(jobId, payload);
  }
  async manifest(
    ids?: readonly string[],
    session?: ReadSession,
  ): Promise<MediaManifest> {
    let sourceIds = ids;
    if (sourceIds === undefined) {
      try {
        sourceIds = (
          await readdir(await safePath(this.#root, 'media/source'))
        ).filter((id) => UuidSchema.safeParse(id).success);
      } catch (error) {
        if (!isMissing(error)) throw error;
        sourceIds = [];
      }
    }
    const read = async (current: ReadSession) => {
      const assets = await mapConcurrent(sourceIds, async (id) => {
        const state = await this.#sourceState(current, id);
        const binding = await this.#binding(id, state);
        if (
          binding !== null &&
          binding.sourceRevision === state.sourceRevision &&
          binding.metaRevision === state.metaRevision &&
          (await this.#outputs(
            binding.processingHash,
            binding.asset.outputs.map((output) => ({
              variant: output.publicPath.split('/').at(-1) ?? '',
              sha256: output.sha256,
              byteSize: output.byteSize,
            })),
          ))
        )
          return binding.asset;
        return null;
      });
      return {
        schemaVersion: 1 as const,
        assets: assets.filter((asset): asset is MediaAsset => asset !== null),
      };
    };
    return session === undefined
      ? this.#options.repository.withConsistentRead(read)
      : read(session);
  }
  async processReferences(
    refs: readonly string[],
    options: MediaTaskOptions = {},
  ): Promise<MediaManifest> {
    const ids = new Set<string>();
    for (const ref of refs) {
      if (!ManagedMediaPathSchema.safeParse(ref).success)
        throw new MediaError('MEDIA_REFERENCE_INVALID', '公開媒體引用不合法。');
      ids.add(ref.split('/')[2] ?? '');
    }
    const assets: MediaAsset[] = [];
    for (const id of [...ids].sort()) {
      let iconSet = refs.some(
        (ref) =>
          ref.split('/')[2] === id &&
          /\/(?:favicon-(?:16|48)\.png|apple-touch-icon\.png|icon-(?:192|512)\.png|mask-icon\.svg)$/u.test(
            ref,
          ),
      );
      if (!iconSet && refs.includes(`/media/${id}/favicon.ico`))
        iconSet = (await this.get(id)).value.mimeType !== 'image/x-icon';
      assets.push(
        await this.process(id, {
          ...options,
          ...(iconSet ? { preset: 'site-icons' as const } : {}),
        }),
      );
    }
    const available = new Set(
      assets.flatMap((asset) =>
        asset.outputs.map((output) => output.publicPath),
      ),
    );
    if (refs.some((ref) => !available.has(ref)))
      throw new MediaError(
        'MEDIA_VARIANT_MISSING',
        '要求的媒體變體不適用目前來源尺寸。',
      );
    return { schemaVersion: 1, assets };
  }
  async openVariant(id: string, variant: string, range?: string) {
    const binding = await this.#options.repository.withConsistentRead(
      async (session) =>
        this.#verifiedBinding(await this.#sourceState(session, id)),
    );
    if (binding === null)
      throw new MediaError('MEDIA_NOT_FOUND', '媒體尚未完成處理。', 404);
    return openMediaVariant(this.#root, binding, variant, range);
  }
}
