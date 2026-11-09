import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  BuildResultSchema,
  SafeErrorSchema,
  type BuildJobRequest,
  type BuildResult,
  type SafeError,
} from '@foliohaven/core';
import type { FileRepository } from '../files/index.js';
import {
  privateResource,
  atomicJson,
  readOptional,
  record,
  RepositoryError,
  safeMkdir,
  safePath,
} from '../files/io.js';
import type { JobContext, JobHandler } from '../jobs/types.js';
import { runControlledProcess } from '../runtime/process.js';
import { buildProcessEnvironment } from '../runtime/environment.js';
import { type ArtifactStore, scanArtifactTree } from './artifacts/index.js';
import {
  copyBuildSnapshot,
  scanBuildInputs,
  BuildInputError,
} from './inputs.js';
import { prepareSnapshotDependencies } from './dependencies.js';

interface SnapshotExecution {
  readonly repositoryRoot: string;
  readonly snapshotRoot: string;
  readonly jobId: string;
  readonly snapshotRevision: string;
  readonly signal: AbortSignal;
  readonly leaseFd: number;
}
export interface BuildCoordinatorOptions {
  readonly repositoryRoot: string;
  readonly repository: FileRepository;
  readonly artifacts: ArtifactStore;
  /** 程序內依賴注入供隔離驗收；不接受HTTP／CLI傳入命令或路徑。 */
  readonly execution?: {
    prepare?(options: SnapshotExecution): Promise<void>;
    render?(options: SnapshotExecution): Promise<void>;
  };
  readonly deadlineMs?: number;
  readonly onMaintenanceError?: (jobId: string) => void;
}
function failure(code: string, message: string): BuildInputError {
  return new BuildInputError(code, message);
}
export class BuildWorkerFailure extends RepositoryError {
  readonly issues: SafeError['issues'];
  readonly retryable: boolean;
  constructor(error: SafeError) {
    super(error.code, error.message, 422);
    this.issues = error.issues;
    this.retryable = error.retryable;
  }
}
async function workerFailure(
  snapshotRoot: string,
): Promise<BuildWorkerFailure | null> {
  try {
    const bytes = await readOptional(
      await safePath(
        snapshotRoot,
        privateResource(snapshotRoot, 'build-failure.json'),
      ),
      2 * 1024 * 1024,
    );
    if (bytes === null) return null;
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    if (
      !record(value) ||
      Object.keys(value).sort().join(',') !== 'error,schemaVersion' ||
      value.schemaVersion !== 1
    )
      return null;
    const parsed = SafeErrorSchema.safeParse(value.error);
    if (!parsed.success || parsed.data.issues.length > 500) return null;
    return new BuildWorkerFailure(parsed.data);
  } catch {
    return null;
  }
}
async function report(
  snapshot: string,
  revision: string,
): Promise<BuildResult> {
  const handle = await open(
    await safePath(snapshot, privateResource(snapshot, 'build-result.json')),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 32 * 1024 * 1024)
      throw failure('INVALID_BUILD_REPORT', '建置報告格式或大小不符合契約。');
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length > 32 * 1024 * 1024)
      throw failure('INVALID_BUILD_REPORT', '建置報告在讀取期間改變。');
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      throw failure('INVALID_BUILD_REPORT', '建置報告不是有效的UTF-8 JSON。');
    }
    if (
      !record(value) ||
      Object.keys(value).sort().join(',') !==
        'mediaPending,pendingLinkChecks,result,schemaVersion' ||
      value.schemaVersion !== 1 ||
      value.mediaPending !== false ||
      value.pendingLinkChecks !== 0
    )
      throw failure(
        'BUILD_VALIDATION_INCOMPLETE',
        '建置仍有未完成的媒體或連結檢查。',
      );
    const parsed = BuildResultSchema.safeParse(value.result);
    if (!parsed.success || parsed.data.snapshotRevision !== revision)
      throw failure('INVALID_BUILD_REPORT', '建置結果與本次快照不一致。');
    return parsed.data;
  } finally {
    await handle.close();
  }
}

