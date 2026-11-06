import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  copyBuildSnapshot,
  scanBuildInputs,
} from '../../server/src/build/inputs.js';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'alfred-build-inputs-'));
  roots.push(root);
  for (const path of [
    'content/articles',
    'packages/core/src',
    'packages/ui/src',
    'site/src',
    'studio/src',
    'server/src',
    'scripts',
  ])
    await mkdir(join(root, path), { recursive: true });
  for (const [path, bytes] of Object.entries({
    '.node-version': '26.12.1\n',
    'package.json': '{}\n',
    'pnpm-workspace.yaml': 'packages: []\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'content/site.json': '{"siteName":"fixture"}\n',
    'site/src/page.ts': 'export const title = "snapshot";\n',
    'packages/ui/src/style.css': 'body { color: red; }\n',
    'server/src/index.ts': 'export {};\n',
  }))
    await writeFile(join(root, path), bytes);
  return root;
}
async function snapshot(root: string): Promise<string> {
  const job = join(root, '.alfred/builds', randomUUID());
  await mkdir(job, { recursive: true, mode: 0o700 });
  return join(job, 'snapshot');
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('complete build input scanner and snapshot', () => {
  it('honors cancellation before reading or creating a snapshot', async () => {
    const root = await fixture();
    const manifest = await scanBuildInputs(root);
    const signal = AbortSignal.abort();
    await expect(scanBuildInputs(root, { signal })).rejects.toMatchObject({
      code: 'BUILD_CANCELLED',
    });
    await expect(
      copyBuildSnapshot(root, await snapshot(root), manifest, { signal }),
    ).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
  });
  it('hashes program, content, CSS, config and optional media with a stable sorted manifest', async () => {
    const root = await fixture();
    await mkdir(join(root, 'media/source/item'), { recursive: true });
    await writeFile(
      join(root, 'media/source/item/original.png'),
      Buffer.alloc(128 * 1024, 123),
    );
    const first = await scanBuildInputs(root);
    expect(await scanBuildInputs(root)).toEqual(first);
    expect(
      first.entries.some(
        (entry) => entry.path === 'media/source/item/original.png',
      ),
    ).toBe(true);
    expect(
      first.entries.some((entry) => entry.path === 'packages/ui/src/style.css'),
    ).toBe(true);
    expect(first.entries.map((entry) => entry.path)).toEqual(
      first.entries.map((entry) => entry.path).sort(),
    );
  });
  it('detects same-size changes even when mtime is restored, and add/delete/empty-directory changes', async () => {
    const root = await fixture();
    const before = await scanBuildInputs(root);
    const path = join(root, 'site/src/page.ts');
    const stamp = new Date('2020-01-01T00:00:00Z');
    await utimes(path, stamp, stamp);
    await writeFile(path, 'export const title = "changed!";\n');
    await utimes(path, stamp, stamp);
    expect((await scanBuildInputs(root)).revision).not.toBe(before.revision);
    const changed = await scanBuildInputs(root);
    await mkdir(join(root, 'content/articles/new-article'));
    const added = await scanBuildInputs(root);
    expect(added.revision).not.toBe(changed.revision);
    await rm(join(root, 'content/articles/new-article'), { recursive: true });
    expect((await scanBuildInputs(root)).revision).toBe(changed.revision);
    await rm(path);
    expect((await scanBuildInputs(root)).revision).not.toBe(changed.revision);
  });
  it('excludes dependencies, outputs and private records without following their symlinks', async () => {
    const root = await fixture();
    const before = await scanBuildInputs(root);
    await symlink(
      '/unavailable-private-target',
      join(root, 'site/node_modules'),
    );
    await mkdir(join(root, 'site/dist'), { recursive: true });
    await writeFile(join(root, 'site/dist/generated.html'), 'output');
    await mkdir(join(root, '.alfred'), { mode: 0o700 });
    await writeFile(join(root, '.alfred/private.json'), 'private fixture');
    expect((await scanBuildInputs(root)).revision).toBe(before.revision);
  });
  it('rejects source symlinks and nested private environment files', async () => {
    const root = await fixture();
    await symlink('page.ts', join(root, 'site/src/linked.ts'));
    await expect(scanBuildInputs(root)).rejects.toMatchObject({
      code: 'RESOURCE_SYMLINK',
    });
    await rm(join(root, 'site/src/linked.ts'));
    await writeFile(join(root, 'site/.env.local'), 'SAMPLE_PRIVATE=value');
    await expect(scanBuildInputs(root)).rejects.toMatchObject({
      code: 'PRIVATE_BUILD_INPUT',
    });
  });
  it('copies an independent snapshot and verifies it against the live manifest', async () => {
    const root = await fixture();
    const manifest = await scanBuildInputs(root);
    const destination = await snapshot(root);
    await copyBuildSnapshot(root, destination, manifest);
    expect(await scanBuildInputs(destination)).toEqual(manifest);
    await writeFile(join(root, 'site/src/page.ts'), 'changed live source');
    expect(await readFile(join(destination, 'site/src/page.ts'), 'utf8')).toBe(
      'export const title = "snapshot";\n',
    );
  });
  it('rejects stale manifests and retains a partial candidate for the caller to handle', async () => {
    const root = await fixture();
    const manifest = await scanBuildInputs(root);
    await writeFile(join(root, 'site/src/page.ts'), 'changed live source');
    await expect(
      copyBuildSnapshot(root, await snapshot(root), manifest),
    ).rejects.toMatchObject({ code: 'BUILD_INPUT_CHANGED' });
  });
  it('rejects a newly added source during copying via the final full scan', async () => {
    const root = await fixture();
    const manifest = await scanBuildInputs(root);
    await writeFile(join(root, 'site/src/added.ts'), 'export {};');
    await expect(
      copyBuildSnapshot(root, await snapshot(root), manifest),
    ).rejects.toMatchObject({ code: 'BUILD_INPUT_CHANGED' });
  });
  it('tracks executable modes and refuses missing required inputs or unsafe destinations', async () => {
    const root = await fixture();
    const before = await scanBuildInputs(root);
    await chmod(join(root, 'server/src/index.ts'), 0o700);
    expect((await scanBuildInputs(root)).revision).not.toBe(before.revision);
    await expect(
      copyBuildSnapshot(root, join(root, 'outside'), before),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_DESTINATION' });
    await rm(join(root, 'pnpm-lock.yaml'));
    await expect(scanBuildInputs(root)).rejects.toMatchObject({
      code: 'BUILD_INPUT_MISSING',
    });
  });
});
