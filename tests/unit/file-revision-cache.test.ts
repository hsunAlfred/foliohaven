import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRevisionCache } from '../../server/src/files/revision-cache.js';
import { FileRepository } from '../../server/src/files/repository.js';

const roots: string[] = [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 2100));
async function fixture(stable = true) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-revision-cache-'));
  roots.push(root);
  const path = join(root, 'source.txt');
  await writeFile(path, 'first');
  if (stable) await settle();
  return { root, path };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('file identity validated derived cache', () => {
  it('reuses unchanged data, detects same-size edits with restored mtime, and keeps only the current revision', async () => {
    const { path } = await fixture();
    const cache = new FileRevisionCache<string>();
    const load = vi.fn(() => readFile(path, 'utf8'));
    expect(await cache.read([path], load)).toBe('first');
    expect(await cache.read([path], load)).toBe('first');
    expect(load).toHaveBeenCalledTimes(1);
    const before = await lstat(path);
    await writeFile(path, 'other');
    await utimes(path, before.atime, before.mtime);
    expect(await cache.read([path], load)).toBe('other');
    expect(load).toHaveBeenCalledTimes(3);
    await settle();
    expect(await cache.read([path], load)).toBe('other');
    expect(await cache.read([path], load)).toBe('other');
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('invalidates rename, deletion and symlink replacement without returning old data', async () => {
    const { root, path } = await fixture();
    const cache = new FileRevisionCache<string>();
    const load = vi.fn(() => readFile(path, 'utf8'));
    await cache.read([path], load);
    const replacement = join(root, 'replacement.txt');
    await writeFile(replacement, 'other');
    await rename(replacement, path);
    expect(await cache.read([path], load)).toBe('other');
    await rm(path);
    await expect(cache.read([path], load)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await writeFile(replacement, 'third');
    await symlink(replacement, path);
    await expect(cache.read([path], load)).rejects.toMatchObject({
      code: 'ELOOP',
    });
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('reopens cached files to enforce permissions and invalidates chmod', async () => {
    const { path } = await fixture();
    const cache = new FileRevisionCache<string>();
    const load = vi.fn(() => readFile(path, 'utf8'));
    await cache.read([path], load);
    await chmod(path, 0o400);
    await cache.read([path], load);
    expect(load).toHaveBeenCalledTimes(3);
    if (process.getuid?.() !== 0) {
      await chmod(path, 0o000);
      await expect(cache.read([path], load)).rejects.toMatchObject({
        code: 'EACCES',
      });
      await chmod(path, 0o600);
      expect(await cache.read([path], load)).toBe('first');
      expect(load).toHaveBeenCalledTimes(5);
    }
  });

  it('rejects changes during a miss and never caches a failed load', async () => {
    const { path } = await fixture(false);
    const cache = new FileRevisionCache<string>();
    await expect(
      cache.read([path], async () => {
        const value = await readFile(path, 'utf8');
        await writeFile(path, 'other');
        return value;
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    const load = vi.fn(() => readFile(path, 'utf8'));
    expect(await cache.read([path], load)).toBe('other');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('evicts old resource groups at the configured bound', async () => {
    const { root, path } = await fixture();
    const second = join(root, 'second.txt');
    await writeFile(second, 'second');
    await settle();
    const cache = new FileRevisionCache<string>(1);
    const load = vi.fn(() => readFile(path, 'utf8'));
    await cache.read([path], load);
    await cache.read([second], () => readFile(second, 'utf8'));
    await cache.read([path], load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not reuse recent or future timestamps and keeps resource namespaces separate', async () => {
    const { path } = await fixture();
    const cache = new FileRevisionCache<string>();
    const load = vi.fn(() => readFile(path, 'utf8'));
    expect(await cache.read([path], load, 'one')).toBe('first');
    expect(await cache.read([path], load, 'two')).toBe('first');
    expect(load).toHaveBeenCalledTimes(2);
    const future = new Date(Date.now() + 60_000);
    await utimes(path, future, future);
    await cache.read([path], load, 'one');
    await cache.read([path], load, 'one');
    expect(load).toHaveBeenCalledTimes(6);
  });

  it('keeps cached repository readers inside the writer lock and preserves IDE guarding', async () => {
    const { root } = await fixture(false);
    await mkdir(join(root, 'content'));
    const key = 'content/site.json';
    await writeFile(join(root, key), 'first');
    const repository = new FileRepository({
      repositoryRoot: root,
      reuseFileDigests: true,
    });
    await repository.initialize();
    const before = await repository.withConsistentRead(async (session) => ({
      raw: await session.read(key),
      etag: await session.etag([key]),
    }));
    await repository.withConsistentRead((session) => session.etag([key]));
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = repository.withConsistentRead(async (session) => {
      const value = await session.read(key);
      entered();
      await gate;
      return value;
    });
    await waiting;
    let completed = false;
    const saving = repository
      .commit({
        kind: 'save',
        changes: [
          {
            resourceKey: key,
            expectedRevision: before.raw?.revision ?? null,
            content: Buffer.from('other'),
          },
        ],
        precondition: { ifMatch: before.etag, resourceKeys: [key] },
      })
      .then(() => {
        completed = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(completed).toBe(false);
    release();
    expect((await reading)?.bytes.toString()).toBe('first');
    await saving;
    expect(
      (
        await repository.withConsistentRead((session) => session.read(key))
      )?.bytes.toString(),
    ).toBe('other');
    const scanInputs = async () => 'a'.repeat(64);
    const workspace = await repository.workspace({ scanInputs });
    await repository.setEditMode('ide', workspace.etag, { scanInputs });
    await expect(
      repository.commit({
        kind: 'save',
        changes: [
          {
            resourceKey: key,
            expectedRevision: null,
            content: Buffer.from('third'),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'IDE_EDIT_MODE' });
  });

  it('rejects an external same-length edit during a cached repository session', async () => {
    const { root } = await fixture(false);
    await mkdir(join(root, 'content'));
    const key = 'content/site.json';
    const path = join(root, key);
    await writeFile(path, 'first');
    await settle();
    const repository = new FileRepository({
      repositoryRoot: root,
      reuseFileDigests: true,
    });
    await repository.initialize();
    await repository.withConsistentRead((session) => session.etag([key]));
    const before = await lstat(path);
    await expect(
      repository.withConsistentRead(async (session) => {
        await session.etag([key]);
        await writeFile(path, 'other');
        await utimes(path, before.atime, before.mtime);
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  });
});
