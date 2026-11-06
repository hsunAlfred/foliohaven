import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ArticleMetaSchema,
  ArticleResourceSchema,
  ArticleWriteSchema,
  MediaAssetSchema,
  MediaSourceResourceSchema,
  MediaSourceSchema,
  SiteConfigSchema,
  buildSiteModel,
} from '@foliohaven/core';
import { loadContent } from '@foliohaven/core/node';
import { fixedPages } from '@foliohaven/site/registry';
import { MediaReceipts } from '../../server/src/media/receipts.js';
import { processingDigest } from '../../server/src/media/storage.js';
import { safeMkdir } from '../../server/src/files/io.js';
import type { Binding } from '../../server/src/media/types.js';
import type { NativeImageFactory } from '../../server/src/media/worker.js';
import { call, sandbox, start } from '../fixtures/http/environment.mjs';
import type {
  HttpResult,
  RunningService,
} from '../fixtures/http/environment.mjs';

const reference = fileURLToPath(
  new URL('../fixtures/samples/reference/', import.meta.url),
);
const imageId = 'd65927b5-381f-4d2e-90d8-f6a8c5e38e57';
const articleId = 'sample-image-content';
const clock = () => new Date('2026-11-05T00:00:00Z');
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;

function etag(response: HttpResult) {
  expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/u);
  const value = response.headers.etag;
  if (typeof value !== 'string') throw new Error('Missing exact strong ETag');
  return value;
}

/** Uses old raw JSON unchanged; only one tiny real image is encoded to seed a
 * valid v1 cache, without running media jobs, FFmpeg or the new v2 pipeline. */
