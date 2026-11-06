import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import type { MediaOutput } from '@foliohaven/core';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import type * as Renderer from '../../server/src/build/render/index.js';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import * as ProcessRunner from '../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../server/src/runtime/environment.js';
import { withSiteDev } from '../fixtures/site/dev-server.js';
import {
  captureSiteWorkspaceSources,
  siteWorkspace,
  publishedImageId,
  draftImageId,
  draftSentinel,
} from '../fixtures/build/site-workspace.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const videoId = '34567890-1234-4234-8234-123456789abc';
const unusedImageId = '45678901-1234-4345-8345-123456789abc';
const imagePath = `/media/${publishedImageId}/image.webp`;
const videoPath = `/media/${videoId}/video.webm`;
const posterPath = `/media/${videoId}/poster.webp`;
const reportDirectory = fileURLToPath(
  new URL('../../.alfred/reports/astro-dev-media-20261024/', import.meta.url),
);
const observations: {
  method: string;
  path: string;
  status: number;
}[] = [];
const decodedViewports: {
  width: number;
  currentSrc: string;
  naturalWidth: number;
  videoWidth: number;
}[] = [];
let serverNumber = 0;
let sources: Awaited<ReturnType<typeof captureSiteWorkspaceSources>>;
let environment: Awaited<ReturnType<typeof mediaWorkspace>>;

async function mediaWorkspace(sourceRoot: string) {
  const fixture = await siteWorkspace(false, sourceRoot);
  try {
    const contextDirectory = join(fixture.snapshot, '.alfred/render');
    const renderer = (await import(
      pathToFileURL(join(fixture.snapshot, 'server/dist/build/render/index.js'))
        .href
    )) as typeof Renderer;
    const refresh = () =>
      renderer.prepareRenderContext({
        repositoryRoot: fixture.snapshot,
        contextDirectory,
        coordinationRoot: fixture.root,
      });
    for (const [id, kind, source] of [
      [videoId, 'video', 'original.webm'],
      [unusedImageId, 'image', 'original.png'],
    ] as const) {
      const directory = join(fixture.snapshot, 'media/source', id);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'meta.json'),
        JSON.stringify({ schemaVersion: 1, id, kind, source }),
      );
    }
    await runControlledProcess({
      command: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:size=96x64:rate=10',
        '-t',
        '0.4',
        '-c:v',
        'libvpx-vp9',
        '-threads',
        '1',
        '-an',
        '-y',
        join(fixture.snapshot, 'media/source', videoId, 'original.webm'),
      ],
      cwd: fixture.snapshot,
      env: buildProcessEnvironment(),
      timeoutMs: 20_000,
    });
    await writeFile(
      join(fixture.snapshot, 'media/source', unusedImageId, 'original.png'),
      await sharp({
        create: {
          width: 80,
          height: 40,
          channels: 3,
          background: '#91734e',
        },
      })
        .png()
        .toBuffer(),
    );
    const articleDirectory = join(fixture.snapshot, 'content/articles/entry-1');
    const originalBody = await readFile(
      join(articleDirectory, 'content.html'),
      'utf8',
    );
    const body = `${originalBody}\n<video controls preload="metadata" poster="${posterPath}"><source src="${videoPath}" type="video/webm"></video>`;
    await writeFile(join(articleDirectory, 'content.html'), body);
    const meta = await readFile(join(articleDirectory, 'meta.json'), 'utf8');
    const site = await readFile(
      join(fixture.snapshot, 'content/site.json'),
      'utf8',
    );
    const prepared = await refresh();
    // These private sources have real completed outputs. Denial must therefore
    // come from public reachability rather than a coincidentally absent cache.
    for (const id of [draftImageId, unusedImageId]) {
      const asset = await prepared.mediaService.process(id);
      expect(asset.outputs.length).toBeGreaterThan(0);
      const file = await prepared.mediaService.openVariant(id, 'image.webp');
      const chunks: Buffer[] = [];
      for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
    }
    expect(prepared.manifest.assets.map((asset) => asset.id).sort()).toEqual(
      [publishedImageId, videoId].sort(),
    );
    return {
      ...fixture,
      renderer,
      refresh,
      prepared,
      contextDirectory,
      articleDirectory,
      originalBody,
      body,
      meta,
      site,
    };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

beforeAll(async () => {
  sources = await captureSiteWorkspaceSources();
  environment = await mediaWorkspace(sources.root);
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
});
afterAll(async () => {
  try {
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(reportDirectory, 'http-observations.json'),
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          observations,
          decodedViewports,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  } finally {
    try {
      await environment?.cleanup();
    } finally {
      await sources?.cleanup();
    }
  }
});

