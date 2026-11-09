import { compatibleEnvironment } from './workspace-paths.mjs';
import { renderSnapshot, writeBuildFailureReport } from '@foliohaven/server';

const [jobId, ...extra] = process.argv.slice(2);
if (
  extra.length !== 0 ||
  jobId === undefined ||
  !/^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u.test(
    jobId,
  ) ||
  !/^([a-f0-9]{64})$/u.test(
    compatibleEnvironment('FOLIOHAVEN_SNAPSHOT_REVISION') ?? '',
  )
) {
  process.stderr.write(
    'BUILD_WORKER_ARGUMENT_INVALID：需要單一job UUID及來源revision。\n',
  );
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdin.on('end', stop);
  process.stdin.resume();
  try {
    await renderSnapshot({
      repositoryRoot: process.cwd(),
      jobId,
      snapshotRevision: compatibleEnvironment('FOLIOHAVEN_SNAPSHOT_REVISION'),
      signal: controller.signal,
    });
  } catch (error) {
    let code = 'BUILD_RENDER_FAILED';
    try {
      code = (await writeBuildFailureReport(process.cwd(), error)).code;
    } catch {
      /* 未能保存也維持明確失敗，不輸出任意原始錯誤。 */
    }
    process.stderr.write(
      `${code}：靜態網站建置失敗，來源與既有dist保持不變。\n`,
    );
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    process.stdin.removeListener('end', stop);
    process.stdin.pause();
  }
}
