import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { FileRepository } from '../../server/dist/files/index.js';
import { MediaService } from '../../server/dist/media/index.js';
import { acquireFileLease } from '../../server/dist/runtime/lease.js';
import { runControlledProcess } from '../../server/dist/runtime/process.js';
import { buildProcessEnvironment } from '../../server/dist/runtime/environment.js';
import { MediaSourceResourceSchema, mediaImageGroup } from '@foliohaven/core';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(
  options: Partial<ConstructorParameters<typeof MediaService>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-media-'));
  roots.push(root);
  await mkdir(join(root, 'content/articles'), { recursive: true });
  await mkdir(join(root, 'media/source'), { recursive: true });
  await writeFile(
    join(root, 'content/site.json'),
    JSON.stringify({
      siteName: 'Media Test',
      siteDescription: 'Media test',
      siteUrl: 'https://example.invalid/',
      author: { name: 'Test' },
    }),
  );
  await writeFile(join(root, 'content/categories.json'), '[]');
  await writeFile(join(root, 'content/tags.json'), '[]');
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  const service = new MediaService({
    repositoryRoot: root,
    repository,
    ...options,
  });
  return { root, repository, service };
}
async function png(width = 1400, height = 700) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 40, g: 100, b: 180, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
}
async function add(
  service: MediaService,
  bytes: Buffer,
  filename = 'source.png',
  mimeType = 'image/png',
) {
  const staged = await service.stageSource(Readable.from([bytes]), {
    filename,
    mimeType,
  });
  return service.register(staged);
}
async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function videoSource(root: string, audio = true) {
  const path = join(root, 'fixture.mp4');
  await runControlledProcess({
    command: 'ffmpeg',
    args: [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x90:rate=12',
      ...(audio
        ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100']
        : []),
      '-t',
      '0.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-shortest'] : []),
      path,
    ],
    cwd: root,
    env: buildProcessEnvironment(),
    timeoutMs: 30_000,
  });
  return readFile(path);
}

