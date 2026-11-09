import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { committedWorkspace } from '../fixtures/build/committed-workspace.js';
import {
  copyBuildSnapshot,
  scanBuildInputs,
} from '../../server/src/build/inputs.js';
import { prepareSnapshotDependencies } from '../../server/src/build/dependencies.js';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../server/src/runtime/environment.js';

const cleanups: (() => Promise<void>)[] = [];
async function fixture(
  emptyStore = false,
): Promise<{ root: string; snapshot: string }> {
  const { root, cleanup } = await committedWorkspace();
  cleanups.push(cleanup);
  if (emptyStore) {
    const yaml = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      yaml.replace(
        /^storeDir:.*$/m,
        `storeDir: ${join(root, '.foliohaven/empty-store')}`,
      ),
    );
  }
  const job = join(root, '.foliohaven/builds', randomUUID());
  await mkdir(job, { recursive: true, mode: 0o700 });
  const snapshot = join(job, 'snapshot');
  await copyBuildSnapshot(root, snapshot, await scanBuildInputs(root));
  return { root, snapshot };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('private frozen offline snapshot dependencies', () => {
  it('creates private workspace links and executes real native tools without lifecycle scripts', async () => {
    const { root, snapshot } = await fixture();
    const before = await scanBuildInputs(snapshot);
    await prepareSnapshotDependencies({
      repositoryRoot: root,
      snapshotRoot: snapshot,
    });
    expect(
      await realpath(join(snapshot, 'node_modules/@foliohaven/core')),
    ).toBe(join(snapshot, 'packages/core'));
    expect(
      await realpath(join(snapshot, 'server/node_modules/@foliohaven/site')),
    ).toBe(join(snapshot, 'site'));
    expect((await scanBuildInputs(snapshot)).revision).toBe(before.revision);
    const check = await runControlledProcess({
      command: process.execPath,
      args: ['scripts/check-dependencies.mjs'],
      cwd: snapshot,
      env: buildProcessEnvironment(),
      timeoutMs: 60_000,
    });
    expect(check.stdout.toString()).toContain('Sharp');
    expect(check.stdout.toString()).toContain('FFmpeg');
    await expect(
      prepareSnapshotDependencies({
        repositoryRoot: root,
        snapshotRoot: snapshot,
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_DEPENDENCIES_EXIST' });
  });
  it('fails with an empty warm store and leaves an existing dist untouched', async () => {
    const { root, snapshot } = await fixture(true);
    await mkdir(join(root, 'dist'));
    await writeFile(
      join(root, 'dist/index.html'),
      'previous successful artifact',
    );
    await expect(
      prepareSnapshotDependencies({
        repositoryRoot: root,
        snapshotRoot: snapshot,
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
    expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toBe(
      'previous successful artifact',
    );
  });
});
