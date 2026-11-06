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
  resource = '.alfred/reports/playwright',
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
    await mkdir(join(root, '.alfred'));
    await chmod(join(root, '.alfred'), 0o755);
    await writeFile(join(root, '.alfred/existing.txt'), 'unchanged fixture');
    await prepare(root);
    for (const path of [
      '.alfred',
      '.alfred/reports',
      '.alfred/reports/playwright',
    ])
      expect((await lstat(join(root, path))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(root, '.alfred/existing.txt'), 'utf8')).toBe(
      'unchanged fixture',
    );
  });
  it('refuses symlink redirection without changing its target permissions', async () => {
    const root = await fixture();
    await mkdir(join(root, 'victim'));
    await chmod(join(root, 'victim'), 0o755);
    await symlink('victim', join(root, '.alfred'));
    await expect(prepare(root)).rejects.toMatchObject({
      code: 'PROCESS_EXITED',
    });
    expect((await lstat(join(root, 'victim'))).mode & 0o777).toBe(0o755);
  });
  it('rejects identifiers outside the fixed private tree', async () => {
    const root = await fixture();
    await expect(prepare(root, '.alfred/../outside')).rejects.toMatchObject({
      code: 'PROCESS_EXITED',
    });
    await expect(lstat(join(root, 'outside'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
