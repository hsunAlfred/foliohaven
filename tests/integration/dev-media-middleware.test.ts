import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { MediaAsset } from '@foliohaven/core';
import { createDevMediaMiddleware } from '../../server/src/http/index.js';
import type { DevMediaContext } from '../../server/src/http/index.js';
import { FileRepository } from '../../server/src/files/index.js';
import { MediaService } from '../../server/src/media/index.js';
import type { NativeImageFactory } from '../../server/src/media/worker.js';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { sandbox } from '../fixtures/http/environment.mjs';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
let root = '';
let origin = '';
let server: ReturnType<typeof createServer> | undefined;
let media: MediaService;
let current: DevMediaContext;
let contextFailure = false;
let image: MediaAsset;
const streams: Readable[] = [];
const context = (assets: readonly MediaAsset[]): DevMediaContext => ({
  mediaManifest: { schemaVersion: 1, assets: [...assets] },
  routeManifest: {
    assets: assets.flatMap((asset) =>
      asset.outputs.map((output) => output.publicPath),
    ),
  },
});
const png = (width = 1280, height = 720, background = '#446655') =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
async function add(
  bytes: Buffer,
  filename = 'image.png',
  mimeType = 'image/png',
) {
  const staged = await media.stageSource(Readable.from([bytes]), {
    filename,
    mimeType,
  });
  const source = await media.register(staged);
  return media.process(source.value.id);
}
function trackOpenFiles() {
  const openVariant = MediaService.prototype.openVariant;
  return vi
    .spyOn(MediaService.prototype, 'openVariant')
    .mockImplementation(async function (
      this: MediaService,
      ...args: Parameters<MediaService['openVariant']>
    ) {
      const file = await openVariant.apply(this, args);
      streams.push(file.stream);
      return file;
    });
}
async function filesClosed() {
  await Promise.all(
    streams.map((stream) =>
      finished(stream, { cleanup: true }).catch(() => undefined),
    ),
  );
  expect(streams.every((stream) => stream.closed)).toBe(true);
}

