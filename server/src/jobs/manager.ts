import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import {
  BuildJobRequestSchema,
  BuildResultSchema,
  filterJobs,
  JobSchema,
  JobRetryInputSchema,
  MediaJobRequestSchema,
  MediaResultSchema,
  SafeErrorSchema,
  TaxonomyMigrationRequestSchema,
  TaxonomyResultSchema,
  UuidSchema,
} from '@foliohaven/core';
import type { Job, JobRetryInput, SafeError } from '@foliohaven/core';
import type { OperationReceipt } from '../files/types.js';
import {
  atomicJson,
  isMissing,
  readJson,
  record,
  RepositoryError,
  safeMkdir,
  safePath,
} from '../files/io.js';
import { acquireFileLease } from '../runtime/lease.js';
import type { FileLease } from '../runtime/lease.js';
import { jsonValue, safeFailure } from '../operations/value.js';
import type {
  CreateJob,
  JobContext,
  JobHandler,
  JobList,
  JobManagerOptions,
  JobPayloadMap,
  JobRecord,
  JobResultMap,
  JobType,
  JobsQuery,
} from './types.js';

interface ErasedHandler {
  validateSource(payload: unknown, revision: string | null): Promise<boolean>;
  run(context: JobContext, payload: unknown): Promise<unknown>;
  committedResult?(
    jobId: string,
    payload: unknown,
  ): Promise<{ readonly result: unknown; readonly committedAt: string } | null>;
}
type JobRow = Pick<Job, 'id' | 'type' | 'status' | 'createdAt'> & {
  readonly operationId: string | null;
};
const active = (job: Pick<Job, 'status'>) =>
  job.status === 'queued' || job.status === 'running';
const revision = (value: unknown) =>
  value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
