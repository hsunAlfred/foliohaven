import { privateResource } from './workspace-paths.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { platform, release } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { managedProcess } from './managed-process.mjs';
import { createNativeApplication } from './native-release-process.mjs';

const arguments_ = process.argv.slice(2);
assert.ok(
  arguments_.length === 2 &&
    arguments_[0] === '--source' &&
    isAbsolute(arguments_[1]),
  '請指定 --source 絕對路徑的獨立無 Git 驗收副本。',
);
const source = resolve(arguments_[1]);
assert.equal(platform(), 'linux', '此驗收只接受 Linux 原生環境。');
assert.notEqual(process.getuid?.(), 0, '請使用非 root 帳號驗收。');
assert.ok(!(await lstat(source)).isSymbolicLink(), '驗收來源不可為符號連結。');
await assert.rejects(access(join(source, '.git')), { code: 'ENOENT' });
assert.deepEqual(
  JSON.parse(
    await readFile(
      join(source, privateResource(source, 'release-check-workspace.json')),
      'utf8',
    ),
  ),
  { schemaVersion: 1, purpose: 'release-validation' },
);
const report = join(
  source,
  privateResource(source, 'reports/release-native-check'),
);
await mkdir(report, { recursive: true, mode: 0o700 });
const environment = Object.fromEntries(
  [
    'PATH',
    'HOME',
    'PNPM_HOME',
    'PLAYWRIGHT_BROWSERS_PATH',
    'LANG',
    'TZ',
  ].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]],
  ),
);
const proof = {
  scope: 'linux-native-without-git',
  status: 'running',
  startedAt: new Date().toISOString(),
  node: process.versions.node,
  platform: platform(),
  osRelease: release(),
  uid: process.getuid(),
  phases: [],
  applications: [],
};
const packageJson = JSON.parse(
  await readFile(join(source, 'package.json'), 'utf8'),
);
assert.equal(
  packageJson.scripts?.start,
  'node scripts/start.mjs',
  'NATIVE_START_ENTRYPOINT_MISMATCH',
);
const footer = join(source, 'packages/ui/src/components/SiteFooter.tsx');
const originalFooter = await readFile(footer, 'utf8');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalFooterHash = hash(originalFooter);
let application;
let runningCommand;
let stopping = false;
let completed = false;
const cancellation = new AbortController();
const stop = () => {
  stopping = true;
  cancellation.abort();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
async function save() {
  await writeFile(
    join(report, 'result.json'),
    JSON.stringify(proof, null, 2) + '\n',
    { mode: 0o600 },
  );
}
function progress(phase) {
  console.log(JSON.stringify({ event: 'native-release-check', phase }));
}
async function read(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000),
    redirect: 'manual',
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error('NATIVE_SERVICE_NOT_READY');
  }
  return response.text();
}
async function waitFor(check, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.ok(!stopping, 'NATIVE_CHECK_CANCELLED');
    if (application && application.exited)
      throw new Error('NATIVE_SERVICE_EXITED');
    try {
      if (await check()) return;
    } catch (error) {
      if (error.message === 'NATIVE_SERVICE_EXITED') throw error;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('NATIVE_CHECK_TIMEOUT');
}
async function start() {
  progress('start');
  application = await createNativeApplication({
    source,
    environment,
    signal: cancellation.signal,
    onOutput(stream, bytes) {
      (stream === 'stdout' ? process.stdout : process.stderr).write(bytes);
    },
  });
  proof.applications.push(application.evidence);
  await save();
  await application.ready();
}
async function finishApplication() {
  if (!application) return;
  const current = application;
  try {
    await current.stop();
  } finally {
    application = undefined;
  }
}
async function authorCheck(mode) {
  assert.ok(!stopping, 'NATIVE_CHECK_CANCELLED');
  progress(mode);
  runningCommand = managedProcess(
    process.execPath,
    ['tests/release/docker-check.mjs', mode],
    {
      cwd: source,
      env: { ...environment, FOLIOHAVEN_ACCEPTANCE_PLATFORM: 'native' },
      stopGraceMs: 10_000,
    },
  );
  const cancel = () => {
    void runningCommand?.stop().catch(() => undefined);
  };
  cancellation.signal.addEventListener('abort', cancel, { once: true });
  if (cancellation.signal.aborted) cancel();
  const timer = setTimeout(
    () => void runningCommand?.stop().catch(() => undefined),
    16 * 60_000,
  );
  try {
    assert.equal(
      (await runningCommand.done).code,
      0,
      'NATIVE_AUTHOR_WORKFLOW_FAILED',
    );
    assert.ok(!stopping, 'NATIVE_CHECK_CANCELLED');
  } finally {
    cancellation.signal.removeEventListener('abort', cancel);
    clearTimeout(timer);
    await runningCommand.stop();
    runningCommand = undefined;
  }
}
try {
  await save();
  await start();
  proof.phases.push('three-services-and-health');
  await authorCheck('prepare');
  proof.phases.push('studio-article-media-and-build');
  assert.ok(
    originalFooter.includes('</footer>'),
    'NATIVE_FOOTER_ENTRY_MISSING',
  );
  const marker = 'FOLIOHAVEN_NATIVE_' + randomUUID();
  try {
    await writeFile(
      footer,
      originalFooter.replace(
        '</footer>',
        `<span data-native-check>${marker}</span></footer>`,
      ),
    );
    await waitFor(async () =>
      (await read('http://127.0.0.1:4321/')).includes(marker),
    );
  } finally {
    await writeFile(footer, originalFooter);
  }
  await waitFor(
    async () => !(await read('http://127.0.0.1:4321/')).includes(marker),
  );
  assert.equal(hash(await readFile(footer)), originalFooterHash);
  proof.phases.push('editable-source-watch-and-restore');
  await finishApplication();
  await start();
  await authorCheck('verify');
  proof.phases.push('restart-source-media-and-artifact-preserved');
  completed = true;
} catch (error) {
  proof.status = 'failed';
  proof.error = error.code ?? 'NATIVE_ACCEPTANCE_FAILED';
  process.exitCode = 1;
  console.error(
    'NATIVE_ACCEPTANCE_FAILED：原生無 Git 副本驗收失敗，請保留報告與副本查明。',
  );
} finally {
  try {
    await finishApplication();
  } catch (error) {
    proof.status = 'failed';
    proof.cleanupError = error.code ?? 'NATIVE_STOP_FAILED';
    process.exitCode = 1;
  }
  if (stopping) {
    proof.status = 'failed';
    proof.error = 'NATIVE_CHECK_CANCELLED';
    process.exitCode = 1;
  } else if (completed && proof.status !== 'failed') proof.status = 'passed';
  proof.finishedAt = new Date().toISOString();
  await save();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