describe('MEDIA-01: real source transactions, Sharp and FFmpeg', () => {
  it('registers atomically with replay response, ETag and Location, then makes real WebP variants', async () => {
    const { root, repository, service } = await fixture();
    const bytes = await png();
    const staged = await service.stageSource(Readable.from([bytes]), {
      filename: '透明.png',
      mimeType: 'image/png',
    });
    const result = await service.register(staged, {
      id: randomUUID(),
      key: randomUUID(),
      payloadHash: staged.payloadHash,
      httpStatus: 201,
    });
    expect(MediaSourceResourceSchema.safeParse(result.value).success).toBe(
      true,
    );
    expect(result.value.asset).toBeNull();
    expect(result.value.displayName).toBe('透明.png');
    const receipts = await repository.listCommittedOperations();
    expect(receipts[0]?.response).toEqual(result.value);
    expect(receipts[0]?.headers).toEqual({
      ETag: result.etag,
      Location: result.location,
    });
    const asset = await service.process(result.value.id);
    expect(
      asset.outputs
        .filter((output) => mediaImageGroup(output.publicPath) === 'responsive')
        .map((output) => output.width),
    ).toEqual([1280, 480, 768]);
    const ready = await service.get(result.value.id);
    expect(ready.etag).not.toBe(result.etag);
    expect(ready.inputRevision).toBe(result.inputRevision);
    expect(ready.value.asset).toEqual(asset);
    for (const output of asset.outputs) {
      const file = await service.openVariant(
        asset.id,
        output.publicPath.split('/').at(-1) ?? '',
      );
      const encoded = await collect(file.stream);
      const metadata = await sharp(encoded).metadata();
      expect(metadata.format).toBe(
        output.mimeType === 'image/png' ? 'png' : 'webp',
      );
      expect(metadata.width).toBe(output.width);
      expect(metadata.height).toBe(output.height);
      if (mediaImageGroup(output.publicPath) !== 'social')
        expect(metadata.hasAlpha).toBe(true);
      expect(metadata.orientation).toBeUndefined();
    }
    expect(
      await readFile(join(root, 'media/source', asset.id, 'original.png')),
    ).toEqual(bytes);
    expect(await readdir(join(root, '.foliohaven/staging'))).toEqual([]);
    expect(
      await repository.withConsistentRead((session) =>
        service.manifest(undefined, session),
      ),
    ).toEqual({ schemaVersion: 1, assets: [asset] });
  });
  it('lists through Core metadata filtering and pagination without acquiring decoder slots for registered originals', async () => {
    const { root, repository, service } = await fixture();
    const bytes = await png(32, 16);
    const ids: string[] = [];
    for (const displayName of ['Ｂｅｔａ notes', 'Alpha tools', 'Beta tools']) {
      const registered = await service.register(
        await service.stageSource(Readable.from([bytes]), {
          filename: 'sample.png',
          mimeType: 'image/png',
          displayName,
        }),
      );
      ids.push(registered.value.id);
    }
    const first = await acquireFileLease({
      root,
      name: 'media-image-0',
      owner: 'media-test',
    });
    const second = await acquireFileLease({
      root,
      name: 'media-image-1',
      owner: 'media-test',
    });
    const reader = new MediaService({
      repositoryRoot: root,
      repository,
      lockTimeoutMs: 20,
    });
    try {
      const page = await reader.list({
        q: ' BETA ',
        type: 'image',
        page: '2',
        pageSize: '1',
      });
      expect(page).toMatchObject({ total: 2, page: 2, pageSize: 1 });
      expect(page.items.map((item) => item.displayName)).toEqual([
        'Beta tools',
      ]);
      expect(page.items[0]?.asset).toBeNull();
      expect(
        (await reader.list({ q: 'beta tools' })).items.map((item) => item.id),
      ).toEqual([ids[2]]);
      expect((await reader.list({ type: 'video' })).total).toBe(0);
      expect((await reader.get(ids[0] ?? '')).value.displayName).toBe(
        'Ｂｅｔａ notes',
      );
    } finally {
      await first?.release();
      await second?.release();
    }
  });
  it('corrects EXIF orientation, strips metadata and never enlarges small inputs', async () => {
    const { service } = await fixture();
    const bytes = await sharp({
      create: { width: 20, height: 40, channels: 3, background: 'red' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const source = await add(service, bytes, 'orientation.jpg', 'image/jpeg');
    expect(source.value).toMatchObject({ width: 40, height: 20 });
    const asset = await service.process(source.value.id);
    expect(
      asset.outputs.filter(
        (output) => mediaImageGroup(output.publicPath) === 'responsive',
      ),
    ).toHaveLength(1);
    expect(asset.outputs[0]).toMatchObject({ width: 40, height: 20 });
    const encoded = await collect(
      (await service.openVariant(asset.id, 'image.webp')).stream,
    );
    expect((await sharp(encoded).metadata()).orientation).toBeUndefined();
  });
  it.each([true, false])(
    'transcodes actual VP9, optional Opus and WebP poster; audio=%s',
    async (audio) => {
      const { root, service } = await fixture();
      const source = await add(
        service,
        await videoSource(root, audio),
        'short.mp4',
        'video/mp4',
      );
      const asset = await service.process(source.value.id);
      expect(asset.outputs.map((output) => output.mimeType)).toEqual([
        'video/webm',
        'image/webp',
      ]);
      const file = await service.openVariant(
        asset.id,
        'video.webm',
        'bytes=0-15',
      );
      expect(file.status).toBe(206);
      expect((await collect(file.stream)).length).toBe(16);
      const full = await collect(
        (await service.openVariant(asset.id, 'video.webm')).stream,
      );
      const path = join(root, 'check.webm');
      await writeFile(path, full);
      const probe = await runControlledProcess({
        command: 'ffprobe',
        args: [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,width,height,sample_aspect_ratio,avg_frame_rate,channels,sample_rate',
          '-of',
          'json',
          path,
        ],
        cwd: root,
        timeoutMs: 10_000,
      });
      const streams = (
        JSON.parse(probe.stdout.toString()) as {
          streams: {
            codec_name: string;
            channels?: number;
            sample_rate?: string;
          }[];
        }
      ).streams;
      expect(streams[0]?.codec_name).toBe('vp9');
      expect(streams.some((stream) => stream.codec_name === 'opus')).toBe(
        audio,
      );
      if (audio)
        expect(
          streams.find((stream) => stream.codec_name === 'opus'),
        ).toMatchObject({ channels: 2, sample_rate: '48000' });
    },
  );
  it('projects identical bytes to separate IDs while sharing one verified cache', async () => {
    const { root, service } = await fixture();
    const bytes = await png(64, 32);
    const first = await add(service, bytes);
    const second = await add(service, bytes);
    const a = await service.process(first.value.id);
    const b = await service.process(second.value.id);
    expect(a.id).not.toBe(b.id);
    expect(a.outputs[0]?.sha256).toBe(b.outputs[0]?.sha256);
    expect(b.outputs[0]?.publicPath).toContain(second.value.id);
    expect(
      (await readdir(join(root, '.foliohaven/media'))).filter((name) =>
        /^[a-f0-9]{64}$/u.test(name),
      ),
    ).toHaveLength(1);
  });
  it('rebuilds corrupt cache and rejects a source changed immediately before binding', async () => {
    const { root, repository, service } = await fixture();
    const source = await add(service, await png(64, 32));
    const first = await service.process(source.value.id);
    const hash = (await readdir(join(root, '.foliohaven/media')))[0];
    expect(hash).toBeDefined();
    await writeFile(
      join(root, '.foliohaven/media', hash ?? '', 'image.webp'),
      'broken',
    );
    expect((await service.get(source.value.id)).value.asset).toBeNull();
    expect((await service.process(source.value.id)).outputs[0]?.sha256).toBe(
      first.outputs[0]?.sha256,
    );
    const changing = new MediaService({
      repositoryRoot: root,
      repository,
      onPhase: async (phase, id) => {
        if (phase === 'before-binding') {
          const path = join(root, 'media/source', id, 'meta.json');
          const metadata = JSON.parse(await readFile(path, 'utf8')) as Record<
            string,
            unknown
          >;
          await writeFile(
            path,
            JSON.stringify({ ...metadata, displayName: 'Changed externally' }),
          );
        }
      },
    });
    await expect(changing.process(source.value.id)).rejects.toMatchObject({
      code: 'MEDIA_SOURCE_CHANGED',
      status: 412,
    });
    expect((await service.get(source.value.id)).value.asset).toBeNull();
  });
  it('keeps source revisions, PUT clearing poster and source ETags consistent', async () => {
    const { root, service } = await fixture();
    const bytes = await videoSource(root, false);
    const staged = await service.stageSource(Readable.from([bytes]), {
      filename: 'poster.mp4',
      mimeType: 'video/mp4',
      posterTimeSeconds: 0.1,
    });
    const source = await service.register(staged);
    await service.process(source.value.id);
    const ready = await service.get(source.value.id);
    expect(ready.inputRevision).toBe(source.inputRevision);
    await expect(
      service.update(
        source.value.id,
        { displayName: 'Stale before clearing' },
        source.etag,
      ),
    ).rejects.toMatchObject({ status: 412, etag: ready.etag });
    const updated = await service.update(
      source.value.id,
      { displayName: 'Default poster' },
      ready.etag,
    );
    expect(updated.value.posterTimeSeconds).toBeNull();
    expect(updated.etag).not.toBe(source.etag);
    expect(updated.value.asset).toBeNull();
    await expect(
      service.update(source.value.id, { displayName: 'Old' }, source.etag),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      service.update(source.value.id, { displayName: 'Missing' }, undefined),
    ).rejects.toMatchObject({ status: 428 });
    await expect(
      service.update(
        source.value.id,
        { displayName: 'Bad time', posterTimeSeconds: 999 },
        updated.etag,
      ),
    ).rejects.toMatchObject({ code: 'MEDIA_POSTER_TIME' });
  });
  it('deletes only unreferenced sources into recoverable trash, including draft references', async () => {
    const { root, repository, service } = await fixture();
    const source = await add(service, await png(20, 10));
    const id = source.value.id;
    await mkdir(join(root, 'content/articles/draft'), { recursive: true });
    await writeFile(
      join(root, 'content/articles/draft/meta.json'),
      JSON.stringify({ status: 'draft' }),
    );
    await writeFile(
      join(root, 'content/articles/draft/content.html'),
      `<img src="/media/${id}/image.webp" alt="">`,
    );
    await expect(service.remove(id, source.etag)).rejects.toMatchObject({
      code: 'MEDIA_IN_USE',
      status: 409,
    });
    for (const content of [
      `<img src="/media/${id}/image.webp?draft=1" alt="">`,
      `<picture><source srcset="/media/${id}/image.webp 0w"><img src="/media/${id}/unfinished" alt=""></picture>`,
      `<video poster="https://example.invalid/media/${id}/poster.webp#pending"></video>`,
      `<img src="/media/%${id.charCodeAt(0).toString(16)}${id.slice(1)}/image.webp" alt="">`,
      `<img src="/media/${id}/unfinished%" alt="">`,
    ]) {
      await writeFile(
        join(root, 'content/articles/draft/content.html'),
        content,
      );
      await expect(service.remove(id, source.etag)).rejects.toMatchObject({
        code: 'MEDIA_IN_USE',
        status: 409,
      });
    }
    await rm(join(root, 'content/articles/draft'), { recursive: true });
    await service.remove(id, source.etag);
    await expect(service.get(id)).rejects.toMatchObject({ status: 404 });
    expect(
      (await repository.listRecoveries()).some((item) => item.kind === 'trash'),
    ).toBe(true);
  });
  it('processes only explicitly reachable sources and fails impossible variants', async () => {
    const { service } = await fixture();
    const publicSource = await add(service, await png(64, 32));
    const draftSource = await add(service, await png(32, 16));
    const result = await service.processReferences([
      `/media/${publicSource.value.id}/image.webp`,
    ]);
    expect(result.assets.map((asset) => asset.id)).toEqual([
      publicSource.value.id,
    ]);
    expect(JSON.stringify(result)).not.toContain(draftSource.value.id);
    await expect(
      service.processReferences([
        `/media/${publicSource.value.id}/image-999.webp`,
      ]),
    ).rejects.toMatchObject({ code: 'MEDIA_VARIANT_MISSING' });
  });
});

describe('MEDIA-02: failure boundaries and actual resource ownership', () => {
  it.each([
    ['wrong.jpg', 'image/jpeg'],
    ['image.png', 'image/jpeg'],
  ])(
    'rejects extension/MIME mismatch %s %s without registered or staged files',
    async (filename, mimeType) => {
      const { root, service } = await fixture();
      await expect(
        add(service, await png(16, 8), filename, mimeType),
      ).rejects.toMatchObject({ status: 422 });
      expect(await readdir(join(root, 'media/source'))).toEqual([]);
      expect(await readdir(join(root, '.foliohaven/staging'))).toEqual([]);
    },
  );
  it('rejects fake SVG, unsupported formats, pixel/dimension and byte excess', async () => {
    const { root, service } = await fixture();
    await expect(
      add(service, Buffer.from('<svg></svg>')),
    ).rejects.toMatchObject({ code: 'MEDIA_FORMAT_UNSUPPORTED' });
    await expect(
      add(service, Buffer.from('GIF89a'), 'animation.gif', 'image/gif'),
    ).rejects.toMatchObject({ code: 'MEDIA_FORMAT_UNSUPPORTED' });
    await expect(add(service, await png(12001, 1))).rejects.toMatchObject({
      code: 'MEDIA_DIMENSIONS_EXCEEDED',
    });
    await expect(
      service.stageSource(Readable.from([Buffer.alloc(25 * 1024 * 1024 + 1)]), {
        filename: 'large.png',
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(await readdir(join(root, '.foliohaven/staging'))).toEqual([]);
  });
  it('validates all Range forms, rejects unsatisfiable/multiple requests and private filenames', async () => {
    const { service } = await fixture();
    const source = await add(service, await png(16, 8));
    await service.process(source.value.id);
    const full = await collect(
      (await service.openVariant(source.value.id, 'image.webp')).stream,
    );
    expect(
      await collect(
        (await service.openVariant(source.value.id, 'image.webp', 'bytes=-5'))
          .stream,
      ),
    ).toEqual(full.subarray(-5));
    expect(
      await collect(
        (await service.openVariant(source.value.id, 'image.webp', 'bytes=5-'))
          .stream,
      ),
    ).toEqual(full.subarray(5));
    for (const range of [
      'bytes=999999-',
      'bytes=5-1',
      'bytes=0-1,3-4',
      'bytes=-0',
      'items=0-1',
    ])
      await expect(
        service.openVariant(source.value.id, 'image.webp', range),
      ).rejects.toMatchObject({
        status: 416,
        contentRange: `bytes */${full.length}`,
      });
    for (const variant of [
      'original.png',
      '../../site.json',
      'image.webp/extra',
    ])
      await expect(
        service.openVariant(source.value.id, variant),
      ).rejects.toMatchObject({ status: 404 });
  });
  it('honors true worker timeout and cancellation without leaving partial cache or resource leases', async () => {
    const { root, repository, service } = await fixture();
    const source = await add(service, await png(64, 32));
    const short = new MediaService({
      repositoryRoot: root,
      repository,
      deadlines: { imageMs: 1 },
    });
    await expect(short.process(source.value.id)).rejects.toMatchObject({
      code: 'MEDIA_TIMEOUT',
    });
    const controller = new AbortController();
    const cancelling = new MediaService({
      repositoryRoot: root,
      repository,
      onPhase: (phase) => {
        if (phase === 'before-encode') controller.abort();
      },
    });
    await expect(
      cancelling.process(source.value.id, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'MEDIA_CANCELLED' });
    for (let index = 0; index < 2; index++) {
      const lease = await acquireFileLease({
        root,
        name: `media-image-${index}`,
        owner: 'media-test',
        nonBlocking: true,
      });
      expect(lease).not.toBeNull();
      await lease?.release();
    }
    expect(await readdir(join(root, '.foliohaven/media-work'))).toEqual([]);
    expect(
      (await readdir(join(root, '.foliohaven/media'))).filter((name) =>
        name.endsWith('.part'),
      ),
    ).toEqual([]);
  });
});