async function withMediaDev(work: (origin: string) => Promise<void>) {
  const current = ++serverNumber;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const original = ProcessRunner.runControlledProcess;
  const spy = vi
    .spyOn(ProcessRunner, 'runControlledProcess')
    .mockImplementation((options) => {
      if (
        options.cwd !== environment.snapshot ||
        !options.args.includes('astro')
      )
        return original(options);
      return original({
        ...options,
        onOutput: (stream, chunk) => {
          (stream === 'stdout' ? stdout : stderr).push(Buffer.from(chunk));
          options.onOutput?.(stream, chunk);
        },
      });
    });
  try {
    await withSiteDev(environment.snapshot, work);
  } finally {
    spy.mockRestore();
    await writeFile(
      join(reportDirectory, `astro-${current}.stdout.log`),
      Buffer.concat(stdout),
      { mode: 0o600 },
    );
    await writeFile(
      join(reportDirectory, `astro-${current}.stderr.log`),
      Buffer.concat(stderr),
      { mode: 0o600 },
    );
  }
}

async function call(
  origin: string,
  path: string,
  options: {
    method?: 'GET' | 'HEAD';
    range?: string;
  } = {},
) {
  const url = new URL(origin);
  const method = options.method ?? 'GET';
  const response = await new Promise<{
    status: number;
    headers: Readonly<Record<string, string | string[] | undefined>>;
    bytes: Buffer;
  }>((resolve, reject) => {
    const pending = request(
      {
        hostname: url.hostname,
        port: url.port,
        method,
        // Keep raw encoded traversal intact instead of URL-normalizing it.
        path,
        headers: options.range === undefined ? {} : { Range: options.range },
        signal: AbortSignal.timeout(10_000),
      },
      (incoming) => {
        const collect = async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          return {
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            bytes: Buffer.concat(chunks),
          };
        };
        void collect().then(resolve, reject);
      },
    );
    pending.once('error', reject);
    pending.end();
  });
  observations.push({
    method,
    path: path.replace(environment.snapshot, '<fixture>'),
    status: response.status,
  });
  return response;
}

async function publicOutput(origin: string, output: MediaOutput) {
  const response = await call(origin, output.publicPath);
  expect(response.status, output.publicPath).toBe(200);
  expect(response.headers['content-type']).toBe(output.mimeType);
  expect(response.headers['content-length']).toBe(String(output.byteSize));
  expect(response.headers['accept-ranges']).toBe('bytes');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.bytes.length).toBe(output.byteSize);
  expect(createHash('sha256').update(response.bytes).digest('hex')).toBe(
    output.sha256,
  );
  if (output.mimeType === 'image/webp' || output.mimeType === 'image/png') {
    expect((await sharp(response.bytes).metadata()).format).toBe(
      output.mimeType === 'image/png' ? 'png' : 'webp',
    );
    const decoded = await sharp(response.bytes).raw().toBuffer({
      resolveWithObject: true,
    });
    expect(decoded.info.width).toBe(output.width);
    expect(decoded.info.height).toBe(output.height);
    expect(decoded.data.length).toBeGreaterThan(0);
  }
  const head = await call(origin, output.publicPath, { method: 'HEAD' });
  expect(head.status).toBe(200);
  for (const name of [
    'content-type',
    'content-length',
    'accept-ranges',
    'cache-control',
  ])
    expect(head.headers[name]).toBe(response.headers[name]);
  expect(head.bytes.length).toBe(0);
  return response.bytes;
}

