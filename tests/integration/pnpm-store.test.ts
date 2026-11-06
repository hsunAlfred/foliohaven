import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../server/src/runtime/environment.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  for (const root of directories.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('portable pnpm warm store', () => {
  it('uses the same isolated HOME with spaces from independent workspace locations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'foliohaven-pnpm-store-'));
    directories.push(root);
    const home = join(root, 'isolated home');
    await mkdir(home);
    const environment = buildProcessEnvironment({
      HOME: home,
      PNPM_HOME: join(home, 'pnpm'),
    });
    const locations: string[] = [];
    for (const name of ['author-workspace', 'private-build-snapshot']) {
      const workspace = join(root, name);
      await mkdir(workspace);
      for (const file of ['package.json', 'pnpm-workspace.yaml'])
        await copyFile(join(repository, file), join(workspace, file));
      const result = await runControlledProcess({
        command: 'pnpm',
        args: ['store', 'path'],
        cwd: workspace,
        env: environment,
        timeoutMs: 30_000,
      });
      locations.push(result.stdout.toString('utf8').trim());
    }
    expect(locations).toEqual([
      join(home, '.local/share/pnpm/store/v11'),
      join(home, '.local/share/pnpm/store/v11'),
    ]);
  });
});