export class JobError extends RepositoryError {
  constructor(
    code: string,
    message: string,
    status = 409,
    readonly retryAfter?: number,
  ) {
    super(code, message, status);
    this.name = 'JobError';
  }
}
function payloadFor<T extends JobType>(
  type: T,
  payload: unknown,
): JobPayloadMap[T] {
  jsonValue(payload);
  const schema =
    type === 'build'
      ? BuildJobRequestSchema
      : type === 'media'
        ? MediaJobRequestSchema
        : TaxonomyMigrationRequestSchema;
  const parsed = schema.safeParse(payload);
  if (
    !parsed.success ||
    (type === 'taxonomy' &&
      'confirmed' in parsed.data &&
      parsed.data.confirmed !== true)
  )
    throw new JobError('INVALID_JOB_PAYLOAD', '工作輸入不符合指定種類。', 422);
  return parsed.data as JobPayloadMap[T];
}
function resultFor<T extends JobType>(
  type: T,
  result: unknown,
): JobResultMap[T] {
  jsonValue(result);
  const schema =
    type === 'build'
      ? BuildResultSchema
      : type === 'media'
        ? MediaResultSchema
        : TaxonomyResultSchema;
  const parsed = schema.safeParse(result);
  if (!parsed.success)
    throw new JobError('INVALID_JOB_RESULT', '工作輸出不符合指定種類。', 500);
  return parsed.data as JobResultMap[T];
}
function parseRecord(value: unknown): JobRecord {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !revision(value.sourceRevision) ||
    typeof value.cancelRequested !== 'boolean'
  )
    throw new JobError(
      'JOB_RECOVERY_REQUIRED',
      '工作紀錄無法判讀，請保留私有資料。',
    );
  const parsed = JobSchema.safeParse(value.job);
  if (!parsed.success)
    throw new JobError('JOB_RECOVERY_REQUIRED', '工作狀態不符合共用契約。');
  payloadFor(parsed.data.type, value.payload);
  if (
    value.operation !== undefined &&
    (!record(value.operation) ||
      !UuidSchema.safeParse(value.operation.id).success ||
      !UuidSchema.safeParse(value.operation.key).success ||
      !revision(value.operation.payloadHash) ||
      value.operation.payloadHash === null)
  )
    throw new JobError('JOB_RECOVERY_REQUIRED', '工作關聯操作證據無法判讀。');
  return { ...value, job: parsed.data } as unknown as JobRecord;
}
function successfulProgress(job: Job): Job {
  const { total } = job.progress;
  if (
    job.status !== 'succeeded' ||
    total === null ||
    job.progress.completed === total
  )
    return job;
  return { ...job, progress: { completed: total, total } };
}
export class JobManager {
  readonly #options: JobManagerOptions;
  readonly #root: string;
  readonly #handlers = new Map<JobType, ErasedHandler>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #tasks = new Set<Promise<unknown>>();
  #loops: Promise<void>[] = [];
  #closing = false;
  #idleDelayMs: number;
  #wakeEpoch = 0;
  #idleWait: { promise: Promise<void>; wake: () => void } | undefined;
  #backgroundError: SafeError | null = null;
  get backgroundError(): SafeError | null {
    return this.#backgroundError;
  }
  constructor(options: JobManagerOptions) {
    this.#options = options;
    this.#root = options.repositoryRoot;
    this.#idleDelayMs = options.pollIntervalMs ?? 250;
    options.operations?.addReceiptSource(() => this.receipts());
    if (
      options.pollIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.pollIntervalMs) ||
        options.pollIntervalMs < 10 ||
        options.pollIntervalMs > 5_000)
    )
      throw new JobError('INVALID_POLL_INTERVAL', '工作輪詢間隔無效。', 500);
  }
  #now(): string {
    return (this.#options.clock?.() ?? new Date()).toISOString();
  }
  #id(id: string): string {
    if (!UuidSchema.safeParse(id).success)
      throw new JobError('JOB_NOT_FOUND', '工作不存在。', 404);
    return id;
  }
  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    const lease = await acquireFileLease({
      root: this.#root,
      name: 'jobs-state',
      owner: 'job-manager',
    });
    if (!lease) throw new JobError('JOB_BUSY', '工作紀錄正由其他程序使用。');
    try {
      await safeMkdir(this.#root, '.alfred/jobs');
      return await fn();
    } finally {
      await lease.release();
    }
  }
  async #names(): Promise<string[]> {
    return (await readdir(await safePath(this.#root, '.alfred/jobs')))
      .filter((name) => !name.endsWith('.tmp'))
      .map((name) => {
        if (
          !name.endsWith('.json') ||
          !UuidSchema.safeParse(name.slice(0, -5)).success
        )
          throw new JobError('JOB_RECOVERY_REQUIRED', '工作目錄包含無效項目。');
        return name.slice(0, -5);
      });
  }
  async #read(id: string): Promise<JobRecord> {
    let raw: unknown;
    try {
      raw = await readJson(this.#root, `.alfred/jobs/${this.#id(id)}.json`);
    } catch (error) {
      if (isMissing(error))
        throw new JobError('JOB_NOT_FOUND', '工作不存在。', 404);
      throw error;
    }
    const value = parseRecord(raw);
    if (value.job.id !== id)
      throw new JobError('JOB_RECOVERY_REQUIRED', '工作識別與紀錄不符。');
    // Older successful records may retain their last running progress. Project
    // completion for readers without rewriting the historical record or receipt.
    return { ...value, job: successfulProgress(value.job) };
  }
  async #save(value: JobRecord): Promise<void> {
    parseRecord(value);
    await atomicJson(this.#root, `.alfred/jobs/${value.job.id}.json`, {
      ...value,
      job: successfulProgress(value.job),
    });
  }
  async #rows(): Promise<JobRow[]> {
    const records: JobRow[] = [];
    for (const id of await this.#names()) {
      const value = await this.#read(id);
      const { type, status, createdAt } = value.job;
      records.push({
        id,
        type,
        status,
        createdAt,
        operationId: value.operation?.id ?? null,
      });
    }
    return records.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }
  async #proof(id: string) {
    const proof = await this.#options.artifacts?.committedProof(id);
    if (
      proof &&
      (proof.artifactCommitted !== true ||
        proof.jobId !== id ||
        proof.digest !== proof.manifest.digest ||
        proof.result.fileCount !== proof.manifest.fileCount ||
        !Number.isFinite(Date.parse(proof.committedAt)))
    )
      throw new JobError(
        'ARTIFACT_PROOF_INVALID',
        '建置提交證據不完整，請先復原產物。',
      );
    return proof;
  }
  #terminal(
    record: JobRecord,
    status: 'failed' | 'cancelled' | 'interrupted',
    error: SafeError | null,
  ): JobRecord {
    return {
      ...record,
      job: JobSchema.parse({
        ...record.job,
        status,
        stage: status,
        finishedAt: this.#now(),
        result: null,
        error,
      }),
    };
  }
  async #completion(value: JobRecord): Promise<{
    readonly result: unknown;
    readonly committedAt: string;
  } | null> {
    let proof:
      | { readonly result: unknown; readonly committedAt: string }
      | null
      | undefined;
    if (value.job.type === 'build') proof = await this.#proof(value.job.id);
    else {
      proof = await this.#handlers
        .get(value.job.type)
        ?.committedResult?.(value.job.id, value.payload);
      if (!proof && value.job.type === 'taxonomy' && this.#options.repository)
        proof =
          (await this.#options.repository.listCommittedJobResults()).find(
            (item) => item.id === value.job.id,
          ) ?? null;
    }
    if (!proof) return null;
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        proof.committedAt,
      ) ||
      !Number.isFinite(Date.parse(proof.committedAt))
    )
      throw new JobError('JOB_PROOF_INVALID', '工作提交時間證據無效。');
    const result = resultFor(value.job.type, proof.result);
    if (value.job.type === 'taxonomy') {
      const expected = payloadFor('taxonomy', value.payload);
      const actual = resultFor('taxonomy', result);
      if (
        expected.kind !== actual.kind ||
        expected.from !== actual.from ||
        expected.to !== actual.to
      )
        throw new JobError(
          'JOB_PROOF_INVALID',
          '分類工作提交證據與原始輸入不符。',
        );
    }
    if (
      value.job.type === 'media' &&
      payloadFor('media', value.payload).sourceId !==
        resultFor('media', result).sourceId
    )
      throw new JobError('JOB_PROOF_INVALID', '媒體工作提交證據與來源不符。');
    return { result, committedAt: proof.committedAt };
  }
  register<T extends JobType>(type: T, handler: JobHandler<T>): void {
    if (this.#handlers.has(type))
      throw new JobError(
        'HANDLER_ALREADY_REGISTERED',
        '此工作種類已註冊處理器。',
        500,
      );
    this.#handlers.set(type, {
      validateSource: (payload, sourceRevision) =>
        handler.validateSource(payloadFor(type, payload), sourceRevision),
      run: (context, payload) =>
        handler.run(context, payloadFor(type, payload)),
      ...(handler.committedResult
        ? {
            committedResult: (jobId: string, payload: unknown) =>
              handler.committedResult
                ? handler.committedResult(jobId, payloadFor(type, payload))
                : Promise.resolve(null),
          }
        : {}),
    });
  }
  async initialize(): Promise<void> {
    await this.#options.repository?.initialize();
    await this.#options.artifacts?.recover();
    const leases: FileLease[] = [];
    try {
      await this.#locked(async () => {
        for (const row of await this.#rows()) {
          if (!active(row)) continue;
          const value = await this.#read(row.id);
          if (
            value.job.status === 'queued' &&
            this.#handlers.has(value.job.type)
          ) {
            try {
              if (
                !(await this.#handlers
                  .get(value.job.type)
                  ?.validateSource(value.payload, value.sourceRevision))
              )
                await this.#save(
                  this.#terminal(value, 'failed', {
                    code: 'JOB_SOURCE_CHANGED',
                    message: '排程來源版本已更新，請重新建立工作。',
                    retryable: false,
                    issues: [],
                  }),
                );
            } catch (error) {
              await this.#save(
                this.#terminal(value, 'failed', safeFailure(error)),
              );
            }
            continue;
          }
          if (value.job.status !== 'running') continue;
          const lease = await acquireFileLease({
            root: this.#root,
            name: `job-${value.job.id}`,
            owner: 'job-manager',
            nonBlocking: true,
          });
          if (!lease) continue;
          leases.push(lease);
          const proof = await this.#completion(value);
          if (proof) {
            const result = resultFor(value.job.type, proof.result);
            await this.#save({
              ...value,
              job: JobSchema.parse({
                ...value.job,
                status: 'succeeded',
                stage: 'completed',
                finishedAt: proof.committedAt,
                ...(value.job.type === 'build'
                  ? {
                      snapshotRevision: resultFor('build', result)
                        .snapshotRevision,
                    }
                  : {}),
                result,
                error: null,
              }),
            });
          } else
            await this.#save(
              this.#terminal(value, 'interrupted', {
                code: 'JOB_INTERRUPTED',
                message: '工作程序中斷且沒有成功提交證據，請重新建立工作。',
                retryable: false,
                issues: [],
              }),
            );
        }
      });
    } finally {
      await Promise.all(leases.map((lease) => lease.release()));
    }
    if (this.#options.operations)
      await this.#options.operations.initialize(await this.receipts());
  }
  async create<T extends JobType>(input: CreateJob<T>): Promise<Job> {
    if (this.#closing)
      throw new JobError(
        'JOB_MANAGER_STOPPED',
        '工作服務已停止，請重新啟動。',
        503,
      );
    const payload = payloadFor(input.type, input.payload);
    if (!revision(input.sourceRevision))
      throw new JobError('INVALID_SOURCE_REVISION', '工作來源版本無效。', 422);
    if (input.operation) {
      if (!this.#options.operations)
        throw new JobError(
          'OPERATIONS_UNAVAILABLE',
          '工作需要可用的操作紀錄服務。',
          503,
        );
      await this.#options.operations.assertReserved(input.operation);
    }
    const value = await this.#locked(async () => {
      const records = await this.#rows();
      if (
        input.operation &&
        records.some((value) => value.operationId === input.operation?.id)
      )
        throw new JobError(
          'JOB_OPERATION_EXISTS',
          '此操作已建立工作，請查詢原始操作結果。',
        );
      if (records.filter(active).length >= 20)
        throw new JobError(
          'JOB_QUEUE_FULL',
          '待辦與執行中工作已達20筆，請稍後再試。',
          429,
          1,
        );
      if (payload.retryOf !== undefined) {
        const previous = records.find((item) => item.id === payload.retryOf);
        if (
          !previous ||
          previous.type !== input.type ||
          !['failed', 'cancelled', 'interrupted'].includes(previous.status)
        )
          throw new JobError(
            'INVALID_RETRY_JOB',
            '只能重試同種類已失敗、取消或中斷的工作。',
            422,
          );
      }
      const id = randomUUID();
      const job = JobSchema.parse({
        id,
        type: input.type,
        status: 'queued',
        stage: 'queued',
        progress: { completed: 0, total: null },
        createdAt: this.#now(),
        startedAt: null,
        finishedAt: null,
        snapshotRevision: null,
        result: null,
        error: null,
      });
      let operation: OperationReceipt | undefined;
      if (input.operation) {
        if (!this.#options.operations)
          throw new JobError(
            'OPERATIONS_UNAVAILABLE',
            '工作需要可用的操作紀錄服務。',
            503,
          );
        operation = this.#options.operations.receipt(input.operation, {
          httpStatus: 202,
          response: jsonValue(job),
          headers: { Location: `/api/v1/jobs/${id}` },
          jobUrl: `/api/v1/jobs/${id}`,
        });
      }
      const saved: JobRecord = {
        schemaVersion: 1,
        job,
        payload: jsonValue(payload),
        sourceRevision: input.sourceRevision,
        cancelRequested: false,
        ...(operation ? { operation } : {}),
      };
      await this.#save(saved);
      await this.#options.fault?.('created', id);
      return saved;
    });
    this.#wakeIdle();
    if (input.operation && value.operation)
      await this.#options.operations?.complete(input.operation, {
        httpStatus: value.operation.httpStatus,
        response: jsonValue(value.job),
        headers: { Location: `/api/v1/jobs/${value.job.id}` },
        jobUrl: `/api/v1/jobs/${value.job.id}`,
      });
    return value.job;
  }
  async get(id: string): Promise<Job> {
    return this.#locked(async () => (await this.#read(id)).job);
  }
  async retryInput(id: string): Promise<JobRetryInput> {
    return this.#locked(async () => {
      const value = await this.#read(id);
      if (!['failed', 'cancelled', 'interrupted'].includes(value.job.status))
        throw new JobError(
          'JOB_NOT_RETRYABLE',
          '只有已失敗、取消或中斷的工作可以取得重試輸入。',
        );
      if (value.job.type === 'build')
        return JobRetryInputSchema.parse({ type: 'build' });
      if (value.job.type === 'media') {
        const payload = payloadFor('media', value.payload);
        return JobRetryInputSchema.parse({
          type: 'media',
          sourceId: payload.sourceId,
          preset: payload.preset,
        });
      }
      const payload = payloadFor('taxonomy', value.payload);
      return JobRetryInputSchema.parse({
        type: 'taxonomy',
        kind: payload.kind,
        from: payload.from,
        to: payload.to,
      });
    });
  }
  async list(query: Partial<JobsQuery> = {}): Promise<JobList> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      throw new JobError('INVALID_JOB_QUERY', '工作分頁參數無效。', 422);
    return this.#locked(async () => {
      const all = filterJobs(await this.#rows(), {
        page,
        pageSize,
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
      });
      return {
        items: await Promise.all(
          all.items.map(async (row) => (await this.#read(row.id)).job),
        ),
        total: all.total,
        page,
        pageSize,
      };
    });
  }
  async receipts(): Promise<readonly OperationReceipt[]> {
    return this.#locked(async () => {
      const receipts: OperationReceipt[] = [];
      for (const id of await this.#names()) {
        const operation = (await this.#read(id)).operation;
        if (
          operation &&
          (operation.expiresAt === undefined ||
            Date.parse(operation.expiresAt) > Date.parse(this.#now()))
        )
          receipts.push(operation);
      }
      return receipts;
    });
  }
  async cancel(
    id: string,
  ): Promise<{ readonly job: Job; readonly httpStatus: 200 | 202 }> {
    this.#id(id);
    await this.get(id);
    const result = await this.#locked(async () => {
      const value = await this.#read(id);
      if (value.job.status === 'succeeded')
        throw new JobError('JOB_ALREADY_COMMITTED', '工作已成功，不能取消。');
      if (value.job.status === 'cancelled')
        return { job: value.job, httpStatus: 200 as const };
      if (!active(value.job))
        throw new JobError('JOB_NOT_CANCELLABLE', '工作已結束，不能取消。');
      const requested = { ...value, cancelRequested: true };
      const saved =
        value.job.status === 'queued'
          ? this.#terminal(requested, 'cancelled', null)
          : requested;
      await this.#save(saved);
      this.#controllers
        .get(id)
        ?.abort(new JobError('JOB_CANCELLED', '工作已要求取消。'));
      return { job: saved.job, httpStatus: 202 as const };
    });
    if (await this.#completion(await this.#locked(() => this.#read(id))))
      throw new JobError('JOB_ALREADY_COMMITTED', '工作產物已提交，不能取消。');
    return result;
  }
  async #claim(onlyId?: string): Promise<{
    record: JobRecord;
    lease: FileLease;
    execution?: FileLease;
    handler: ErasedHandler;
  } | null> {
    return this.#locked(async () => {
      const rows =
        onlyId === undefined
          ? await this.#rows()
          : [(await this.#read(onlyId)).job];
      let buildBusy = false;
      for (const row of rows) {
        const handler = this.#handlers.get(row.type);
        if (
          row.status !== 'queued' ||
          !handler ||
          (row.type === 'build' && buildBusy)
        )
          continue;
        const value = await this.#read(row.id);
        const lease = await acquireFileLease({
          root: this.#root,
          name: `job-${value.job.id}`,
          owner: 'job-manager',
          nonBlocking: true,
        });
        if (!lease) continue;
        let execution: FileLease | null | undefined;
        try {
          if (value.job.type === 'build') {
            execution = await acquireFileLease({
              root: this.#root,
              name: 'build-execution',
              owner: 'job-manager',
              nonBlocking: true,
            });
            if (!execution) {
              buildBusy = true;
              await lease.release();
              continue;
            }
          }
          const started: JobRecord = {
            ...value,
            job: JobSchema.parse({
              ...value.job,
              status: 'running',
              stage: 'starting',
              startedAt: this.#now(),
            }),
          };
          await this.#save(started);
          await this.#options.fault?.('claimed', value.job.id);
          return {
            record: started,
            lease,
            ...(execution ? { execution } : {}),
            handler,
          };
        } catch (error) {
          await execution?.release();
          await lease.release();
          throw error;
        }
      }
      return null;
    });
  }
  async #run(onlyId?: string): Promise<Job | null> {
    if (this.#closing) return null;
    const claimed = await this.#claim(onlyId);
    if (!claimed) return null;
    const { record: value, lease, execution, handler } = claimed;
    const id = value.job.id;
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    let polling = false;
    let pollTask: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      pollTask = this.#locked(async () => {
        const latest = await this.#read(id);
        if (latest.cancelRequested)
          controller.abort(new JobError('JOB_CANCELLED', '工作已要求取消。'));
      })
        .catch(() =>
          controller.abort(
            new JobError('JOB_STATE_UNAVAILABLE', '工作狀態無法讀取。', 503),
          ),
        )
        .finally(() => {
          polling = false;
        });
    }, this.#options.pollIntervalMs ?? 250);
    timer.unref();
    const context: JobContext = {
      jobId: id,
      signal: controller.signal,
      leaseFd: (execution ?? lease).fd,
      progress: async (progress) => {
        if (
          !/^[a-z][a-z0-9-]{0,119}$/.test(progress.stage) ||
          !Number.isSafeInteger(progress.completed) ||
          progress.completed < 0 ||
          (progress.total !== null &&
            (!Number.isSafeInteger(progress.total) ||
              progress.total < progress.completed)) ||
          (progress.snapshotRevision !== undefined &&
            !revision(progress.snapshotRevision))
        )
          throw new JobError('INVALID_JOB_PROGRESS', '工作進度格式無效。', 500);
        await this.#locked(async () => {
          const current = await this.#read(id);
          if (current.job.status !== 'running') return;
          await this.#save({
            ...current,
            job: JobSchema.parse({
              ...current.job,
              stage: progress.stage,
              progress: {
                completed: progress.completed,
                total: progress.total,
              },
              ...(progress.snapshotRevision !== undefined
                ? { snapshotRevision: progress.snapshotRevision }
                : {}),
            }),
          });
        });
      },
    };
    let result: unknown;
    let failure: unknown;
    let failed = false;
    try {
      const beforeRun = await this.#locked(() => this.#read(id));
      if (beforeRun.cancelRequested || this.#closing)
        controller.abort(
          new JobError(
            this.#closing ? 'SERVICE_STOPPED' : 'JOB_CANCELLED',
            this.#closing ? '服務已停止。' : '工作已要求取消。',
          ),
        );
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!(await handler.validateSource(value.payload, value.sourceRevision)))
        throw new JobError(
          'JOB_SOURCE_CHANGED',
          '排程來源版本已更新，請重新建立工作。',
          412,
        );
      if (controller.signal.aborted) throw controller.signal.reason;
      result = await handler.run(context, value.payload);
      resultFor(value.job.type, result);
    } catch (error) {
      failure = error;
      failed = true;
    } finally {
      clearInterval(timer);
      await pollTask;
    }
    try {
      const proof = await this.#completion(value);
      const saved = await this.#locked(async () => {
        const latest = await this.#read(id);
        let terminal: JobRecord;
        if (proof) {
          const proven = resultFor(latest.job.type, proof.result);
          const result =
            latest.job.type === 'build'
              ? {
                  ...resultFor('build', proven),
                  warnings: [
                    ...resultFor('build', proven).warnings,
                    ...(failed
                      ? [
                          {
                            severity: 'warning',
                            code: 'POST_COMMIT_WARNING',
                            message:
                              '產物已成功提交，附加通知或收尾未完整完成。',
                          },
                        ]
                      : []),
                  ],
                }
              : proven;
          terminal = {
            ...latest,
            job: JobSchema.parse({
              ...latest.job,
              status: 'succeeded',
              stage: 'completed',
              result,
              finishedAt: proof.committedAt,
              error: null,
              ...(latest.job.type === 'build'
                ? {
                    snapshotRevision: resultFor('build', proven)
                      .snapshotRevision,
                  }
                : {}),
            }),
          };
        } else if (latest.cancelRequested)
          terminal = this.#terminal(latest, 'cancelled', null);
        else if (this.#closing)
          terminal = this.#terminal(latest, 'interrupted', {
            code: 'SERVICE_STOPPED',
            message: '服務已停止，工作已中斷。',
            retryable: false,
            issues: [],
          });
        else if (!failed && latest.job.type === 'build')
          terminal = this.#terminal(latest, 'failed', {
            code: 'BUILD_NOT_COMMITTED',
            message: '建置未提供可驗證的產物提交證據。',
            retryable: false,
            issues: [],
          });
        else if (failed)
          terminal = this.#terminal(
            latest,
            'failed',
            SafeErrorSchema.parse(safeFailure(failure)),
          );
        else
          terminal = {
            ...latest,
            job: JobSchema.parse({
              ...latest.job,
              status: 'succeeded',
              stage: 'completed',
              result: resultFor(latest.job.type, result),
              finishedAt: this.#now(),
              error: null,
            }),
          };
        await this.#save(terminal);
        await this.#options.fault?.('finished', id);
        return successfulProgress(terminal.job);
      });
      return saved;
    } finally {
      this.#controllers.delete(id);
      await execution?.release();
      await lease.release();
    }
  }
  async runNext(): Promise<Job | null> {
    const task = this.#run();
    this.#tasks.add(task);
    try {
      return await task;
    } finally {
      this.#tasks.delete(task);
    }
  }
  /** CLI僅執行自己建立的job；絕不順手執行其他歷史排程。 */
  async runJob(id: string): Promise<Job | null> {
    const current = await this.get(id);
    if (!active(current)) return current;
    const task = this.#run(id);
    this.#tasks.add(task);
    try {
      const result = await task;
      if (result) return result;
      const latest = await this.get(id);
      return active(latest) ? null : latest;
    } finally {
      this.#tasks.delete(task);
    }
  }
  #wakeIdle(): void {
    this.#wakeEpoch++;
    this.#idleDelayMs = this.#options.pollIntervalMs ?? 250;
    this.#idleWait?.wake();
  }
  #waitIdle(epoch: number): Promise<void> {
    if (this.#closing || epoch !== this.#wakeEpoch) return Promise.resolve();
    if (this.#idleWait) return this.#idleWait.promise;
    let wake: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      const finish = () => {
        this.#idleWait = undefined;
        resolve();
      };
      const timer = setTimeout(finish, this.#idleDelayMs);
      wake = () => {
        clearTimeout(timer);
        finish();
      };
    });
    this.#idleWait = { promise, wake };
    this.#idleDelayMs = Math.min(5_000, this.#idleDelayMs * 2);
    return promise;
  }
  start(): void {
    if (this.#loops.length || this.#closing) return;
    this.#loops = Array.from({ length: 4 }, async () => {
      while (!this.#closing) {
        const epoch = this.#wakeEpoch;
        try {
          if (await this.runNext()) {
            this.#idleDelayMs = this.#options.pollIntervalMs ?? 250;
            continue;
          }
        } catch (error) {
          this.#backgroundError = safeFailure(error);
          try {
            this.#options.onError?.(this.#backgroundError);
          } catch {
            /* observer不得讓工作狀態變更 */
          }
          if (!(
            error instanceof RepositoryError &&
            ['WORKSPACE_BUSY', 'JOB_BUSY'].includes(error.code)
          )) {
            this.#closing = true;
            this.#wakeIdle();
            for (const controller of this.#controllers.values())
              controller.abort(error);
          }
        }
        await this.#waitIdle(epoch);
      }
    });
  }
  async close(): Promise<void> {
    this.#closing = true;
    this.#wakeIdle();
    for (const controller of this.#controllers.values())
      controller.abort(new JobError('SERVICE_STOPPED', '服務已停止。'));
    await Promise.allSettled([...this.#loops, ...this.#tasks]);
  }
}
