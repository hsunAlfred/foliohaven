import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UuidSchema } from '@foliohaven/core';
import { samplesWorkspace } from '../fixtures/samples/workspace.js';
import {
  cleanupOwnedProcesses,
  ownedProcesses,
  portAvailable,
  request,
  startDev,
} from '../fixtures/dev/supervisor.js';
import { acquireFileLease } from '../../server/src/runtime/lease.js';
import type { FileLease } from '../../server/src/runtime/lease.js';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../server/src/runtime/environment.js';

async function listen(server: ReturnType<typeof createServer>, port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Cold-start fixture needs a TCP address');
  return address.port;
}
async function close(server: ReturnType<typeof createServer>) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

it('cleans previous render generations only after acquiring the dev lease and proving the isolated Astro port is free', async () => {
  const fixture = await samplesWorkspace();
  const blocker = createServer();
  let lease: FileLease | null = null;
  let running: ReturnType<typeof startDev> | undefined;
  try {
    const port = await listen(blocker);
    await close(blocker);
    // Only this copy uses an ephemeral site port. Product entrypoints and the
    // current workspace's Astro/Studio/API services keep their original ports.
    for (const resource of ['scripts/dev.mjs', 'scripts/dev-task.mjs']) {
      const path = join(fixture.root, resource);
      const source = await readFile(path, 'utf8');
      expect(source).toContain('4321');
      await writeFile(path, source.replaceAll('4321', String(port)));
    }
    const context = join(fixture.root, '.alfred/dev/render');
    const oldGeneration = randomUUID();
    const oldDirectory = join(context, 'generations', oldGeneration);
    await mkdir(oldDirectory, { recursive: true, mode: 0o700 });
    const sentinel = join(oldDirectory, 'old-session.txt');
    const sentinelBytes = Buffer.from(
      'old session must survive failed startup gates',
    );
    await writeFile(sentinel, sentinelBytes);
    const index = join(context, 'index.json');
    const indexBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        status: 'invalid',
        code: 'OLD_SESSION_SENTINEL',
      }),
    );
    await writeFile(index, indexBytes);
    const rejectedStart = () =>
      runControlledProcess({
        command: 'pnpm',
        args: ['dev:site'],
        cwd: fixture.root,
        env: buildProcessEnvironment(),
        timeoutMs: 30_000,
      });

    expect(await portAvailable(port)).toBe(true);
    lease = await acquireFileLease({
      root: fixture.root,
      name: 'dev-session',
      owner: 'cold-start-test',
      nonBlocking: true,
    });
    if (!lease) throw new Error('Fixture dev lease could not be held');
    await expect(rejectedStart()).rejects.toMatchObject({
      code: 'PROCESS_EXITED',
    });
    expect(await readFile(index)).toEqual(indexBytes);
    expect(await readFile(sentinel)).toEqual(sentinelBytes);
    await lease.release();
    lease = null;

    await listen(blocker, port);
    await expect(rejectedStart()).rejects.toMatchObject({
      code: 'PROCESS_EXITED',
    });
    expect(await readFile(index)).toEqual(indexBytes);
    expect(await readFile(sentinel)).toEqual(sentinelBytes);
    await close(blocker);
    expect(await portAvailable(port)).toBe(true);

    running = startDev(fixture.root, 'site');
    await running.readyOrFail();
    const page = await request(port);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<html');
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    const published = JSON.parse(await readFile(index, 'utf8')) as {
      status: string;
      generation?: string;
    };
    expect(published.status).toBe('valid');
    const generation = UuidSchema.parse(published.generation);
    expect(generation).not.toBe(oldGeneration);
    expect(
      JSON.parse(
        await readFile(
          join(context, 'generations', generation, 'home.json'),
          'utf8',
        ),
      ),
    ).toBeDefined();
    await running.stop();
    expect(running.exited).toBe(true);
    expect(await portAvailable(port)).toBe(true);
    expect(await ownedProcesses(fixture.root)).toEqual([]);
  } finally {
    try {
      await lease?.release();
      await close(blocker);
      if (running && !running.exited)
        await running.stop().catch(() => undefined);
      await cleanupOwnedProcesses(fixture.root);
    } finally {
      await fixture.cleanup();
    }
  }
}, 300_000);
