import { afterEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireFileLease,
  type FileLease,
} from '../../server/src/runtime/lease.js';

const roots: string[] = [];
const leases: FileLease[] = [];
const children: ChildProcess[] = [];
const closed = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', () => resolve());
  });
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'alfred-runtime-lease-'));
  roots.push(path);
  return path;
}
async function acquire(
  path: string,
  options: {
    name?: string;
    nonBlocking?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<FileLease | null> {
  const lease = await acquireFileLease({
    root: path,
    owner: 'lease-test',
    name: 'shared',
    ...options,
  });
  if (lease) leases.push(lease);
  return lease;
}
async function acquireHeld(path: string): Promise<FileLease> {
  const lease = await acquire(path);
  if (!lease) throw new Error('Isolated lease acquisition failed');
  return lease;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
    await closed(child);
  }
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('kernel descriptor leases', () => {
  it('flock helper exits while owner retains the lock; release keeps the inode', async () => {
    const path = await root();
    const first = await acquireHeld(path);
    expect(first).not.toBeNull();
    const inode = (await lstat(join(path, '.alfred/locks/shared.lock'))).ino;
    expect(await acquire(path, { nonBlocking: true })).toBeNull();
    await first.release();
    await first.release();
    expect(await acquire(path, { nonBlocking: true })).not.toBeNull();
    expect((await lstat(join(path, '.alfred/locks/shared.lock'))).ino).toBe(
      inode,
    );
  });

  it('waits for release without stealing a live owner and reports bounded contention', async () => {
    const path = await root();
    const first = await acquireHeld(path);
    await expect(acquire(path, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'WORKSPACE_BUSY',
    });
    const pending = acquire(path, { timeoutMs: 1_000 });
    await first.release();
    expect(await pending).not.toBeNull();
  });

  it('cancels a blocked flock child and permits a later acquisition', async () => {
    const path = await root();
    const first = await acquireHeld(path);
    const controller = new AbortController();
    const pending = acquire(path, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
    });
    await first.release();
    expect(await acquire(path, { nonBlocking: true })).not.toBeNull();
  });

  it('kernel releases the descriptor after an actual owner SIGKILL', async () => {
    const path = await root();
    const helper = fileURLToPath(
      new URL('../fixtures/runtime/lease-owner.ts', import.meta.url),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', helper, path], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', () =>
        reject(new Error('Isolated lease owner exited before ready')),
      );
    });
    expect(
      await acquire(path, { name: 'crash-test', nonBlocking: true }),
    ).toBeNull();
    child.kill('SIGKILL');
    await closed(child);
    expect(
      await acquire(path, { name: 'crash-test', nonBlocking: true }),
    ).not.toBeNull();
  });

  it('an inherited native-worker descriptor retains its slot until worker exits', async () => {
    const path = await root();
    const lease = await acquireHeld(path);
    const child = spawn(
      process.execPath,
      ['-e', "process.stdin.resume();process.stdout.write('ready\\n')"],
      { stdio: ['pipe', 'pipe', 'ignore', lease.fd] },
    );
    children.push(child);
    const stdout = child.stdout;
    if (!stdout) throw new Error('Isolated worker stdout unavailable');
    await new Promise<void>((resolve, reject) => {
      stdout.once('data', () => resolve());
      child.once('error', reject);
    });
    await lease.release();
    expect(await acquire(path, { nonBlocking: true })).toBeNull();
    child.kill('SIGKILL');
    await closed(child);
    expect(await acquire(path, { nonBlocking: true })).not.toBeNull();
  });

  it('rejects symlink or accessible lock files and invalid names', async () => {
    const path = await root();
    const first = await acquireHeld(path);
    await first.release();
    await chmod(join(path, '.alfred/locks/shared.lock'), 0o644);
    await expect(acquire(path)).rejects.toMatchObject({
      code: 'LOCK_PERMISSIONS',
    });
    await symlink('shared.lock', join(path, '.alfred/locks/linked.lock'));
    await expect(acquire(path, { name: 'linked' })).rejects.toMatchObject({
      code: 'RESOURCE_SYMLINK',
    });
    await expect(acquire(path, { name: '../outside' })).rejects.toMatchObject({
      code: 'INVALID_LEASE_OPTIONS',
    });
  });
});
