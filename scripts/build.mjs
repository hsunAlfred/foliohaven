import { fileURLToPath } from 'node:url';
import {
  createLocalRuntime,
  acquireFileLease,
  RepositoryError,
} from '@foliohaven/server';

const root = fileURLToPath(new URL('../', import.meta.url));
let runtime;
let jobId;
let stopRequested = false;
let polling = false;
let pollTask;
let timer;
let lastStage;
let succeeded = false;
const log = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const stop = () => {
  stopRequested = true;
  if (runtime && jobId) void runtime.jobs.cancel(jobId).catch(() => undefined);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  if (process.argv.length !== 2)
    throw new RepositoryError(
      'BUILD_ARGUMENT_INVALID',
      '正式建置不接受任意路徑或命令。',
      400,
    );
  runtime = await createLocalRuntime({ repositoryRoot: root });
  if (stopRequested)
    throw new RepositoryError('BUILD_CANCELLED', '建置已取消。', 409);
  const lease = await acquireFileLease({
    root,
    name: 'build-execution',
    owner: 'build-cli',
    nonBlocking: true,
  });
  if (!lease)
    throw new RepositoryError(
      'BUILD_BUSY',
      '已有正式建置執行中，請完成或取消後再試。',
      409,
    );
  await lease.release();
  const created = await runtime.jobs.create({
    type: 'build',
    payload: {},
    sourceRevision: await runtime.scanInputs(),
  });
  jobId = created.id;
  log({ event: 'build-created', jobId });
  if (stopRequested) await runtime.jobs.cancel(jobId);
  timer = setInterval(() => {
    if (polling) return;
    polling = true;
    pollTask = runtime.jobs
      .get(jobId)
      .then((job) => {
        if (job.stage !== lastStage) {
          lastStage = job.stage;
          log({
            event: 'build-progress',
            jobId,
            stage: job.stage,
            progress: job.progress,
            snapshotRevision: job.snapshotRevision,
          });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, 500);
  timer.unref();
  let result = await runtime.jobs.runJob(jobId);
  if (result === null) {
    result = await runtime.jobs.get(jobId);
    if (result.status === 'queued') {
      await runtime.jobs.cancel(jobId);
      throw new RepositoryError(
        'BUILD_BUSY',
        '建置額度已由另一程序取得；本次排隊工作已取消。',
        409,
      );
    }
    while (result.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const owner = await acquireFileLease({
        root,
        name: `job-${jobId}`,
        owner: 'build-cli',
        nonBlocking: true,
      });
      if (owner) {
        await owner.release();
        await runtime.jobs.initialize();
      }
      result = await runtime.jobs.get(jobId);
    }
  }
  if (
    result.status === 'succeeded' &&
    result.type === 'build' &&
    result.result
  ) {
    succeeded = true;
    log({
      event: 'build-succeeded',
      jobId,
      ...result.result,
      warnings: result.result.warnings.map((warning) => ({
        code: warning.code,
      })),
    });
  } else {
    log({
      event: 'build-ended',
      jobId,
      status: result.status,
      error: result.error,
    });
    process.exitCode = result.status === 'cancelled' ? 130 : 1;
  }
} catch (error) {
  const safe =
    error instanceof RepositoryError
      ? { code: error.code, message: error.message }
      : { code: 'BUILD_FAILED', message: '建置未完成，請檢查來源或復原狀態。' };
  process.stderr.write(
    JSON.stringify({
      event: 'build-failed',
      ...safe,
      ...(jobId ? { jobId } : {}),
    }) + '\n',
  );
  process.exitCode = stopRequested ? 130 : 1;
} finally {
  clearInterval(timer);
  await pollTask;
  let cleanupFailed = false;
  for (const close of [() => runtime?.close()]) {
    try {
      await close();
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    process.stderr.write(
      'BUILD_CLEANUP_FAILED：程序清理未完成；下次啟動將檢查復原狀態。\n',
    );
    if (!succeeded) process.exitCode = 1;
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