describe('isolated real Astro development media', () => {
  it('serves decodable public image/srcset, video/poster, HEAD and exact Range responses', async () => {
    await withMediaDev(async (origin) => {
      const fullFiles = new Map<string, Buffer>();
      for (const asset of environment.prepared.manifest.assets)
        for (const output of asset.outputs)
          fullFiles.set(output.publicPath, await publicOutput(origin, output));
      for (const path of [imagePath, videoPath, posterPath]) {
        const full = fullFiles.get(path);
        if (full === undefined) throw new Error('PUBLIC_FIXTURE_MISSING');
        for (const [range, start, end] of [
          ['bytes=1-7', 1, 7],
          ['bytes=7-', 7, full.length - 1],
          ['bytes=-7', full.length - 7, full.length - 1],
        ] as const) {
          const partial = await call(origin, path, { range });
          expect(partial.status).toBe(206);
          expect(partial.headers['content-range']).toBe(
            `bytes ${start}-${end}/${full.length}`,
          );
          expect(partial.headers['content-length']).toBe(
            String(end - start + 1),
          );
          expect(partial.bytes).toEqual(full.subarray(start, end + 1));
        }
        for (const range of [
          `bytes=${full.length}-`,
          'bytes=8-2',
          'bytes=0-1,3-4',
          'bytes=-0',
        ]) {
          const rejected = await call(origin, path, { range });
          expect(rejected.status).toBe(416);
          expect(rejected.headers['content-range']).toBe(
            `bytes */${full.length}`,
          );
        }
      }
      const video = fullFiles.get(videoPath);
      if (video === undefined) throw new Error('VIDEO_FIXTURE_MISSING');
      const downloaded = join(environment.snapshot, '.alfred/downloaded.webm');
      await writeFile(downloaded, video);
      const probe = await runControlledProcess({
        command: 'ffprobe',
        args: [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,width,height',
          '-of',
          'json',
          downloaded,
        ],
        cwd: environment.snapshot,
        env: buildProcessEnvironment(),
        timeoutMs: 10_000,
      });
      expect(
        (JSON.parse(probe.stdout.toString()) as { streams: unknown[] }).streams,
      ).toContainEqual({ codec_name: 'vp9', width: 96, height: 64 });

      const browser = await chromium.launch({ headless: true });
      try {
        for (const width of [390, 1536]) {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
          });
          try {
            const failures: number[] = [];
            page.on('response', (response) => {
              if (
                new URL(response.url()).pathname.startsWith('/media/') &&
                response.status() >= 400
              )
                failures.push(response.status());
            });
            const article = await page.goto(`${origin}/notes/entry-1/`);
            expect(article?.status()).toBe(200);
            await page.evaluate(() => document.fonts.ready);
            const image = page.locator('main img').first();
            const srcset = await image.getAttribute('srcset');
            expect(srcset).toBe(
              [
                `/media/${publishedImageId}/image-480.webp 480w`,
                `/media/${publishedImageId}/image-768.webp 768w`,
                `/media/${publishedImageId}/image.webp 1000w`,
              ].join(', '),
            );
            const candidates = (srcset ?? '')
              .split(',')
              .map((item) => item.trim().split(/\s+/u)[0]);
            const imageOutputs = environment.prepared.manifest.assets
              .find((asset) => asset.id === publishedImageId)
              ?.outputs.filter((output) =>
                /\/image(?:-\d+)?\.webp$/u.test(output.publicPath),
              )
              .map((output) => output.publicPath);
            expect(candidates.sort()).toEqual(imageOutputs?.sort());
            const decoded = await image.evaluate(async (element) => {
              if (!(element instanceof HTMLImageElement))
                throw new Error('EXPECTED_IMAGE_ELEMENT');
              await element.decode();
              return {
                currentSrc: new URL(element.currentSrc).pathname,
                naturalWidth: element.naturalWidth,
              };
            });
            expect(candidates).toContain(decoded.currentSrc);
            expect(decoded.naturalWidth).toBeGreaterThan(0);
            const clip = page.locator('main video');
            expect(await clip.getAttribute('poster')).toBe(posterPath);
            expect(await clip.locator('source').getAttribute('src')).toBe(
              videoPath,
            );
            await clip.evaluate((element) => {
              if (!(element instanceof HTMLVideoElement))
                throw new Error('EXPECTED_VIDEO_ELEMENT');
              element.load();
            });
            await page.waitForFunction(
              () => {
                const clip = document.querySelector('main video');
                return clip instanceof HTMLVideoElement && clip.readyState >= 1;
              },
              undefined,
              { timeout: 10_000 },
            );
            const dimensions = await clip.evaluate((element) => {
              if (!(element instanceof HTMLVideoElement))
                throw new Error('EXPECTED_VIDEO_ELEMENT');
              return {
                width: element.videoWidth,
                height: element.videoHeight,
                duration: element.duration,
              };
            });
            expect(dimensions.width).toBe(96);
            expect(dimensions.height).toBe(64);
            expect(dimensions.duration).toBeGreaterThan(0);
            expect(failures).toEqual([]);
            decodedViewports.push({
              width,
              ...decoded,
              videoWidth: dimensions.width,
            });
            if (width === 390)
              await page.screenshot({
                path: join(reportDirectory, 'public-media-390.png'),
                fullPage: true,
              });
          } finally {
            await page.close();
          }
        }
      } finally {
        await browser.close();
      }
    });
  });

  it('rejects completed draft/unreachable assets and raw private or traversal paths', async () => {
    await withMediaDev(async (origin) => {
      for (const id of [draftImageId, unusedImageId])
        expect(
          (await environment.prepared.mediaService.get(id)).value.asset,
        ).not.toBeNull();
      for (const path of [
        `/media/${draftImageId}/image.webp`,
        `/media/${unusedImageId}/image.webp`,
        `/media/${publishedImageId}/original.png`,
        `/media/${publishedImageId}/meta.json`,
        `/media/${publishedImageId}/image.webp/extra`,
        `/media/${publishedImageId}/%2e%2e/%2e%2e/content/site.json`,
        `/media/${publishedImageId}/%2fcontent%2fsite.json`,
        `/media/${publishedImageId}/%5c..%5ccontent%5csite.json`,
        `/media/${publishedImageId}/%252e%252e%252fcontent%252fsite.json`,
        `/@fs${environment.snapshot}/content/site.json?raw`,
        `/@fs${environment.snapshot}/media/source/${draftImageId}/original.png`,
        `/@fs${environment.snapshot}/.alfred/render/index.json?raw`,
        `/@fs${environment.snapshot}/.alfred/media-records/${publishedImageId}.json?raw`,
      ]) {
        const response = await call(origin, path);
        expect([403, 404], path).toContain(response.status);
        expect(response.bytes.toString()).not.toContain(draftSentinel);
        expect(response.bytes.toString()).not.toContain(
          'SSR完整內容與來源隔離驗收',
        );
        expect(response.bytes.toString()).not.toContain('"processingHash"');
        expect(response.bytes.toString()).not.toContain('"mediaManifest"');
      }
      expect((await call(origin, imagePath)).status).toBe(200);
    });
  });

  it('uses the current manifest, fails closed for invalid context and refuses newer bytes under an older manifest', async () => {
    await withMediaDev(async (origin) => {
      const sitePath = join(environment.snapshot, 'content/site.json');
      const metaPath = join(environment.articleDirectory, 'meta.json');
      const bodyPath = join(environment.articleDirectory, 'content.html');
      const sourcePath = join(
        environment.snapshot,
        'media/source',
        publishedImageId,
        'original.png',
      );
      const originalSource = await readFile(sourcePath);
      try {
        const meta = JSON.parse(environment.meta) as Record<string, unknown>;
        await writeFile(
          metaPath,
          JSON.stringify({ ...meta, featuredImage: null }),
        );
        await writeFile(bodyPath, environment.originalBody);
        const removed = await environment.refresh();
        expect(removed.manifest.assets).toEqual([]);
        for (const path of [imagePath, videoPath, posterPath])
          expect((await call(origin, path)).status).toBe(404);

        await writeFile(metaPath, environment.meta);
        await writeFile(bodyPath, environment.body);
        await environment.refresh();
        expect((await call(origin, imagePath)).status).toBe(200);

        await writeFile(sitePath, '{');
        await expect(environment.refresh()).rejects.toMatchObject({
          name: 'RenderError',
        });
        await environment.renderer.invalidateRenderContext(
          environment.snapshot,
          environment.contextDirectory,
        );
        for (const path of [imagePath, videoPath, posterPath]) {
          const response = await call(origin, path);
          expect(response.status).toBe(503);
          expect(response.bytes.toString()).not.toContain(environment.snapshot);
          expect(response.bytes.toString()).not.toContain(draftSentinel);
          expect(response.bytes.toString()).not.toContain('"mediaManifest"');
        }
        await writeFile(sitePath, environment.site);
        await environment.refresh();
        expect((await call(origin, imagePath)).status).toBe(200);

        await writeFile(
          sourcePath,
          await sharp({
            create: {
              width: 1000,
              height: 500,
              channels: 3,
              background: '#b9372d',
            },
          })
            .png()
            .toBuffer(),
        );
        const newer =
          await environment.prepared.mediaService.process(publishedImageId);
        const original = environment.prepared.manifest.assets.find(
          (asset) => asset.id === publishedImageId,
        );
        expect(newer.sourceSha256).not.toBe(original?.sourceSha256);
        const mismatched = await call(origin, imagePath);
        expect(mismatched.status).toBe(503);
        expect(mismatched.bytes.toString()).not.toContain(environment.snapshot);
        const refreshed = await environment.refresh();
        const output = refreshed.manifest.assets
          .find((asset) => asset.id === publishedImageId)
          ?.outputs.find((output) => output.publicPath === imagePath);
        if (output === undefined) throw new Error('NEW_IMAGE_FIXTURE_MISSING');
        await publicOutput(origin, output);
      } finally {
        await writeFile(metaPath, environment.meta);
        await writeFile(bodyPath, environment.body);
        await writeFile(sitePath, environment.site);
        await writeFile(sourcePath, originalSource);
        await environment.refresh();
      }
    });
  });
});
