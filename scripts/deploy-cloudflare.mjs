import { fileURLToPath } from 'node:url';
import {
  parseArguments,
  loadConfig,
  loadCredentials,
} from './cloudflare/config.mjs';
import { CloudflareError, safeDiagnostic } from './cloudflare/errors.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const signal = new AbortController();
const stop = () => signal.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let activeDeploymentId;
try {
  const args = process.argv.slice(2);
  if (args.length <= 2 && args.at(-1) === '--help') {
    process.stdout.write(
      'Cloudflare 部署：\npnpm deploy:cloudflare [--dry-run]\npnpm deploy:cloudflare:status --deployment UUID\npnpm deploy:cloudflare:restore --deployment UUID\npnpm verify:cloudflare --deployment UUID --domain https://blog.example.com\n真部署會上傳及更新遠端網站；dry-run 僅檢查本機，不讀取憑證。\n',
    );
  } else {
    const options = parseArguments(args);
    activeDeploymentId = options.deploymentId;
    const config = Object.freeze(await loadConfig(repositoryRoot));
    const workflow = await import('./cloudflare/workflow.mjs');
    await workflow.checkInstalledTools();
    const base = {
      repositoryRoot,
      config,
      signal: signal.signal,
      onProgress: output,
    };
    if (options.command === 'verify') {
      const { report } = await workflow.runDomainVerification({
        ...base,
        deploymentId: options.deploymentId,
        domain: options.domain,
      });
      output({
        event: 'cloudflare-domain-verification',
        scope: 'automatic',
        deploymentId: options.deploymentId,
        status: report.status,
        manualVerification: 'pending',
      });
      if (report.status !== 'passed') process.exitCode = 1;
    } else {
      let needsCredentials = !options.dryRun;
      if (options.command === 'status') {
        const { loadDeployment } = await import('./cloudflare/state.mjs');
        const saved = await loadDeployment(
          repositoryRoot,
          options.deploymentId,
          config,
        );
        needsCredentials =
          saved.manifestDocument !== null &&
          saved.journal.uploadStatus !== 'dry-run';
      }
      const credentials = needsCredentials
        ? await loadCredentials(repositoryRoot)
        : undefined;
      const context =
        options.command === 'deploy'
          ? await workflow.runDeployment({
              ...base,
              credentials,
              dryRun: options.dryRun,
            })
          : await workflow.runRecorded({
              ...base,
              credentials,
              command: options.command,
              deploymentId: options.deploymentId,
            });
      output({
        event: 'cloudflare-result',
        deploymentId: context.deploymentId,
        uploadStatus: context.journal.uploadStatus,
        domainVerification: context.journal.domainVerification,
        message:
          context.journal.uploadStatus === 'uploaded'
            ? '上傳完成；正式網域驗收另行執行。'
            : context.journal.uploadStatus === 'dry-run'
              ? '本機檢查完成，沒有上傳。'
              : context.journal.uploadStatus === 'restored'
                ? '遠端資料與版本已還原；正式網址仍須重新驗證。'
                : '狀態已保存；請依部署紀錄處理未完成項目。',
      });
      if (
        (options.command === 'status' || options.command === 'restore') &&
        ['unknown', 'recovery-required', 'failed', 'running'].includes(
          context.journal.uploadStatus,
        )
      )
        process.exitCode = 1;
    }
  }
} catch (error) {
  const diagnostic = safeDiagnostic(error);
  output({
    event: 'cloudflare-error',
    ...diagnostic,
    ...((error instanceof CloudflareError && error.deploymentId) ||
    activeDeploymentId
      ? { deploymentId: error.deploymentId ?? activeDeploymentId }
      : {}),
  });
  process.exitCode = signal.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