beforeEach(async () => {
  root = await sandbox();
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  media = new MediaService({ repositoryRoot: root, repository });
  image = await add(await png());
  current = context([image]);
  contextFailure = false;
  const middleware = createDevMediaMiddleware({
    repositoryRoot: root,
    loadContext: async () => {
      if (contextFailure) throw new Error('PRIVATE_CONTEXT_FAILURE_SENTINEL');
      return current;
    },
  });
  server = createServer((request, response) => {
    middleware(request, response, () => {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('UNHANDLED_PATH');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture TCP address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.destroy();
  if (server) {
    const closed = new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
    server = undefined;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe('read-only Astro development media middleware', () => {
  it('serves every authorized image/srcset output with its actual MIME and supports HEAD and single ranges', async () => {
    trackOpenFiles();
    expect(
      image.outputs.map(({ publicPath, mimeType, width, height }) => ({
        variant: publicPath.split('/').at(-1),
        mimeType,
        width,
        height,
      })),
    ).toEqual([
      {
        variant: 'image.webp',
        mimeType: 'image/webp',
        width: 1280,
        height: 720,
      },
      {
        variant: 'image-480.webp',
        mimeType: 'image/webp',
        width: 480,
        height: 270,
      },
      {
        variant: 'image-768.webp',
        mimeType: 'image/webp',
        width: 768,
        height: 432,
      },
      {
        variant: 'image-social.webp',
        mimeType: 'image/webp',
        width: 1200,
        height: 630,
      },
      {
        variant: 'image-social-crop.webp',
        mimeType: 'image/webp',
        width: 1200,
        height: 630,
      },
      { variant: 'favicon.png', mimeType: 'image/png', width: 32, height: 32 },
    ]);
    for (const output of image.outputs) {
      const response = await fetch(origin + output.publicPath);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(output.mimeType);
      expect(response.headers.get('content-length')).toBe(
        String(output.byteSize),
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      const encoded = Buffer.from(await response.arrayBuffer());
      expect(encoded.byteLength).toBe(output.byteSize);
      expect((await sharp(encoded).metadata()).format).toBe(
        output.mimeType === 'image/png' ? 'png' : 'webp',
      );
      const decoded = await sharp(encoded)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(decoded.info.width).toBe(output.width);
      expect(decoded.info.height).toBe(output.height);
      expect(decoded.data.byteLength).toBeGreaterThan(0);
    }
    const path = `/media/${image.id}/image.webp`;
    const expected = image.outputs.find((output) => output.publicPath === path);
    if (!expected) throw new Error('No standard image output');
    const full = Buffer.from(await (await fetch(origin + path)).arrayBuffer());
    const head = await fetch(origin + path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(expected.byteSize));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    for (const [range, bytes] of [
      ['bytes=1-5', full.subarray(1, 6)],
      ['bytes=-8', full.subarray(-8)],
      ['bytes=5-', full.subarray(5)],
    ] as const) {
      const response = await fetch(origin + path, {
        headers: { Range: range },
      });
      expect(response.status).toBe(206);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
    for (const range of ['bytes=99999999-', 'bytes=0-1,4-5', 'bytes=-0']) {
      const response = await fetch(origin + path, {
        headers: { Range: range },
      });
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe(
        `bytes */${expected.byteSize}`,
      );
      expect(await response.text()).toBe('MEDIA_RANGE_NOT_SATISFIABLE\n');
    }
    await filesClosed();
  });

  it('requires the current route assets and manifest output, rejects unknown/private paths and methods, and fails closed on invalid context', async () => {
    const path = `/media/${image.id}/image.webp`;
    current = { ...current, routeManifest: { assets: [] } };
    const unreachable = await fetch(origin + path);
    expect(unreachable.status).toBe(404);
    expect(await unreachable.text()).toBe('MEDIA_NOT_FOUND\n');
    current = {
      mediaManifest: { schemaVersion: 1, assets: [] },
      routeManifest: { assets: [path] },
    };
    expect((await fetch(origin + path)).status).toBe(404);
    current = context([image]);
    for (const invalid of [
      `/media/${image.id}/original.png`,
      `/media/${image.id}/unknown.webp`,
      '/media/00000000-0000-4000-8000-000000000000/image.webp',
      `/media/source/${image.id}/original.png`,
      '/media/%2e%2e%2f.foliohaven/index.json',
    ]) {
      const response = await fetch(origin + invalid);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('MEDIA_NOT_FOUND\n');
    }
    const post = await fetch(origin + path, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(await (await fetch(origin + '/api/v1/health')).text()).toBe(
      'UNHANDLED_PATH',
    );
    contextFailure = true;
    const invalidContext = await fetch(origin + path);
    expect(invalidContext.status).toBe(503);
    const body = await invalidContext.text();
    expect(body).toBe('DEV_MEDIA_UNAVAILABLE\n');
    expect(body).not.toContain(root);
    expect(body).not.toContain('PRIVATE_CONTEXT_FAILURE_SENTINEL');
    contextFailure = false;
    expect((await fetch(origin + path)).status).toBe(200);
  });

  it('rejects newer source bytes until the current manifest matches and uses only the authorized size in 416', async () => {
    trackOpenFiles();
    const path = `/media/${image.id}/image.webp`;
    const oldOutput = image.outputs.find(
      (output) => output.publicPath === path,
    );
    if (!oldOutput) throw new Error('No original output');
    await writeFile(
      join(root, `media/source/${image.id}/original.png`),
      await png(64, 32, '#aa2255'),
    );
    const newer = await media.process(image.id);
    const newOutput = newer.outputs.find(
      (output) => output.publicPath === path,
    );
    if (!newOutput) throw new Error('No replacement output');
    expect(newOutput.sha256).not.toBe(oldOutput.sha256);
    expect(newOutput.byteSize).not.toBe(oldOutput.byteSize);
    const stale = await fetch(origin + path);
    expect(stale.status).toBe(503);
    expect(await stale.text()).toBe('DEV_MEDIA_UNAVAILABLE\n');
    const invalidRange = await fetch(origin + path, {
      headers: { Range: 'bytes=999999999-' },
    });
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get('content-range')).toBe(
      `bytes */${oldOutput.byteSize}`,
    );
    current = context([newer]);
    const updated = await fetch(origin + path);
    expect(updated.status).toBe(200);
    expect((await updated.arrayBuffer()).byteLength).toBe(newOutput.byteSize);
    current = context([]);
    expect((await fetch(origin + path)).status).toBe(404);
    await filesClosed();
  });

  it('serves generated video and poster outputs with WebM ranges', async () => {
    const source = join(root, 'tiny.webm');
    await runControlledProcess({
      command: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:size=64x48:rate=10',
        '-t',
        '0.3',
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-threads',
        '1',
        '-y',
        source,
      ],
      cwd: root,
      timeoutMs: 20_000,
    });
    const video = await add(await readFile(source), 'tiny.webm', 'video/webm');
    current = context([image, video]);
    const movie = await fetch(origin + `/media/${video.id}/video.webm`);
    expect(movie.status).toBe(200);
    expect(movie.headers.get('content-type')).toBe('video/webm');
    const bytes = Buffer.from(await movie.arrayBuffer());
    const range = await fetch(origin + `/media/${video.id}/video.webm`, {
      headers: { Range: 'bytes=-8' },
    });
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(-8));
    const poster = await fetch(origin + `/media/${video.id}/poster.webp`);
    expect(poster.status).toBe(200);
    expect(poster.headers.get('content-type')).toBe('image/webp');
    expect((await poster.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('closes an already opened file when the client disconnects before streaming ownership transfers', async () => {
    const original = MediaService.prototype.openVariant;
    let release: () => void = () => undefined;
    let opened: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(MediaService.prototype, 'openVariant').mockImplementation(
      async function (
        this: MediaService,
        ...args: Parameters<MediaService['openVariant']>
      ) {
        const file = await original.apply(this, args);
        streams.push(file.stream);
        opened();
        await gate;
        return file;
      },
    );
    const disconnected = new Promise<void>((resolve) =>
      server?.once('request', (_request, response) =>
        response.once('close', resolve),
      ),
    );
    const client = httpRequest(origin + `/media/${image.id}/image.webp`);
    client.on('error', () => undefined);
    client.end();
    try {
      await ready;
      client.destroy();
      await disconnected;
    } finally {
      client.destroy();
      release();
    }
    await filesClosed();
  });
});
