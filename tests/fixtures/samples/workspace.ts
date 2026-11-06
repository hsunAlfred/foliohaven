import { cp, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { committedWorkspace } from '../build/committed-workspace.js';
import { runControlledProcess } from '../../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../../server/src/runtime/environment.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
export const samplesReferenceRoot = fileURLToPath(
  new URL('./reference/', import.meta.url),
);
const excluded = new Set([
  'node_modules',
  'dist',
  '.astro',
  '.alfred',
  '.vite',
]);

/** 真正程式加固定範例來源；sourceRoot 只供測試隔離，不影響正式 CLI。 */
export async function samplesWorkspace(sourceRoot = repository) {
  const fixture = await committedWorkspace(sourceRoot);
  try {
    for (const resource of ['content', 'media/source']) {
      await rm(join(fixture.root, resource), { recursive: true, force: true });
      await cp(
        join(samplesReferenceRoot, resource),
        join(fixture.root, resource),
        { recursive: true },
      );
    }
    for (const resource of [
      'packages/core',
      'packages/ui',
      'site',
      'studio',
      'server',
      'scripts',
    ]) {
      const source = join(sourceRoot, resource);
      await rm(join(fixture.root, resource), { recursive: true, force: true });
      await cp(source, join(fixture.root, resource), {
        recursive: true,
        filter: (path) =>
          !relative(source, path)
            .split('/')
            .some((part) => excluded.has(part)),
      });
    }
    for (const resource of [
      '.node-version',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
    ])
      await cp(join(sourceRoot, resource), join(fixture.root, resource));
    await runControlledProcess({
      command: 'pnpm',
      args: [
        'install',
        '--offline',
        '--frozen-lockfile',
        '--prod=false',
        '--ignore-scripts',
      ],
      cwd: fixture.root,
      env: buildProcessEnvironment({ NODE_ENV: 'development' }),
      timeoutMs: 120_000,
    });
    return fixture;
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

export async function buildSamples(root: string) {
  const result = await runControlledProcess({
    command: 'pnpm',
    args: ['build'],
    cwd: root,
    env: buildProcessEnvironment(),
    timeoutMs: 180_000,
  });
  const events = result.stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const success = events.find((event) => event['event'] === 'build-succeeded');
  if (success === undefined) throw new Error('正式建置未回傳成功事件。');
  return success;
}