async function legacyWorkspace(root: string) {
  await rm(join(root, 'content/articles'), { recursive: true, force: true });
  const originals = new Map<string, Buffer>();
  async function source(path: string, bytes: Buffer) {
    originals.set(path, bytes);
    const parent = path.slice(0, path.lastIndexOf('/'));
    await mkdir(join(root, parent), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  for (const name of ['site.json', 'categories.json', 'tags.json']) {
    await source(
      'content/' + name,
      await readFile(join(reference, 'content', name)),
    );
  }
  const legacySite = SiteConfigSchema.parse(
    JSON.parse(originals.get('content/site.json')?.toString() ?? 'null'),
  );
  expect(
    JSON.parse(originals.get('content/site.json')?.toString() ?? 'null'),
  ).not.toHaveProperty('icons');
  expect(
    JSON.parse(originals.get('content/site.json')?.toString() ?? 'null'),
  ).not.toHaveProperty('pageSEO');
  const mediaDirectory = `media/source/${imageId}`;
  for (const name of ['meta.json', 'original.png']) {
    await source(
      `${mediaDirectory}/${name}`,
      await readFile(join(reference, mediaDirectory, name)),
    );
  }
  const sourceMetaBytes = originals.get(`${mediaDirectory}/meta.json`);
  const sourceBytes = originals.get(`${mediaDirectory}/original.png`);
  if (!sourceMetaBytes || !sourceBytes)
    throw new Error('Missing legacy media fixture');
  const media = MediaSourceSchema.parse(JSON.parse(sourceMetaBytes.toString()));
  const image = await sharp(sourceBytes)
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = image.info;
  const inspection = {
    kind: 'image' as const,
    aspectRatio: width / height,
    mimeType: 'image/png' as const,
    width,
    height,
    durationSeconds: null,
    fps: null,
    audio: false,
    streamIndex: null,
  };
  const tools = { sharp: sharp.versions.sharp, libvips: sharp.versions.vips };
  const processingHash = processingDigest({
    sourceSha256: digest(sourceBytes),
    presetVersion: 'article-image-v1',
    posterTimeSeconds: null,
    tools,
  });
  const output = {
    publicPath: `/media/${imageId}/image.webp`,
    mimeType: 'image/webp' as const,
    width,
    height,
    byteSize: image.data.byteLength,
    sha256: digest(image.data),
  };
  const asset = MediaAssetSchema.parse({
    id: imageId,
    kind: 'image',
    sourceSha256: digest(sourceBytes),
    presetVersion: 'article-image-v1',
    tools,
    outputs: [output],
  });
  const binding: Binding = {
    schemaVersion: 1,
    sourceRevision: digest(sourceBytes),
    metaRevision: digest(sourceMetaBytes),
    processingHash,
    inspection,
    asset,
  };
  const cacheDirectory = join(root, '.alfred/media', processingHash);
  await safeMkdir(root, '.alfred/media/' + processingHash);
  await safeMkdir(root, '.alfred/media-records');
  await writeFile(join(cacheDirectory, 'image.webp'), image.data, {
    mode: 0o600,
  });
  await writeFile(
    join(cacheDirectory, 'cache.json'),
    JSON.stringify({
      inspection,
      tools,
      outputs: [
        {
          variant: 'image.webp',
          mimeType: output.mimeType,
          width,
          height,
          byteSize: output.byteSize,
          sha256: output.sha256,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const bindingPath = join(root, '.alfred/media-records', imageId + '.json');
  await writeFile(bindingPath, JSON.stringify(binding), { mode: 0o600 });
  const receiptId = randomUUID();
  await new MediaReceipts(root).commit(
    receiptId,
    binding,
    '2026-10-23T00:00:00.000Z',
  );
  const receiptPath = join(
    root,
    '.alfred/media-job-receipts',
    receiptId + '.json',
  );
  const preservedMedia = new Map<string, Buffer>();
  for (const path of [
    bindingPath,
    receiptPath,
    join(cacheDirectory, 'cache.json'),
    join(cacheDirectory, 'image.webp'),
  ])
    preservedMedia.set(path, await readFile(path));

  const metadata = new Map<
    string,
    ReturnType<typeof ArticleMetaSchema.parse>
  >();
  for (const id of [
    'sample-article-basics',
    articleId,
    'sample-table-content',
  ]) {
    const bytes = await readFile(
      join(reference, 'content/articles', id, 'meta.json'),
    );
    const raw: unknown = JSON.parse(bytes.toString());
    expect(raw).not.toHaveProperty('excerpt');
    expect(raw).not.toHaveProperty('relatedReading');
    metadata.set(id, ArticleMetaSchema.parse(raw));
    await source(`content/articles/${id}/meta.json`, bytes);
    const html = `<!-- old whitespace stays -->\n<h2 id="legacy">既有正文</h2>\n<p>  不應重新序列化的  原文 </p>\n${id === articleId ? `<img src="${output.publicPath}" width="${width}" height="${height}" alt="舊版受管圖片">\n` : ''}`;
    await source(`content/articles/${id}/content.html`, Buffer.from(html));
  }
  const legacyMeta = metadata.get(articleId);
  if (!legacyMeta) throw new Error('Missing old article metadata');
  expect(metadata.get('sample-table-content')?.seo.index).toBe(false);
  return {
    originals,
    preservedMedia,
    asset,
    imageBytes: image.data,
    media,
    legacySite,
    legacyMeta,
  };
}

describe('v0.2 to v0.3 persistent server upgrade', () => {
  it('reads old raw sources without rewriting, saves with exact API versions and survives service restart with legacy v1 media intact', async () => {
    const root = await sandbox();
    let running: RunningService | undefined;
    try {
      const legacy = await legacyWorkspace(root);
      const path = `/api/v1/articles/${articleId}`;
      running = await start(root, { clock });
      const firstArticle = await call(running, path);
      const firstSite = await call(running, '/api/v1/site-settings');
      const firstMedia = await call(
        running,
        `/api/v1/media/sources/${imageId}`,
      );
      expect(firstArticle.status).toBe(200);
      expect(firstSite.status).toBe(200);
      expect(firstMedia.status).toBe(200);
      const article = ArticleResourceSchema.parse(firstArticle.body);
      const site = SiteConfigSchema.parse(firstSite.body);
      const media = MediaSourceResourceSchema.parse(firstMedia.body);
      expect(article.meta.excerpt).toBe('');
      expect(article.meta.relatedReading).toEqual({
        title: '延伸閱讀',
        articleIds: [],
      });
      expect(article.meta.seo).toEqual(legacy.legacyMeta.seo);
      expect(article.meta.publishedAt).toBe(
        new Date(legacy.legacyMeta.publishedAt ?? '').toISOString(),
      );
      expect(site.home.featuredCaption).toBe('精選文章');
      expect(site.icons.enabled).toBe(false);
      expect(Object.keys(site.pageSEO).sort()).toEqual(
        [
          'article',
          'articles',
          'category',
          'categoryIndex',
          'home',
          'notFound',
          'tag',
          'tagIndex',
        ].sort(),
      );
      expect(site.social.defaultImage).toBe(
        legacy.legacySite.social.defaultImage,
      );
      expect(media.asset).toEqual(legacy.asset);
      expect(media.displayName).toBe(legacy.media.displayName);
      for (const [resource, bytes] of legacy.originals)
        expect(await readFile(join(root, resource)), resource).toEqual(bytes);

      const write = ArticleWriteSchema.parse({
        contentHtml: article.contentHtml,
        meta: {
          ...legacy.legacyMeta,
          excerpt: '升級後獨立摘要，不取代原本的 Meta Description。',
        },
      });
      const savedArticle = await call(running, path, {
        method: 'PUT',
        body: write,
        headers: { 'if-match': etag(firstArticle) },
      });
      expect(savedArticle.status, JSON.stringify(savedArticle.body)).toBe(200);
      const savedResource = ArticleResourceSchema.parse(savedArticle.body);
      expect(savedResource.meta.seo.description).toBe(
        legacy.legacyMeta.seo.description,
      );
      const writtenMeta = await readFile(
        join(root, `content/articles/${articleId}/meta.json`),
      );
      const persistedMeta = ArticleMetaSchema.parse(
        JSON.parse(writtenMeta.toString()),
      );
      expect(persistedMeta.publishedAt).toBe(legacy.legacyMeta.publishedAt);
      expect(persistedMeta.updatedAt).toBe(legacy.legacyMeta.updatedAt);
      expect(persistedMeta.excerpt).toBe(write.meta.excerpt);
      const staleArticle = await call(running, path, {
        method: 'PUT',
        body: write,
        headers: { 'if-match': etag(firstArticle) },
      });
      expect(staleArticle.status).toBe(412);
      expect(
        await readFile(join(root, `content/articles/${articleId}/meta.json`)),
      ).toEqual(writtenMeta);

      const nextSite = SiteConfigSchema.parse({
        ...site,
        home: { ...site.home, featuredCaption: '升級後的精選文章' },
      });
      const savedSite = await call(running, '/api/v1/site-settings', {
        method: 'PUT',
        body: nextSite,
        headers: { 'if-match': etag(firstSite) },
      });
      expect(savedSite.status, JSON.stringify(savedSite.body)).toBe(200);
      const writtenSite = await readFile(join(root, 'content/site.json'));
      const staleSite = await call(running, '/api/v1/site-settings', {
        method: 'PUT',
        body: nextSite,
        headers: { 'if-match': etag(firstSite) },
      });
      expect(staleSite.status).toBe(412);
      expect(await readFile(join(root, 'content/site.json'))).toEqual(
        writtenSite,
      );
      await running.service.close();
      running = undefined;

      running = await start(root, { clock });
      const reopenedArticle = await call(running, path);
      const reopenedSite = await call(running, '/api/v1/site-settings');
      const reopenedMedia = await call(
        running,
        `/api/v1/media/sources/${imageId}`,
      );
      expect(reopenedArticle.status).toBe(200);
      expect(reopenedSite.status).toBe(200);
      expect(reopenedMedia.status).toBe(200);
      expect(ArticleResourceSchema.parse(reopenedArticle.body)).toEqual(
        savedResource,
      );
      expect(etag(reopenedArticle)).toBe(etag(savedArticle));
      expect(SiteConfigSchema.parse(reopenedSite.body)).toEqual(nextSite);
      expect(etag(reopenedSite)).toBe(etag(savedSite));
      expect(MediaSourceResourceSchema.parse(reopenedMedia.body).asset).toEqual(
        legacy.asset,
      );
      const openedImage = await call(
        running,
        `/api/v1/media/files/${imageId}/image.webp`,
      );
      expect(openedImage.status).toBe(200);
      expect(openedImage.bytes).toEqual(legacy.imageBytes);
      expect((await sharp(openedImage.bytes).metadata()).format).toBe('webp');

      const model = buildSiteModel({
        ...(await loadContent(root, { mode: 'preview' })),
        fixedPages,
        mediaManifest: { schemaVersion: 1, assets: [legacy.asset] },
        now: clock().toISOString(),
      });
      const publicArticle = model.articlePages.find(
        (item) => item.articleId === articleId,
      );
      expect(publicArticle?.url).toBe('/notes/image-content/');
      expect(publicArticle?.contentHtml).toContain('不應重新序列化的  原文');
      expect(publicArticle?.description).toBe(write.meta.excerpt);
      expect(publicArticle?.seo.description).toBe(
        legacy.legacyMeta.seo.description,
      );
      expect(publicArticle?.featuredImage?.src).toBe(
        legacy.legacyMeta.featuredImage,
      );
      expect(
        model.articlePages.find(
          (item) => item.articleId === 'sample-table-content',
        )?.seo.index,
      ).toBe(false);
      for (const [resource, bytes] of legacy.originals) {
        if (
          resource === 'content/site.json' ||
          resource === `content/articles/${articleId}/meta.json`
        )
          continue;
        expect(await readFile(join(root, resource)), resource).toEqual(bytes);
      }
      for (const [resource, bytes] of legacy.preservedMedia)
        expect(await readFile(resource), resource).toEqual(bytes);
    } finally {
      await running?.service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
