import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
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
import { FileRepository } from '../../server/src/files/index.js';
import { MediaService } from '../../server/src/media/index.js';
import { MediaReceipts } from '../../server/src/media/receipts.js';
import { processingDigest } from '../../server/src/media/storage.js';
import type { Binding } from '../../server/src/media/types.js';
import type { WorkerResult } from '../../server/src/media/process.js';
import type { NativeImageFactory } from '../../server/src/media/worker.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function collect(stream: Readable) {
  const bytes: Buffer[] = [];
  for await (const chunk of stream) bytes.push(Buffer.from(chunk));
  return Buffer.concat(bytes);
}
async function fixture(width = 40, height = 20) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-image-v2-'));
  fixtures.push(root);
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  const service = new MediaService({ repositoryRoot: root, repository });
  const bytes = await sharp({
    create: { width, height, channels: 4, background: '#cc2244' },
  })
    .png()
    .toBuffer();
  const source = await service.register(
    await service.stageSource(Readable.from([bytes]), {
      filename: 'social.png',
      mimeType: 'image/png',
    }),
  );
  return { root, service, source: source.value };
}

describe('article-image-v2 media preset', () => {
  it('produces two exact social compositions and a transparent PNG icon while preserving small article pixels', async () => {
    const { service, source } = await fixture();
    const asset = await service.process(source.id);
    expect(asset.presetVersion).toBe('article-image-v2');
    expect(
      asset.outputs.map(({ publicPath, width, height, mimeType }) => ({
        variant: publicPath.split('/').at(-1),
        width,
        height,
        mimeType,
      })),
    ).toEqual([
      { variant: 'image.webp', width: 40, height: 20, mimeType: 'image/webp' },
      {
        variant: 'image-social.webp',
        width: 1200,
        height: 630,
        mimeType: 'image/webp',
      },
      {
        variant: 'image-social-crop.webp',
        width: 1200,
        height: 630,
        mimeType: 'image/webp',
      },
      { variant: 'favicon.png', width: 32, height: 32, mimeType: 'image/png' },
    ]);
    const readPixels = async (variant: string) => {
      const file = await service.openVariant(source.id, variant);
      const encoded = await collect(file.stream);
      return {
        file,
        encoded,
        ...(await sharp(encoded)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })),
      };
    };
    const padded = await readPixels('image-social.webp');
    const cropped = await readPixels('image-social-crop.webp');
    const favicon = await readPixels('favicon.png');
    const pixel = (image: typeof padded, x: number, y: number) => [
      ...image.data.subarray(
        (y * image.info.width + x) * 4,
        (y * image.info.width + x) * 4 + 4,
      ),
    ];
    expect(pixel(padded, 0, 0)[0]).toBeGreaterThan(220);
    expect(pixel(padded, 565, 315)[1]).toBeGreaterThan(210);
    expect(pixel(padded, 600, 315)[1]).toBeLessThan(70);
    expect(pixel(cropped, 0, 0)[1]).toBeLessThan(70);
    expect(pixel(favicon, 0, 0)[3]).toBe(0);
    expect(pixel(favicon, 16, 16)[3]).toBe(255);
    expect(favicon.file.headers['Content-Type']).toBe('image/png');
    expect((await sharp(favicon.encoded).metadata()).format).toBe('png');
    // The cache verification path decodes every new output with its own format.
    expect(await service.process(source.id)).toEqual(asset);
  });

  it('upgrades an existing v1 binding without touching its cache, receipt or saved image URLs', async () => {
    const { root, service, source } = await fixture(900, 450);
    const generated = await service.process(source.id);
    const bindingPath = join(
      root,
      '.alfred/media-records',
      source.id + '.json',
    );
    const current = JSON.parse(await readFile(bindingPath, 'utf8')) as Binding;
    const v2Directory = join(root, '.alfred/media', current.processingHash);
    const generatedCache = JSON.parse(
      await readFile(join(v2Directory, 'cache.json'), 'utf8'),
    ) as WorkerResult;
    const normal = generated.outputs.filter(({ publicPath }) =>
      /\/image(?:-[1-9]\d*)?\.webp$/u.test(publicPath),
    );
    const legacyAsset = {
      ...generated,
      presetVersion: 'article-image-v1',
      outputs: normal,
    };
    const legacyHash = processingDigest({
      sourceSha256: source.sourceSha256,
      presetVersion: 'article-image-v1',
      posterTimeSeconds: null,
      tools: generatedCache.tools,
    });
    expect(legacyHash).not.toBe(current.processingHash);
    const legacyDirectory = join(root, '.alfred/media', legacyHash);
    await mkdir(legacyDirectory);
    const legacyOutputs = generatedCache.outputs.filter(({ variant }) =>
      /^image(?:-[1-9]\d*)?\.webp$/u.test(variant),
    );
    for (const { variant } of legacyOutputs)
      await copyFile(
        join(v2Directory, variant),
        join(legacyDirectory, variant),
      );
    const cacheBytes = JSON.stringify({
      ...generatedCache,
      outputs: legacyOutputs,
    });
    await writeFile(join(legacyDirectory, 'cache.json'), cacheBytes);
    const legacy: Binding = {
      ...current,
      processingHash: legacyHash,
      asset: legacyAsset,
    };
    await writeFile(bindingPath, JSON.stringify(legacy));
    const receipts = new MediaReceipts(root);
    const jobId = randomUUID();
    await receipts.commit(jobId, legacy, new Date().toISOString());
    const receiptPath = join(
      root,
      '.alfred/media-job-receipts',
      jobId + '.json',
    );
    const receiptBytes = await readFile(receiptPath);
    await rm(v2Directory, { recursive: true });
    expect((await service.get(source.id)).value.asset).toEqual(legacyAsset);
    expect((await service.list()).items[0]?.asset).toEqual(legacyAsset);
    const before = new Map<string, Buffer>();
    for (const item of normal)
      before.set(
        item.publicPath,
        await collect(
          (
            await service.openVariant(
              source.id,
              item.publicPath.split('/').at(-1) ?? '',
            )
          ).stream,
        ),
      );
    const upgraded = await service.process(source.id, {
      jobId: randomUUID(),
      preset: 'article-image',
    });
    expect(upgraded.presetVersion).toBe('article-image-v2');
    for (const item of normal) {
      expect(
        upgraded.outputs.find(
          ({ publicPath }) => publicPath === item.publicPath,
        ),
      ).toEqual(item);
      expect(
        await collect(
          (
            await service.openVariant(
              source.id,
              item.publicPath.split('/').at(-1) ?? '',
            )
          ).stream,
        ),
      ).toEqual(before.get(item.publicPath));
      expect(
        await readFile(
          join(legacyDirectory, item.publicPath.split('/').at(-1) ?? ''),
        ),
      ).toEqual(before.get(item.publicPath));
    }
    expect(await readFile(join(legacyDirectory, 'cache.json'), 'utf8')).toBe(
      cacheBytes,
    );
    expect(await readFile(receiptPath)).toEqual(receiptBytes);
    expect(
      (
        await receipts.committedResult(jobId, {
          sourceId: source.id,
          preset: 'article-image',
        })
      )?.result.asset,
    ).toEqual(legacyAsset);
  });

  it('prevents deleting an image referenced by the site favicon setting', async () => {
    const { root, service, source } = await fixture();
    await mkdir(join(root, 'content/articles'), { recursive: true });
    await writeFile(
      join(root, 'content/site.json'),
      JSON.stringify({
        siteName: 'Icon fixture',
        siteDescription: 'Private fixture',
        siteUrl: 'https://example.invalid/',
        author: { name: 'Test' },
        favicon: `/media/${source.id}/favicon.png`,
      }),
    );
    await writeFile(join(root, 'content/categories.json'), '[]');
    await writeFile(join(root, 'content/tags.json'), '[]');
    const current = await service.get(source.id);
    await expect(service.remove(source.id, current.etag)).rejects.toMatchObject(
      { code: 'MEDIA_IN_USE', status: 409 },
    );
  });
});
