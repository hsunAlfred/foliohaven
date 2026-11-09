import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runControlledProcess } from '../../server/src/runtime/process.js';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'alfred-private-directory-'));
  roots.push(root);
  return root;
}
async function prepare(
  root: string,
  resource = '.foliohaven/reports/playwright',
): Promise<void> {
  await runControlledProcess({
    command: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      'const {ensurePrivateDirectory}=await import(process.argv[1]);ensurePrivateDirectory(process.argv[2],process.argv[3]);',
      new URL('../../scripts/private-directory.mjs', import.meta.url).href,
      root,
      resource,
    ],
    cwd: root,
    timeoutMs: 10_000,
  });
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe('owner-only private tool directories', () => {
  it('tightens owned directories and preserves existing file bytes', async () => {
    const root = await fixture();
    await mkdir(join(root, '.foliohaven'));
    await chmod(join(root, '.foliohaven'), 0o755);
    await writeFile(
      join(root, '.foliohaven/existing.txt'),
      'unchanged fixture',
    );
    await prepare(root);
    for (const path of [
      '.foliohaven',
      '.foliohaven/reports',
      '.foliohaven/reports/playwright',
    ])
      expect((await lstat(join(root, path))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(root, '.foliohaven/existing.txt'), 'utf8')).toBe(
      'unchanged fixture',
    );
  });
  it('refuses symlink redirection without changing its target permissions', async () => {
    const root = await fixture();
    await mkdir(join(root, 'victim'));
    await chmod(join(root, 'victim'), 0o755);
    await symlink('victim', join(root, '.foliohaven'));
    await expect(prepare(root)).rejects.toMatchObject({
      code: 'PROCESS_EXITED',
    });
    expect((await lstat(join(root, 'victim'))).mode & 0o777).toBe(0o755);
  });
  it('rejects identifiers outside the fixed private tree', async () => {
    const root = await fixture();
    await expect(prepare(root, '.foliohaven/../outside')).rejects.toMatchObject(
      {
        code: 'PROCESS_EXITED',
      },
    );
    await expect(lstat(join(root, 'outside'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
