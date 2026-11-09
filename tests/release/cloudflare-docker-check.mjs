import { privateResource } from '../../scripts/workspace-paths.mjs';
// Host Docker acceptance only: never run against an author's workspace.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  atomicJson,
  digest,
  privateDirectory,
  readOwnerFile,
  safePath,
  uuidPattern,
} from '../../scripts/cloudflare/io.mjs';

const root = process.cwd();
const began = Date.now();
const timeoutMs = 30 * 60_000;
const reportResource = privateResource(
  root,
  'reports/release-docker-check/cloudflare-dry-run.json',
);
const fakeConfig = Object.freeze({
  schemaVersion: 1,
  accountId: '0'.repeat(32),
  workerName: 'fixture-blog',
  bucketName: 'fixture-assets',
});
const configBytes = `${JSON.stringify(fakeConfig, null, 2)}\n`;
const controller = new AbortController();
const stop = () => controller.abort();
let configIdentity;
let reportAllowed = false;
let heartbeat;
let failed = false;
let phase = 'workspace-guard';
let commandResult;
const report = {
  schemaVersion: 1,
  scope: 'docker-local-cli',
  status: 'failed',
  startedAt: new Date().toISOString(),
  completedAt: null,
  command: 'pnpm deploy:cloudflare --dry-run',
  timeoutMs,
  remoteWrites: false,
  credentialsCreated: false,
  fakeConfigCleanup: 'not-created',
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  },
};
function progress(text) {
  console.log(
    `[${new Date().toISOString()}][cloudflare-dry-run][+${Math.floor((Date.now() - began) / 1000)}s] ${text}`,
  );
}
async function absent(resource) {
  try {
    await lstat(resolve(root, resource));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('RELEASE_CLOUDFLARE_WORKSPACE_REQUIRED');
}
function checkFiles(manifest, tree) {
  assert.ok(tree);
  assert.equal(tree.digest, manifest.artifactDigest);
  const actual = tree.entries.filter((entry) => entry.kind === 'file');
  assert.equal(actual.length, manifest.files.length);
  const recorded = new Map(manifest.files.map((file) => [file.path, file]));
  assert.equal(recorded.size, actual.length);
  for (const file of actual) {
    const candidate = recorded.get(file.path);
    assert.ok(candidate);
    assert.equal(candidate.byteSize, file.byteSize);
    assert.equal(candidate.sha256, file.sha256);
    assert.equal(
      candidate.target,
      file.path.startsWith('assets/') || file.path.startsWith('media/')
        ? 'r2'
        : 'worker',
    );
  }
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  assert.equal(process.argv.length, 2);
  assert.equal(process.platform, 'linux');
  assert.notEqual(process.getuid?.(), 0);
  const marker = JSON.parse(
    await readOwnerFile(
      root,
      privateResource(root, 'release-check-workspace.json'),
      4096,
    ),
  );
  assert.deepEqual(marker, { schemaVersion: 1, purpose: 'release-validation' });
  for (const resource of ['.git', 'cloudflare.config.json', '.env.cloudflare'])
    await absent(resource);
  await privateDirectory(
    root,
    privateResource(root, 'reports/release-docker-check'),
  );
  reportAllowed = true;
  progress('隔離副本標記通過；僅使用假的部署目標，不建立憑證、不連線雲端');
  const configPath = await safePath(root, 'cloudflare.config.json');
  const handle = await open(
    configPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    configIdentity = await handle.stat();
    await handle.writeFile(configBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  report.fakeConfigCleanup = 'pending';
  await absent('.env.cloudflare');
  const { runControlledProcess, buildProcessEnvironment, scanArtifactTree } =
    await import('@foliohaven/server');
  phase = 'cli-dry-run';
  progress('執行完整本機部署檢查，最多30分鐘；每30秒回報存活與目前階段');
  let pending = '';
  const receive = (stream, chunk) => {
    if (stream !== 'stdout') return;
    pending += chunk.toString('utf8');
    assert.ok(pending.length <= 1024 * 1024);
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (
        typeof value.phase === 'string' &&
        /^[a-z][a-z0-9-]{0,80}$/.test(value.phase)
      ) {
        phase = value.phase;
        const stage =
          typeof value.stage === 'string' &&
          /^[a-z][a-z0-9-]{0,80}$/.test(value.stage)
            ? `／${value.stage}`
            : '';
        progress(`工具階段：${phase}${stage}`);
      }
      if (value.event === 'cloudflare-result') {
        assert.equal(commandResult, undefined);
        commandResult = value;
      }
      if (
        value.event === 'cloudflare-error' &&
        /^[A-Z][A-Z0-9_]{1,100}$/.test(value.code ?? '')
      ) {
        report.commandErrorCode = value.code;
        progress(`命令回報錯誤：${value.code}`);
      }
    }
  };
  heartbeat = setInterval(
    () => progress(`本機檢查執行中：${phase}；沒有雲端上傳`),
    30_000,
  );
  heartbeat.unref();
  await runControlledProcess({
    command: 'pnpm',
    args: ['run', 'deploy:cloudflare', '--dry-run'],
    cwd: root,
    env: buildProcessEnvironment(),
    signal: controller.signal,
    timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024,
    onOutput: receive,
  });
  assert.equal(commandResult?.uploadStatus, 'dry-run');
  assert.equal(commandResult.domainVerification, 'pending');
  assert.ok(uuidPattern.test(commandResult.deploymentId ?? ''));
  report.deploymentId = commandResult.deploymentId;
  report.commandExitCode = 0;
  phase = 'receipt-validation';
  progress('核對成功收據、固定網站、完整分流及無雲端寫入紀錄');
  const deploymentId = commandResult.deploymentId;
  const deploymentPath = await safePath(
    root,
    privateResource(root, `deployments/${deploymentId}`),
  );
  const receipt = JSON.parse(
    await readOwnerFile(deploymentPath, 'receipt.json', 64 * 1024 * 1024),
  );
  const manifest = JSON.parse(
    await readOwnerFile(deploymentPath, 'manifest.json', 64 * 1024 * 1024),
  );
  assert.equal(receipt.deploymentId, deploymentId);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.uploadStatus, 'dry-run');
  assert.equal(receipt.domainVerification, 'pending');
  assert.deepEqual(receipt.target, { ...fakeConfig, workersPlan: 'free' });
  assert.equal(receipt.r2, null);
  assert.equal(receipt.worker.before, null);
  assert.equal(receipt.worker.after, null);
  assert.equal(receipt.worker.status, 'prepared');
  assert.equal(receipt.worker.stageArtifactInvalid, undefined);
  assert.equal(receipt.uploadProof, undefined);
  assert.equal(receipt.manifestDigest, digest(manifest));
  assert.equal(receipt.artifactDigest, manifest.artifactDigest);
  assert.equal(manifest.filesDigest, digest(manifest.files));
  checkFiles(
    manifest,
    await scanArtifactTree(deploymentPath, 'source', controller.signal),
  );
  const worker = await scanArtifactTree(
    deploymentPath,
    'worker',
    controller.signal,
  );
  assert.deepEqual(worker, receipt.worker.stage.workerManifest);
  const workerFiles = manifest.files.filter((file) => file.target === 'worker');
  const r2Files = manifest.files.filter((file) => file.target === 'r2');
  assert.ok(workerFiles.length > 0);
  assert.ok(r2Files.length > 0);
  assert.equal(worker.fileCount, workerFiles.length);
  for (const resource of ['.git', '.env.cloudflare']) await absent(resource);
  Object.assign(report, {
    status: 'passed',
    deploymentId,
    artifactDigest: manifest.artifactDigest,
    workerFiles: workerFiles.length,
    r2Files: r2Files.length,
    totalFiles: manifest.files.length,
    uploadStatus: 'dry-run',
    domainVerification: 'pending',
  });
  progress('Cloudflare 本機 CLI、收據與分流檢查通過；沒有執行真部署');
} catch {
  failed = true;
  report.status = 'failed';
  report.failedPhase = phase;
  report.errorCode = reportAllowed
    ? 'RELEASE_CLOUDFLARE_DRY_RUN_FAILED'
    : 'RELEASE_CLOUDFLARE_WORKSPACE_REQUIRED';
  console.error(
    `${report.errorCode}：Cloudflare 本機驗收未完成，已停止並保留可用紀錄。`,
  );
} finally {
  if (heartbeat) clearInterval(heartbeat);
  if (configIdentity) {
    try {
      const path = await safePath(root, 'cloudflare.config.json');
      const current = await lstat(path);
      assert.equal(current.dev, configIdentity.dev);
      assert.equal(current.ino, configIdentity.ino);
      assert.equal(
        await readOwnerFile(root, 'cloudflare.config.json', 4096),
        configBytes,
      );
      await rm(path);
      report.fakeConfigCleanup = 'removed-own-file';
    } catch {
      failed = true;
      report.status = 'failed';
      report.fakeConfigCleanup = 'retained-unexpected-file';
      console.error(
        'RELEASE_CLOUDFLARE_CLEANUP_FAILED：未刪除無法確認歸屬的設定，請保留現場檢查。',
      );
    }
  }
  report.completedAt = new Date().toISOString();
  if (reportAllowed) {
    try {
      await atomicJson(root, reportResource, report);
      progress(`驗收報告：${reportResource}`);
    } catch {
      failed = true;
      console.error(
        'RELEASE_CLOUDFLARE_REPORT_FAILED：無法保存報告，請保留獨立驗收副本。',
      );
    }
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
if (failed) process.exitCode = controller.signal.aborted ? 130 : 1;