/** 唯一正式建置協調器；JobManager持有build執行鎖，所有來源均先複製後使用。 */
export class BuildCoordinator implements JobHandler<'build'> {
  readonly #root: string;
  readonly #options: BuildCoordinatorOptions;
  constructor(options: BuildCoordinatorOptions) {
    this.#root = resolve(options.repositoryRoot);
    this.#options = options;
    if (
      options.deadlineMs !== undefined &&
      (!Number.isSafeInteger(options.deadlineMs) ||
        options.deadlineMs <= 0 ||
        options.deadlineMs > 10_800_000)
    )
      throw failure('INVALID_BUILD_OPTIONS', '建置時間限制無效。');
  }
  async validateSource(
    _payload: BuildJobRequest,
    sourceRevision: string | null,
  ): Promise<boolean> {
    if (sourceRevision === null) return false;
    if ((await this.#options.artifacts.recover()).recoveryState !== 'ready')
      return false;
    return this.#options.repository.withBuildInputLock(
      async () =>
        (await scanBuildInputs(this.#root)).revision === sourceRevision,
    );
  }
  async #prepare(options: SnapshotExecution): Promise<void> {
    await prepareSnapshotDependencies(options);
    for (const [command, args] of [
      [process.execPath, ['scripts/check-dependencies.mjs']],
      ['pnpm', ['run', 'build:packages']],
      ['pnpm', ['--filter', '@foliohaven/server', 'build']],
    ] as const)
      await runControlledProcess({
        command,
        args,
        cwd: options.snapshotRoot,
        env: buildProcessEnvironment({ NODE_ENV: 'development' }),
        signal: options.signal,
        timeoutMs: 15 * 60_000,
        passFds: [options.leaseFd],
      });
  }
  async #render(options: SnapshotExecution): Promise<void> {
    try {
      await runControlledProcess({
        command: process.execPath,
        args: ['scripts/build-worker.mjs', options.jobId],
        cwd: options.snapshotRoot,
        env: buildProcessEnvironment({
          FOLIOHAVEN_SNAPSHOT_REVISION: options.snapshotRevision,
        }),
        signal: options.signal,
        timeoutMs: 10_800_000,
        passFds: [options.leaseFd],
        keepStdinOpen: true,
      });
    } catch (error) {
      if (error instanceof RepositoryError && error.code === 'PROCESS_EXITED') {
        const safeFailure = await workerFailure(options.snapshotRoot);
        if (safeFailure) throw safeFailure;
      }
      throw error;
    }
  }
  async run(
    context: JobContext,
    _payload: BuildJobRequest,
  ): Promise<BuildResult> {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        context.jobId,
      )
    )
      throw failure('INVALID_BUILD_OPTIONS', '建置工作識別無效。');
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, this.#options.deadlineMs ?? 10_800_000);
    timer.unref();
    const signal = AbortSignal.any([context.signal, deadline.signal]);
    const checkpoint = () => {
      if (signal.aborted)
        throw failure(
          timedOut ? 'BUILD_TIMEOUT' : 'BUILD_CANCELLED',
          timedOut ? '建置超過整體時間限制。' : '建置已取消。',
        );
    };
    const directory = privateResource(this.#root, `builds/${context.jobId}`);
    const snapshotKey = `${directory}/snapshot`;
    let ownsDirectory = false;
    const progress = async (
      stage: string,
      completed: number,
      snapshotRevision?: string,
    ) => {
      checkpoint();
      await context.progress({
        stage,
        completed,
        total: 6,
        ...(snapshotRevision ? { snapshotRevision } : {}),
      });
    };
    try {
      checkpoint();
      if ((await this.#options.artifacts.recover()).recoveryState !== 'ready')
        throw failure('BUILD_RECOVERY_REQUIRED', '請先完成產物復原。');
      await safeMkdir(this.#root, privateResource(this.#root, 'builds'));
      try {
        await lstat(await safePath(this.#root, directory));
        throw failure(
          'BUILD_JOB_EXISTS',
          '此工作已有私有建置資料，不能重新使用。',
        );
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
      // job執行lease保證同一id不會並行；未知既有目錄一律保留。
      await safeMkdir(this.#root, directory);
      ownsDirectory = true;
      await progress('snapshot-inputs', 0);
      const captured = await this.#options.repository.withBuildInputLock(
        async (session) => {
          const inputs = await scanBuildInputs(this.#root, { signal });
          await copyBuildSnapshot(
            this.#root,
            await safePath(this.#root, snapshotKey),
            inputs,
            { signal },
          );
          await atomicJson(
            this.#root,
            `${directory}/input-manifest.json`,
            inputs,
          );
          return { inputs, generation: session.generation };
        },
      );
      const execution: SnapshotExecution = {
        repositoryRoot: this.#root,
        snapshotRoot: await safePath(this.#root, snapshotKey),
        jobId: context.jobId,
        snapshotRevision: captured.inputs.revision,
        signal,
        leaseFd: context.leaseFd,
      };
      await progress('offline-dependencies', 1, captured.inputs.revision);
      if (this.#options.execution?.prepare)
        await this.#options.execution.prepare(execution);
      else await this.#prepare(execution);
      await progress('rendering', 2, captured.inputs.revision);
      if (this.#options.execution?.render)
        await this.#options.execution.render(execution);
      else await this.#render(execution);
      await progress('verifying', 3, captured.inputs.revision);
      const result = await report(
        execution.snapshotRoot,
        captured.inputs.revision,
      );
      const tree = await scanArtifactTree(
        this.#root,
        `${directory}/output`,
        signal,
      );
      if (
        !tree ||
        tree.fileCount !== result.fileCount ||
        !tree.entries.some(
          (entry) => entry.path === 'index.html' && entry.kind === 'file',
        )
      )
        throw failure('INVALID_BUILD_REPORT', '建置報告與實際產物清單不一致。');
      await progress('preparing-promotion', 4, captured.inputs.revision);
      // ticket持有artifact鎖；之後不再呼叫job progress或重新取得artifact鎖。
      const ticket = await this.#options.artifacts.preparePromotion(
        context.jobId,
        {
          snapshotRevision: result.snapshotRevision,
          routeCount: result.routeCount,
          warnings: result.warnings,
          signal,
        },
      );
      try {
        if (ticket.digest !== tree.digest)
          throw failure('BUILD_OUTPUT_CHANGED', '建置產物在提升前改變。');
        const proof = await this.#options.repository.withBuildInputLock(
          async (session) => {
            checkpoint();
            if (
              session.generation !== captured.generation ||
              (await scanBuildInputs(this.#root, { signal })).revision !==
                captured.inputs.revision
            )
              throw failure(
                'BUILD_INPUT_CHANGED',
                '建置期間來源已變更，請重新建置。',
              );
            checkpoint();
            return ticket.promote();
          },
        );
        return proof.result;
      } finally {
        // 大型保留、復原、prune均在writer lock之外完成。
        await ticket.release();
      }
    } catch (error) {
      // durable artifact commit之後的取消、清理或通知錯誤不能逆轉成功。
      const proof = await this.#options.artifacts.committedProof(context.jobId);
      if (proof) return proof.result;
      checkpoint();
      if (error instanceof RepositoryError) throw error;
      throw failure('BUILD_FAILED', '建置未完成，原有公開產物保持可用。');
    } finally {
      clearTimeout(timer);
      if (ownsDirectory) {
        try {
          await rm(await safePath(this.#root, snapshotKey), {
            recursive: true,
            force: true,
          });
          const retained = await this.#options.artifacts.retainedBuildIds();
          if (!retained.includes(context.jobId)) {
            await this.#options.artifacts.discardUncommitted(context.jobId);
            await rm(await safePath(this.#root, `${directory}/output`), {
              recursive: true,
              force: true,
            });
          }
        } catch {
          if (this.#options.onMaintenanceError)
            this.#options.onMaintenanceError(context.jobId);
          else
            console.error(
              JSON.stringify({
                event: 'build-maintenance-failed',
                jobId: context.jobId,
                code: 'BUILD_CLEANUP_FAILED',
              }),
            );
        }
      }
    }
  }
}
