import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { CONTENT_LIMITS } from '@foliohaven/core';
import { FileRepository } from '../../server/src/files/index.js';
import type { ReadSession } from '../../server/src/files/types.js';
import { MediaService } from '../../server/src/media/index.js';
import type { NativeImageFactory } from '../../server/src/media/worker.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-media-list-'));
  fixtures.push(root);
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  const service = new MediaService({ repositoryRoot: root, repository });
  const bytes = await sharp({
    create: {
      width: 32,
      height: 16,
      channels: 3,
      background: '#80688f',
    },
  })
    .png()
    .toBuffer();
  const add = async (displayName: string) =>
    (
      await service.register(
        await service.stageSource(Readable.from([bytes]), {
          filename: 'image.png',
          mimeType: 'image/png',
          displayName,
        }),
      )
    ).value;
  return { root, repository, service, add };
}

describe('batched media collection reads', () => {
  it('overlaps bounded reads while preserving the selected order', async () => {
    const { root, repository, service, add } = await fixture();
    const seed = await add('Source 00');
    const ids = [seed.id];
    const seedDirectory = join(root, 'media/source', seed.id);
    const metadata = JSON.parse(
      await readFile(join(seedDirectory, 'meta.json'), 'utf8'),
    ) as Record<string, unknown>;
    // Reuse this tiny image fixture; concurrency reads do not need more decoders.
    for (let index = 1; index < CONTENT_LIMITS.loaderConcurrency + 2; index++) {
      const id = randomUUID();
      const directory = join(root, 'media/source', id);
      await mkdir(directory);
      await copyFile(
        join(seedDirectory, 'original.png'),
        join(directory, 'original.png'),
      );
      await writeFile(
        join(directory, 'meta.json'),
        JSON.stringify({
          ...metadata,
          id,
          displayName: `Source ${String(index).padStart(2, '0')}`,
        }),
      );
      await copyFile(
        join(root, '.foliohaven/media-inspections', `${seed.id}.json`),
        join(root, '.foliohaven/media-inspections', `${id}.json`),
      );
      ids.push(id);
    }
    let active = 0;
    let maximum = 0;
    const original = repository.withConsistentRead.bind(repository);
    const track: typeof repository.withConsistentRead = async <T>(
      fn: (session: ReadSession) => Promise<T>,
    ) =>
      original((session) =>
        fn({
          ...session,
          read: async (key) => {
            active++;
            maximum = Math.max(maximum, active);
            try {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return await session.read(key);
            } finally {
              active--;
            }
          },
        }),
      );
    vi.spyOn(repository, 'withConsistentRead').mockImplementation(track);
    const result = await service.list({ pageSize: '20' });
    expect(result.items.map((source) => source.id)).toEqual(ids);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(CONTENT_LIMITS.loaderConcurrency);
    expect(active).toBe(0);
  });

  it('finishes in-flight reads before closing a failed collection session', async () => {
    const { repository, service, add } = await fixture();
    const alpha = await add('Alpha');
    await add('Beta');
    await add('Gamma');
    const failure = new Error('Simulated metadata read failure');
    let active = 0;
    let completed = 0;
    let started = 0;
    const original = repository.withConsistentRead.bind(repository);
    const track: typeof repository.withConsistentRead = async <T>(
      fn: (session: ReadSession) => Promise<T>,
    ) =>
      original((session) =>
        fn({
          ...session,
          read: async (key) => {
            active++;
            started++;
            try {
              if (key.includes(alpha.id)) throw failure;
              await new Promise((resolve) => setTimeout(resolve, 15));
              return await session.read(key);
            } finally {
              active--;
              completed++;
            }
          },
        }),
      );
    vi.spyOn(repository, 'withConsistentRead').mockImplementation(track);
    await expect(service.list()).rejects.toBe(failure);
    expect(started).toBeGreaterThan(1);
    expect(completed).toBe(started);
    expect(active).toBe(0);
  });

  it('reads a cached page with one consistent session and preserves filtering, pagination and resources', async () => {
    const { repository, service, add } = await fixture();
    const beta = await add('Beta tools');
    const alpha = await add('Alpha tools');
    await add('Gamma notes');
    const expected = await Promise.all(
      [alpha, beta].map(async ({ id }) => (await service.get(id)).value),
    );
    const read = vi.spyOn(repository, 'withConsistentRead');
    expect(await service.list({ q: 'tools', pageSize: '2' })).toEqual({
      items: expected,
      total: 2,
      page: 1,
      pageSize: 2,
    });
    expect(read).toHaveBeenCalledOnce();
    read.mockClear();
    expect(await service.list({ page: '2', pageSize: '2' })).toMatchObject({
      total: 3,
      page: 2,
      pageSize: 2,
      items: [{ displayName: 'Gamma notes' }],
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it('decodes only an uncached source outside the reader and keeps the selected order', async () => {
    const { root, repository, add } = await fixture();
    const alpha = await add('Alpha');
    const beta = await add('Beta');
    await rm(join(root, '.foliohaven/media-inspections', beta.id + '.json'));
    let inReader = false;
    const original = repository.withConsistentRead.bind(repository);
    const track: typeof repository.withConsistentRead = async <T>(
      fn: (session: ReadSession) => Promise<T>,
    ) =>
      original(async (session) => {
        inReader = true;
        try {
          return await fn(session);
        } finally {
          inReader = false;
        }
      });
    vi.spyOn(repository, 'withConsistentRead').mockImplementation(track);
    const phases: { phase: string; inReader: boolean }[] = [];
    const reader = new MediaService({
      repositoryRoot: root,
      repository,
      onPhase: async (phase) => {
        phases.push({ phase, inReader });
      },
    });
    const fallback = vi.spyOn(reader, 'get');
    const page = await reader.list();
    expect(page.items.map(({ id }) => id)).toEqual([alpha.id, beta.id]);
    expect(page.items).toEqual([alpha, beta]);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(beta.id);
    expect(phases).toContainEqual({
      phase: 'inspection-required',
      inReader: true,
    });
    expect(phases.filter(({ phase }) => phase === 'slot-acquired')).toEqual([
      { phase: 'slot-acquired', inReader: false },
    ]);
  });

  it('rechecks encoded output bytes before exposing a processed asset', async () => {
    const { root, repository, service, add } = await fixture();
    const source = await add('Processed');
    const asset = await service.process(source.id);
    expect((await service.list()).items[0]?.asset).toEqual(asset);
    const binding = JSON.parse(
      await readFile(
        join(root, '.foliohaven/media-records', source.id + '.json'),
        'utf8',
      ),
    ) as { processingHash: string };
    const output = join(
      root,
      '.foliohaven/media',
      binding.processingHash,
      'image.webp',
    );
    const bytes = await readFile(output);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
    await writeFile(output, bytes);
    const read = vi.spyOn(repository, 'withConsistentRead');
    expect((await service.list()).items[0]).toMatchObject({
      id: source.id,
      asset: null,
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it('verifies earlier rows when metadata changes while reading another row', async () => {
    const { root, repository, add } = await fixture();
    const alpha = await add('Alpha');
    const beta = await add('Beta');
    await rm(join(root, '.foliohaven/media-inspections', beta.id + '.json'));
    const metaPath = join(root, 'media/source', alpha.id, 'meta.json');
    const metadata = JSON.parse(await readFile(metaPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const reader = new MediaService({
      repositoryRoot: root,
      repository,
      onPhase: async (phase, id) => {
        if (phase === 'inspection-required' && id === beta.id)
          await writeFile(
            metaPath,
            JSON.stringify({ ...metadata, displayName: 'Changed externally' }),
          );
      },
    });
    const fallback = vi.spyOn(reader, 'get');
    await expect(reader.list()).rejects.toMatchObject({
      code: 'EXTERNAL_CHANGE',
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not treat a missing original as an inspection-cache miss', async () => {
    const { root, service, add } = await fixture();
    const source = await add('Missing original');
    await rm(join(root, 'media/source', source.id, 'original.png'));
    const fallback = vi.spyOn(service, 'get');
    await expect(service.list()).rejects.toMatchObject({
      code: 'MEDIA_SOURCE_MISSING',
    });
    expect(fallback).not.toHaveBeenCalled();
  });
});
