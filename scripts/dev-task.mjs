import { privateResource } from './workspace-paths.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { managedProcess } from './managed-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let closing = false;
let cleanup;
let initialization;
let shutdown;
let finished = false;
let orphaned = false;
const ready = () => {
  if (process.connected) process.send?.({ event: 'ready' }, () => undefined);
};
function stop() {
  shutdown ??= (async () => {
    closing = true;
    await initialization?.catch(() => undefined);
    await cleanup?.();
  })()
    .catch(() => {
      process.stderr.write('DEV_TASK_STOP_FAILED：開發子服務未能正常停止。\n');
      process.exitCode = 1;
    })
    .finally(() => {
      finished = true;
      if (orphaned) {
        // supervisor已死；此wrapper是該group的owner，不能只停止pnpm而留下其工具程序。
        process.kill(-process.pid, 'SIGKILL');
      }
      if (process.connected) process.disconnect();
    });
  return shutdown;
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.once('disconnect', () => {
  if (!finished) {
    orphaned = true;
    void stop();
  }
});
if (!process.send) {
  process.stderr.write('DEV_TASK_PRIVATE：請使用根pnpm dev指令啟動。\n');
  process.exitCode = 1;
} else {
  process.once('message', (message) => {
    initialization = start(message).catch(() => {
      process.stderr.write('DEV_TASK_FAILED：開發服務啟動或執行失敗。\n');
      process.exitCode = 1;
      void stop();
    });
  });
}
async function start(message) {
  if (!message || typeof message !== 'object' || closing) return;
  const { task, proxyToken, container = false } = message;
  if (typeof container !== 'boolean') throw new Error('DEV_BIND_INVALID');
  const publicHost = container ? '0.0.0.0' : '127.0.0.1';
  if (task === 'api' || task === 'studio') {
    if (typeof proxyToken !== 'string' || !/^[a-f0-9]{64}$/u.test(proxyToken))
      throw new Error('PAIRING_REQUIRED');
    if (task === 'api') {
      const { createLocalService } =
        await import('../server/src/http/index.ts');
      const service = await createLocalService({
        repositoryRoot: root,
        proxyToken,
      });
      cleanup = () => service.close();
      if (closing) return;
      await service.listen();
    } else {
      const [{ createServer }, { createStudioViteConfig }] = await Promise.all([
        import('vite'),
        import('../studio/vite.config.ts'),
      ]);
      const vite = await createServer({
        ...createStudioViteConfig({ proxyToken, host: publicHost }),
        configFile: false,
      });
      cleanup = () => vite.close();
      if (closing) return;
      await vite.listen();
    }
    if (!closing) ready();
    return;
  }
  const commands = {
    'bootstrap-packages': ['pnpm', ['run', 'build:packages']],
    'bootstrap-server': ['pnpm', ['--filter', '@foliohaven/server', 'build']],
    'prepare-site': [process.execPath, ['scripts/render-dev.mjs', '--once']],
    'prepare-authoring': [
      process.execPath,
      ['scripts/render-dev.mjs', '--authoring'],
    ],
    types: [
      process.execPath,
      [
        'node_modules/typescript/bin/tsc',
        '-b',
        'server/tsconfig.json',
        '--watch',
        '--preserveWatchOutput',
      ],
    ],
    styles: [process.execPath, ['scripts/sync-ui-assets.mjs', '--watch']],
    render: [process.execPath, ['scripts/render-dev.mjs']],
    site: [
      'pnpm',
      [
        '--filter',
        '@foliohaven/site',
        'exec',
        'astro',
        'dev',
        '--ignore-lock',
        '--host',
        publicHost,
        '--port',
        '4321',
      ],
    ],
  };
  if (typeof task !== 'string' || !Object.hasOwn(commands, task))
    throw new Error('DEV_TASK_INVALID');
  const [command, args] = commands[task];
  const child = managedProcess(command, args, {
    cwd: root,
    detached: false,
    env: {
      ...process.env,
      ...(task === 'site'
        ? {
            FOLIOHAVEN_RENDER_CONTEXT: resolve(
              root,
              privateResource(root, 'dev/render'),
            ),
            FOLIOHAVEN_RENDER_OUTPUT: resolve(
              root,
              privateResource(root, 'dev/site-output'),
            ),
          }
        : {}),
    },
  });
  cleanup = () => child.stop();
  ready();
  // 不把長期執行放入initialization，停止時可先中止child，再等close。
  const oneShot = [
    'bootstrap-packages',
    'bootstrap-server',
    'prepare-site',
    'prepare-authoring',
  ].includes(task);
  void child.done.then((result) => {
    if (!closing) {
      if (oneShot) process.exitCode = result.code ?? 1;
      else {
        process.stderr.write(
          `DEV_TASK_EXITED：${task}已退出，停止整組服務。\n`,
        );
        process.exitCode = 1;
      }
    }
    void stop();
  });
}
