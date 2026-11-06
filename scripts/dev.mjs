import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedProcess } from './managed-process.mjs';
import { acquireFileLease } from '../server/src/runtime/lease.ts';
import { safePath } from '../server/src/files/io.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? 'all';
const container = process.argv[3] === '--container';
const publicHost = container ? '0.0.0.0' : '127.0.0.1';
const withSite = ['all', 'site'].includes(mode);
const withApi = ['all', 'studio', 'server'].includes(mode);
const withStudio = ['all', 'studio'].includes(mode);
const children = new Set();
const watchers = [];
const stopped = new AbortController();
let shutdown;
let restartTimer;
let api;
let restarting;
let pendingRestart = false;
let workspaceLease;
let renderContextCleanup;
const token = randomBytes(32).toString('hex');
const log = (message) => process.stdout.write(message + '\n');
async function stop() {
  shutdown ??= (async () => {
    stopped.abort();
    clearTimeout(restartTimer);
    for (const watcher of watchers) watcher.close();
    await Promise.all([...children].map((child) => child.stop()));
    await restarting;
    await renderContextCleanup?.catch(() => undefined);
    await workspaceLease?.release();
  })().catch(() => {
    process.stderr.write('DEV_STOP_FAILED：部分服務未能正常停止。\n');
    process.exitCode = 1;
  });
  return shutdown;
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
function tracked(command, args, options = {}) {
  if (stopped.signal.aborted) throw new Error('DEV_STOPPING');
  const child = managedProcess(command, args, { cwd: root, ...options });
  children.add(child);
  void child.done.then(() => children.delete(child));
  return child;
}
async function command(name, acceptedCodes = [0]) {
  const child = tracked(
    process.execPath,
    ['--import', 'tsx', 'scripts/dev-task.mjs'],
    {
      ipc: true,
      stopGraceMs: 12_000,
    },
  );
  child.child.send({ task: name }, (error) => {
    if (error && !stopped.signal.aborted) void stop();
  });
  const result = await child.done;
  if (!acceptedCodes.includes(result.code) || stopped.signal.aborted)
    throw new Error('DEV_SETUP_FAILED');
  return result.code;
}
async function freePort(port, host) {
  const probe = createServer();
  await new Promise((resolveReady, reject) => {
    probe.once('error', reject);
    probe.listen(port, host, () => probe.close(resolveReady));
  });
}
async function task(name) {
  const child = tracked(
    process.execPath,
    ['--import', 'tsx', 'scripts/dev-task.mjs'],
    {
      ipc: true,
      stopGraceMs: 12_000,
    },
  );
  let expectedStop = false;
  const ready = new Promise((resolveReady, reject) => {
    child.child.on('message', (message) => {
      if (message?.event === 'ready') resolveReady();
    });
    void child.done.then(() => reject(new Error('DEV_TASK_EXITED')));
  });
  const timer = setTimeout(() => {
    process.stderr.write(`DEV_START_TIMEOUT：${name}啟動逾時。\n`);
    process.exitCode = 1;
    void stop();
  }, 60_000);
  try {
    child.child.send(
      {
        task: name,
        container,
        ...(['api', 'studio'].includes(name) ? { proxyToken: token } : {}),
      },
      (error) => {
        if (error && !stopped.signal.aborted) void stop();
      },
    );
    await ready;
  } finally {
    clearTimeout(timer);
  }
  void child.done.then(() => {
    if (!expectedStop && !stopped.signal.aborted) {
      process.stderr.write(
        `DEV_UNEXPECTED_EXIT：${name}已退出，停止整組服務。\n`,
      );
      process.exitCode = 1;
      void stop();
    }
  });
  return {
    async stop() {
      expectedStop = true;
      await child.stop();
    },
  };
}
async function httpReady(port, path = '/') {
  const deadline = Date.now() + 60_000;
  while (!stopped.signal.aborted && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(1_000)]),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      /* 尚未listen時，繼續等待同一組服務。 */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('DEV_NOT_READY');
}
function restartApi() {
  pendingRestart = true;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (restarting || stopped.signal.aborted) return;
    restarting = (async () => {
      while (pendingRestart && !stopped.signal.aborted) {
        pendingRestart = false;
        await api?.stop();
        if (stopped.signal.aborted) break;
        api = await task('api');
        log('Local Service已載入最新來源與共用套件。');
      }
    })()
      .catch(() => {
        if (!stopped.signal.aborted) {
          process.stderr.write(
            'DEV_RESTART_FAILED：服務重新載入失敗，請修正來源後重啟。\n',
          );
          process.exitCode = 1;
          void stop();
        }
      })
      .finally(() => {
        restarting = undefined;
      });
  }, 350);
}
try {
  if (
    !['all', 'site', 'studio', 'server'].includes(mode) ||
    process.argv.length > (container ? 4 : 3) ||
    (process.argv[3] !== undefined && !container)
  )
    throw new Error('DEV_MODE_INVALID');
  workspaceLease = await acquireFileLease({
    root,
    name: 'dev-session',
    owner: 'dev-supervisor',
    nonBlocking: true,
    signal: stopped.signal,
  });
  if (!workspaceLease) throw new Error('DEV_ALREADY_RUNNING');
  await Promise.all([
    ...(withSite ? [freePort(4321, publicHost)] : []),
    ...(withStudio ? [freePort(5173, publicHost)] : []),
    ...(withApi ? [freePort(3001, '127.0.0.1')] : []),
  ]);
  if (withSite) {
    if (stopped.signal.aborted) throw new Error('DEV_STOPPING');
    // The dev-session lease is held and the Astro port is free: no reader can
    // still be using this previous session's private generations.
    renderContextCleanup = safePath(root, '.alfred/dev/render').then((path) =>
      rm(path, { recursive: true, force: true }),
    );
    await renderContextCleanup;
  }
  await command('bootstrap-packages');
  await command('bootstrap-server');
  await task('types');
  await task('styles');
  const prepared = await command(
    withSite ? 'prepare-site' : 'prepare-authoring',
    withSite ? [0] : [0, 2],
  );
  if (prepared === 2)
    process.stderr.write(
      'DEV_SOURCE_INVALID：管理服務可用；請依工作區診斷修正內容或媒體來源。\n',
    );
  await task('render');
  if (withApi) api = await task('api');
  if (withStudio) await task('studio');
  if (withSite) {
    await task('site');
  }
  if (withApi) {
    for (const resource of [
      'server/src',
      'packages/core/dist',
      'packages/ui/dist',
      'site/dist/registry',
    ])
      watchers.push(
        watch(resolve(root, resource), { recursive: true }, (_event, name) => {
          if (name && /\.(?:ts|tsx|js|json)$/u.test(name)) restartApi();
        }),
      );
  }
  await Promise.all([
    ...(withApi ? [httpReady(3001, '/api/v1/health')] : []),
    ...(withStudio ? [httpReady(5173)] : []),
    ...(withSite ? [httpReady(4321)] : []),
  ]);
  log(
    `開發環境已就緒${withSite ? '；網站 http://localhost:4321' : ''}${withStudio ? '；Studio http://localhost:5173' : ''}${withApi ? '；Local Service只允許配對代理呼叫' : ''}。`,
  );
} catch {
  if (!stopped.signal.aborted) {
    process.stderr.write(
      'DEV_FAILED：啟動失敗，請檢查連接埠、來源驗證與上方編譯診斷。\n',
    );
    process.exitCode = 1;
  }
  await stop();
}
