import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BuildInputCache,
  scanBuildInputs,
} from '../../server/src/build/inputs.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-input-cache-'));
  roots.push(root);
  for (const path of [
    'content',
    'packages/core',
    'packages/ui',
    'site',
    'studio',
    'server',
    'scripts',
  ])
    await mkdir(join(root, path), { recursive: true });
  for (const path of [
    '.node-version',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
  ])
    await writeFile(join(root, path), 'fixture');
  const path = join(root, 'site/page.ts');
  await writeFile(path, 'first');
  await new Promise((resolve) => setTimeout(resolve, 2100));
  return { root, path };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Studio full-input observation cache', () => {
  it('matches the strict byte scan after equal-length edits, restored mtime, rename, chmod and additions/deletions', async () => {
    const { root, path } = await fixture();
    const cache = new BuildInputCache();
    const check = async () => {
      const observed = await scanBuildInputs(root, { cache });
      expect(observed).toEqual(await scanBuildInputs(root));
      return observed.revision;
    };
    const first = await check();
    expect(await check()).toBe(first);
    const before = await lstat(path);
    await writeFile(path, 'other');
    await utimes(path, before.atime, before.mtime);
    const changed = await check();
    expect(changed).not.toBe(first);
    const replacement = join(root, 'site/next.ts');
    await writeFile(replacement, 'third');
    await rename(replacement, path);
    const renamed = await check();
    expect(renamed).not.toBe(changed);
    await chmod(path, 0o700);
    expect(await check()).not.toBe(renamed);
    const executable = await check();
    const directory = join(root, 'content/empty');
    await mkdir(directory);
    expect(await check()).not.toBe(executable);
    await rm(directory, { recursive: true });
    expect(await check()).toBe(executable);
    await rm(path);
    expect(await check()).not.toBe(executable);
  });

  it('rejects changed permissions, symlinks and aborts rather than using a cached version', async () => {
    const { root, path } = await fixture();
    const cache = new BuildInputCache();
    await scanBuildInputs(root, { cache });
    if (process.getuid?.() !== 0) {
      await chmod(path, 0o000);
      await expect(scanBuildInputs(root, { cache })).rejects.toMatchObject({
        code: 'EACCES',
      });
      await chmod(path, 0o600);
    }
    await scanBuildInputs(root, { cache });
    await expect(
      scanBuildInputs(root, { cache, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
    await rename(path, join(root, 'site/next.ts'));
    await symlink('next.ts', path);
    await expect(scanBuildInputs(root, { cache })).rejects.toMatchObject({
      code: 'RESOURCE_SYMLINK',
    });
  });
});
