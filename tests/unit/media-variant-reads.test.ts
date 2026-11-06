import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FileRepository } from '../../server/src/files/index.js';
import type { ReadSession } from '../../server/src/files/types.js';
import { MediaService } from '../../server/src/media/index.js';
import * as mediaFiles from '../../server/src/media/files.js';
import type { NativeImageFactory } from '../../server/src/media/worker.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(durable = false) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-media-variant-'));
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
  const source = (
    await service.register(
      await service.stageSource(Readable.from([bytes]), {
        filename: 'image.png',
        mimeType: 'image/png',
        displayName: 'Variant',
      }),
    )
  ).value;
  const asset = await service.process(
    source.id,
    durable ? { jobId: randomUUID() } : {},
  );
  const bindingPath = join(root, '.alfred/media-records', source.id + '.json');
  const { processingHash } = JSON.parse(
    await readFile(bindingPath, 'utf8'),
  ) as { processingHash: string };
  return {
    root,
    repository,
    service,
    id: source.id,
    asset,
    bindingPath,
    metadataPath: join(root, 'media/source', source.id, 'meta.json'),
    originalPath: join(root, 'media/source', source.id, 'original.png'),
    inspectionPath: join(
      root,
      '.alfred/media-inspections',
      source.id + '.json',
    ),
    outputPath: (variant: string) =>
      join(root, '.alfred/media', processingHash, variant),
  };
}

async function consume(stream: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('verified media variant reads', () => {
  it('serves completed bytes with one consistent read and no source inspection', async () => {
    const { repository, service, id, inspectionPath } = await fixture();
    await rm(inspectionPath);
    const read = vi.spyOn(repository, 'withConsistentRead');
    const get = vi.spyOn(service, 'get');
    const file = await service.openVariant(id, 'image.webp');
    const bytes = await consume(file.stream);
    expect(read).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      file.output.sha256,
    );
    expect(file.status).toBe(200);

    const range = await service.openVariant(id, 'image.webp', 'bytes=0-4');
    expect(range.status).toBe(206);
    expect(await consume(range.stream)).toEqual(bytes.subarray(0, 5));
    await expect(
      service.openVariant(id, 'image.webp', `bytes=${bytes.length}-`),
    ).rejects.toMatchObject({
      code: 'MEDIA_RANGE_NOT_SATISFIABLE',
      status: 416,
    });
  });

  it('uses durable completion evidence when the binding projection is absent', async () => {
    const { service, id, bindingPath, inspectionPath } = await fixture(true);
    await rm(bindingPath);
    await rm(inspectionPath);
    const file = await service.openVariant(id, 'image.webp');
    expect((await consume(file.stream)).length).toBe(file.output.byteSize);
  });

  it('rejects an unbound asset without entering the decoder retry path', async () => {
    const { service, id, bindingPath, inspectionPath } = await fixture();
    await rm(bindingPath);
    await rm(inspectionPath);
    const get = vi.spyOn(service, 'get');
    await expect(service.openVariant(id, 'image.webp')).rejects.toMatchObject({
      code: 'MEDIA_NOT_FOUND',
      status: 404,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    'metadata',
    'original',
    'requested output',
    'another output',
  ] as const)(
    'rejects same-size changes to %s before exposing completed bytes',
    async (target) => {
      const { service, id, asset, metadataPath, originalPath, outputPath } =
        await fixture();
      if (target === 'metadata') {
        const metadata = await readFile(metadataPath, 'utf8');
        await writeFile(metadataPath, metadata.replace('Variant', 'Altered'));
      } else {
        const variant =
          target === 'another output'
            ? asset.outputs
                .find(({ publicPath }) => !publicPath.endsWith('/image.webp'))
                ?.publicPath.split('/')
                .at(-1)
            : 'image.webp';
        if (variant === undefined) throw new Error('Missing alternate output');
        const path = target === 'original' ? originalPath : outputPath(variant);
        const bytes = await readFile(path);
        bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
        await writeFile(path, bytes);
      }
      await expect(service.openVariant(id, 'image.webp')).rejects.toMatchObject(
        {
          code: 'MEDIA_NOT_FOUND',
          status: 404,
        },
      );
    },
  );

  it('still requires a readable original for a completed binding', async () => {
    const { service, id, originalPath } = await fixture();
    await rm(originalPath);
    await expect(service.openVariant(id, 'image.webp')).rejects.toMatchObject({
      code: 'MEDIA_SOURCE_MISSING',
    });
  });

  it.each([
    ['metadata', 'RESOURCE_SYMLINK'],
    ['original', 'MEDIA_SOURCE_MISSING'],
    ['output', 'MEDIA_NOT_FOUND'],
  ] as const)('rejects a symlink replacing %s', async (target, code) => {
    const { root, service, id, metadataPath, originalPath, outputPath } =
      await fixture();
    const path =
      target === 'metadata'
        ? metadataPath
        : target === 'original'
          ? originalPath
          : outputPath('image.webp');
    const preserved = join(root, 'preserved-file');
    await rename(path, preserved);
    await symlink(preserved, path);
    await expect(service.openVariant(id, 'image.webp')).rejects.toMatchObject({
      code,
    });
  });

  it('finishes dependency verification before opening a response stream', async () => {
    const { repository, service, id, metadataPath } = await fixture();
    const metadata = await readFile(metadataPath, 'utf8');
    const original = repository.withConsistentRead.bind(repository);
    const mutateAfterRead: typeof repository.withConsistentRead = async <T>(
      fn: (session: ReadSession) => Promise<T>,
    ) =>
      original(async (session) => {
        const value = await fn(session);
        await writeFile(metadataPath, metadata.replace('Variant', 'Altered'));
        return value;
      });
    vi.spyOn(repository, 'withConsistentRead').mockImplementation(
      mutateAfterRead,
    );
    const open = vi.spyOn(mediaFiles, 'openMediaVariant');
    await expect(service.openVariant(id, 'image.webp')).rejects.toMatchObject({
      code: 'EXTERNAL_CHANGE',
    });
    expect(open).not.toHaveBeenCalled();
  });
});
