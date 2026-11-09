import {
  privateDirectoryName,
  compatibleEnvironment,
} from './workspace-paths.mjs';
import { constants } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { managedProcess } from './managed-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stopped = new AbortController();
const children = new Set();
let lease;
let serviceFailure;
let cleanupFailed = false;
let failureReported = false;
class StartError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function cancelled() {
  if (stopped.signal.aborted)
    throw new StartError('START_CANCELLED', '啟動已停止。');
}
function environment() {
  const result = {
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    NPM_CONFIG_USERCONFIG: '/dev/null',
  };
  for (const name of ['PATH', 'HOME', 'PNPM_HOME', 'PLAYWRIGHT_BROWSERS_PATH'])
    if (process.env[name] !== undefined) result[name] = process.env[name];
  return result;
}
function tracked(command, args, persistent = false) {
  cancelled();
  const child = managedProcess(command, args, {
    cwd: root,
    env: environment(),
    // The dev supervisor gives its own tasks twelve seconds to clean up.
    stopGraceMs: 25_000,
  });
  const stop = () => {
    void child.stop().catch(() => {
      cleanupFailed = true;
    });
  };
  children.add(child);
  stopped.signal.addEventListener('abort', stop, { once: true });
  void child.done.then(() => {
    children.delete(child);
    stopped.signal.removeEventListener('abort', stop);
    if (persistent && !stopped.signal.aborted) {
      serviceFailure = new StartError(
        'START_SERVICE_EXITED',
        '必要服務已退出，整組服務已停止；請依上方診斷修正後再啟動。',
      );
      stopped.abort();
    }
  });
  return child;
}
async function command(program, args, code, message, timeoutMs = 15 * 60_000) {
  const child = tracked(program, args);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void child.stop().catch(() => {
      cleanupFailed = true;
    });
  }, timeoutMs);
  timer.unref();
  let result;
  try {
    result = await child.done;
  } finally {
    clearTimeout(timer);
  }
  cancelled();
  if (timedOut)
    throw new StartError(
      'START_PREPARE_TIMEOUT',
      '啟動準備逾時，請檢查工具與來源後重試。',
    );
  if (result.code !== 0) throw new StartError(code, message);
}
async function directory(resource, required = true) {
  let current = root;
  for (const part of resource.split('/').filter(Boolean)) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new StartError(
          'START_WORKSPACE_INVALID',
          '工作區來源、依賴與產物必須是一般目錄，不可使用符號連結。',
        );
      await access(current, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch (error) {
      if (error?.code === 'ENOENT' && !required) return;
      throw error;
    }
  }
}
async function workspace() {
  if (process.getuid?.() === undefined || process.getuid() === 0)
    throw new StartError(
      'START_ROOT_FORBIDDEN',
      '請使用可讀寫專案的非root帳號啟動。',
    );
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new StartError('START_WORKSPACE_INVALID', '工作區必須是一般目錄。');
  await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
  for (const path of [
    'content',
    'packages/core',
    'packages/ui',
    'site',
    'studio',
    'server',
    'scripts',
  ])
    await directory(path);
  for (const path of [
    privateDirectoryName(root),
    'media/source',
    'dist',
    'node_modules',
    'packages/core/node_modules',
    'packages/ui/node_modules',
    'site/node_modules',
    'studio/node_modules',
    'server/node_modules',
    'packages/core/dist',
    'packages/ui/dist',
    'site/dist',
    'server/dist',
  ])
    await directory(path, false);
  for (const name of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.node-version',
  ]) {
    const file = resolve(root, name);
    const source = await lstat(file);
    if (!source.isFile() || source.isSymbolicLink())
      throw new StartError(
        'START_WORKSPACE_INVALID',
        '工作區必要設定必須是一般檔案。',
      );
    await access(file, constants.R_OK);
  }
  const version = JSON.parse(
    await readFile(resolve(root, 'package.json'), 'utf8'),
  ).version;
  if (
    compatibleEnvironment('FOLIOHAVEN_RELEASE_VERSION') !== undefined &&
    version !== compatibleEnvironment('FOLIOHAVEN_RELEASE_VERSION')
  )
    throw new StartError(
      'START_IMAGE_MISMATCH',
      '工作區版本與Docker image不一致，請重新建置image後再啟動。',
    );
}
async function freePort(port, host) {
  cancelled();
  const server = createServer();
  try {
    await new Promise((resolveReady, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolveReady);
    });
  } catch {
    throw new StartError(
      'START_PORT_IN_USE',
      '啟動需要的連接埠無法使用；請先停止同一工作區的既有服務，或調整主機對應埠。',
    );
  } finally {
    if (server.listening)
      await new Promise((resolveClosed) => server.close(resolveClosed));
  }
}
async function bootstrap() {
  for (const entry of [
    '/opt/foliohaven-bootstrap/server/dist/runtime/lease.js',
    resolve(root, 'server/dist/runtime/lease.js'),
  ]) {
    try {
      await access(entry, constants.R_OK);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.acquireFileLease !== 'function') break;
    return module.acquireFileLease;
  }
  throw new StartError(
    'START_BOOTSTRAP_UNAVAILABLE',
    '缺少啟動工具。Docker使用者請重新建置image；原生環境請先執行pnpm install --frozen-lockfile --prod=false、pnpm run build:packages及pnpm --filter @foliohaven/server build。',
  );
}
async function ready(probes) {
  const pending = new Map(probes);
  const deadline = Date.now() + 120_000;
  while (pending.size > 0 && Date.now() < deadline) {
    cancelled();
    for (const [port, path] of pending) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(2_000)]),
        });
        await response.body?.cancel();
        if (response.ok) pending.delete(port);
      } catch {
        // Readiness polling never changes source or publishes a new artifact.
      }
    }
    if (pending.size > 0)
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  cancelled();
  if (pending.size > 0)
    throw new StartError(
      'START_NOT_READY',
      '服務啟動逾時，請依上方診斷修正後重試。',
    );
}
const stop = () => stopped.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const flags = new Set(args);
  if (
    flags.size !== args.length ||
    args.some((flag) => !['--container', '--repair'].includes(flag))
  )
    throw new StartError(
      'START_ARGUMENT_INVALID',
      '啟動只接受--container及--repair，不接受任意路徑或命令。',
    );
  const container = flags.has('--container');
  const repair = flags.has('--repair');
  const host = container ? '0.0.0.0' : '127.0.0.1';
  await workspace();
  for (const [port, bind] of [
    ...(!repair
      ? [
          [4321, host],
          [4322, host],
        ]
      : []),
    [5173, host],
    [3001, '127.0.0.1'],
  ])
    await freePort(port, bind);
  const acquireFileLease = await bootstrap();
  lease = await acquireFileLease({
    root,
    name: 'dev-session',
    owner: 'release-bootstrap',
    nonBlocking: true,
    signal: stopped.signal,
  });
  if (!lease)
    throw new StartError(
      'START_ALREADY_RUNNING',
      '同一工作區已有服務啟動中，請先停止。',
    );
  await command(
    'pnpm',
    [
      'install',
      '--offline',
      '--frozen-lockfile',
      '--prod=false',
      '--ignore-scripts',
    ],
    'START_DEPENDENCIES_FAILED',
    '離線依賴準備失敗。Docker使用者請重新建置image，不要修改lockfile或升級套件。',
  );
  await command(
    'pnpm',
    ['run', 'build:packages'],
    'START_COMPILE_FAILED',
    '共用套件編譯失敗，請依上方診斷修正來源。',
  );
  await command(
    'pnpm',
    ['--filter', '@foliohaven/server', 'build'],
    'START_COMPILE_FAILED',
    '本機服務編譯失敗，請依上方診斷修正來源。',
  );
  if (!repair) {
    const { ArtifactStore } = await import('@foliohaven/server');
    const artifacts = new ArtifactStore({ repositoryRoot: root });
    const current = await artifacts.current();
    if (current.recoveryState !== 'ready')
      throw new StartError(
        'START_RECOVERY_REQUIRED',
        '網站產物需要復原；請先停止app並啟動repair服務，在「衝突與復原」完成處理。既有資料已保留。',
      );
    if (current.current === null)
      await command(
        process.execPath,
        ['scripts/build.mjs'],
        'START_FIRST_BUILD_FAILED',
        '首次網站建置失敗，請修正來源後重試；既有資料已保留。',
        3 * 60 * 60_000,
      );
    else if (current.current.build === null)
      throw new StartError(
        'START_ARTIFACT_UNKNOWN',
        '現有網站缺少可驗證的建置證據；請使用repair服務檢查，或明確執行pnpm build。既有網站未被覆蓋。',
      );
    await artifacts.withPreviewGate(async () => undefined, {
      signal: stopped.signal,
    });
  }
  cancelled();
  // Installation is complete before releasing the gate. A competing dev may
  // win the handoff; the ordinary supervisor then refuses without changing it.
  await lease.release();
  lease = undefined;
  tracked(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/dev.mjs',
      repair ? 'studio' : 'all',
      ...(container ? ['--container'] : []),
    ],
    true,
  );
  await ready([
    ...(!repair ? [[4321, '/']] : []),
    [5173, '/'],
    [3001, '/api/v1/health'],
  ]);
  if (!repair) {
    tracked(
      process.execPath,
      ['scripts/preview.mjs', ...(container ? ['--container'] : [])],
      true,
    );
    await ready([[4322, '/']]);
  }
  process.stdout.write(
    repair
      ? 'REPAIR_READY：修復工作室已就緒 http://localhost:5173；完成後停止repair，再啟動app。\n'
      : 'START_READY：工作室 http://localhost:5173；來源預覽 http://localhost:4321；網站預覽 http://localhost:4322。\n',
  );
  await new Promise((resolveStopped) => {
    if (stopped.signal.aborted) resolveStopped();
    else
      stopped.signal.addEventListener('abort', resolveStopped, { once: true });
  });
} catch (error) {
  const failure = serviceFailure ?? error;
  if (serviceFailure || !stopped.signal.aborted) {
    const known = failure instanceof StartError;
    const permissions = ['EACCES', 'EPERM'].includes(failure?.code);
    process.stderr.write(
      `${known ? failure.code : permissions ? 'START_WORKSPACE_NOT_WRITABLE' : 'START_FAILED'}：${known ? failure.message : permissions ? '工作區無法讀寫，請核對主機UID／GID及容器設定；不要放寬整個專案權限。' : '啟動失敗，請檢查來源、工具、產物與上方診斷；既有資料已保留。'}\n`,
    );
    process.exitCode = 1;
    failureReported = true;
  }
} finally {
  stopped.abort();
  const cleanup = await Promise.allSettled(
    [...children].map((child) => child.stop()),
  );
  if (cleanup.some((result) => result.status === 'rejected'))
    cleanupFailed = true;
  try {
    await lease?.release();
  } catch {
    cleanupFailed = true;
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (cleanupFailed) {
    process.stderr.write('START_CLEANUP_FAILED：部分啟動程序未能正常停止。\n');
    process.exitCode = 1;
  }
  if (serviceFailure && !failureReported) {
    process.stderr.write(`${serviceFailure.code}：${serviceFailure.message}\n`);
    process.exitCode = 1;
  }
}
