import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  ArticleIdSchema,
  ArticleListQuerySchema,
  ArticleMetaSchema,
  ArticleResourceSchema,
  ArticleWriteSchema,
  BuildJobRequestSchema,
  CancellationRequestSchema,
  CategoriesSchema,
  CategoryPathSchema,
  CONTENT_LIMITS,
  CurrentArtifactSchema,
  DateTimeSchema,
  DraftArticleMetaSchema,
  ETagSchema,
  FixedPageSchema,
  HtmlContentSchema,
  JobSchema,
  ManagedImagePathSchema,
  MediaAssetSchema,
  MediaManifestSchema,
  MediaOutputSchema,
  MediaSourceSchema,
  PreviewRequestSchema,
  PublishedArticleMetaSchema,
  RecoveryResolutionSchema,
  RelativeResourceSchema,
  RootPathSchema,
  SearchIndexSchema,
  SeoOverrideSchema,
  SiteConfigSchema,
  SlugSchema,
  TagsSchema,
  TaxonomyMigrationRequestSchema,
  TimeZoneSchema,
  toUtcDateTime,
  WorkspaceSchema,
} from '@foliohaven/core';

const mediaId = 'b9b5681a-36f0-49bf-a715-7604db77a32f';
const imagePath = `/media/${mediaId}/image.webp`;
const hash = 'a'.repeat(64);
const published = (overrides: Record<string, unknown> = {}) => ({
  status: 'published',
  title: '合法文章',
  slug: 'hello-world',
  category: 'notes',
  tags: [],
  publishedAt: '2026-10-23T09:00:00+08:00',
  updatedAt: '2026-10-23T01:00:00Z',
  featuredImage: null,
  featuredImageAlt: '',
  seo: { description: '文章摘要。' },
  ...overrides,
});
const site = (overrides: Record<string, unknown> = {}) => ({
  siteName: '範例網站',
  siteDescription: '網站說明。',
  siteUrl: 'https://example.invalid/',
  author: { name: '作者', url: null },
  ...overrides,
});
const output = (overrides: Record<string, unknown> = {}) => ({
  publicPath: imagePath,
  mimeType: 'image/webp',
  width: 1280,
  height: 720,
  byteSize: 10_000,
  sha256: hash,
  ...overrides,
});
const asset = (overrides: Record<string, unknown> = {}) => ({
  id: mediaId,
  kind: 'image',
  sourceSha256: hash,
  presetVersion: 'image-v1',
  tools: { sharp: '0.35.5', libvips: '8.18.0' },
  outputs: [output()],
  ...overrides,
});
const job = (overrides: Record<string, unknown> = {}) => ({
  id: mediaId,
  type: 'build',
  status: 'queued',
  stage: 'queued',
  progress: { completed: 0, total: null },
  createdAt: '2026-10-23T01:00:00Z',
  startedAt: null,
  finishedAt: null,
  snapshotRevision: null,
  result: null,
  error: null,
  ...overrides,
});

describe('Article metadata contract', () => {
  it('normalizes a minimal draft without modifying its input', () => {
    const input = { status: 'draft' };
    const result = DraftArticleMetaSchema.parse(input);
    expect(input).toEqual({ status: 'draft' });
    expect(result).toEqual({
      status: 'draft',
      title: '',
      excerpt: '',
      relatedReading: { title: '延伸閱讀', articleIds: [] },
      slug: '',
      category: null,
      tags: [],
      publishedAt: null,
      updatedAt: null,
      featuredImage: null,
      featuredImageAlt: '',
      seo: { title: null, description: null, index: null, ogImage: null },
    });
  });
  it('keeps incomplete draft semantics and zero tags', () => {
    expect(
      ArticleMetaSchema.parse({
        status: 'draft',
        slug: 'Not done yet',
        category: 'Missing Category',
      }).status,
    ).toBe('draft');
    expect(PublishedArticleMetaSchema.parse(published()).tags).toEqual([]);
  });
  it.each([
    {},
    { status: 'scheduled' },
    { status: null },
    { status: 'draft', unknown: true },
    { status: 'draft', tags: 'notes' },
    { status: 'draft', title: 'x'.repeat(201) },
    { status: 'draft', publishedAt: '2026-02-30T00:00:00Z' },
  ])('rejects structural input %j', (input) => {
    expect(ArticleMetaSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    { title: '' },
    { title: '  ' },
    { slug: '123' },
    { slug: 'a'.repeat(81) },
    { category: null },
    { category: 'category/notes' },
    { tags: ['example', 'example'] },
    { tags: ['unknown tag'] },
    { tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) },
    { publishedAt: null },
    { updatedAt: null },
    { updatedAt: '2026-10-23T00:59:59Z' },
    { seo: { description: ' ' } },
    { seo: { description: 'ok', index: 'false' } },
  ])('rejects invalid publication %j', (change) => {
    expect(
      PublishedArticleMetaSchema.safeParse(published(change)).success,
    ).toBe(false);
  });
  it('allows published metadata to inherit its SEO description', () => {
    for (const seo of [{}, { description: null }])
      expect(
        PublishedArticleMetaSchema.parse(published({ seo })).seo.description,
      ).toBeNull();
  });
  it('checks the published title limit after trimming without changing the source object', () => {
    const input = published({ title: `  ${'文'.repeat(200)}  ` });
    expect(PublishedArticleMetaSchema.parse(input).title).toBe(
      '文'.repeat(200),
    );
    expect(input.title).toBe(`  ${'文'.repeat(200)}  `);
    expect(
      PublishedArticleMetaSchema.safeParse(
        published({ title: ` ${'文'.repeat(201)} ` }),
      ).success,
    ).toBe(false);
  });
  it('preserves authored dates and noindex independently from publication', () => {
    const result = ArticleMetaSchema.parse(
      published({ seo: { description: '摘要', index: false } }),
    );
    expect(result.status).toBe('published');
    expect(result.publishedAt).toBe('2026-10-23T09:00:00+08:00');
    expect(result.seo.index).toBe(false);
  });
  it('uses null SEO overrides, preserving inheritance of site index=false', () => {
    expect(SeoOverrideSchema.parse({})).toEqual({
      title: null,
      description: null,
      index: null,
      ogImage: null,
    });
    const article = PublishedArticleMetaSchema.parse(published());
    const settings = SiteConfigSchema.parse(
      site({ defaultSEO: { index: false } }),
    );
    expect(article.seo.index ?? settings.defaultSEO.index).toBe(false);
  });
  it('requires explicit featured-image alt while allowing decorative empty alt', () => {
    const input = published({ featuredImage: imagePath });
    delete (input as Record<string, unknown>)['featuredImageAlt'];
    expect(PublishedArticleMetaSchema.safeParse(input).success).toBe(false);
    expect(
      PublishedArticleMetaSchema.parse({ ...input, featuredImageAlt: '' })
        .featuredImageAlt,
    ).toBe('');
    expect(
      PublishedArticleMetaSchema.safeParse(
        published({ featuredImage: `/media/${mediaId}/video.webm` }),
      ).success,
    ).toBe(false);
  });
  it('validates complete write payload without allowing roundtripped response fields', () => {
    expect(
      ArticleWriteSchema.parse({
        contentHtml: '<p>原始  文字</p>\n',
        meta: { status: 'draft' },
      }).contentHtml,
    ).toBe('<p>原始  文字</p>\n');
    expect(
      ArticleWriteSchema.safeParse({
        id: 'article-test',
        contentHtml: '',
        meta: { status: 'draft' },
      }).success,
    ).toBe(false);
  });
  it('accepts real response and preview contracts with their additional fields', () => {
    expect(
      ArticleResourceSchema.parse({
        id: 'article-test',
        contentHtml: '',
        meta: { status: 'draft' },
        diagnostics: [],
      }).id,
    ).toBe('article-test');
    expect(
      PreviewRequestSchema.parse({
        articleId: 'article-test',
        contentHtml: '',
        meta: { status: 'draft' },
      }).articleId,
    ).toBe('article-test');
  });
});

describe('strict dates and path primitives', () => {
  it.each([
    '2024-02-29T23:59:59Z',
    '2000-02-29T00:00:00+08:00',
    '2026-10-23T12:00:00.123-05:30',
    '0000-02-29T00:00:00Z',
  ])('accepts explicit real instant %s', (value) =>
    expect(DateTimeSchema.safeParse(value).success).toBe(true),
  );
  it.each([
    '2023-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00+08:60',
    '2026-01-01T00:00:00',
    '2026-01-01',
    '',
  ])('rejects malformed or impossible instant %s', (value) =>
    expect(DateTimeSchema.safeParse(value).success).toBe(false),
  );
  it('normalizes API dates to UTC without guessing time zones', () => {
    expect(toUtcDateTime('2026-10-23T09:00:00+08:00')).toBe(
      '2026-10-23T01:00:00.000Z',
    );
    expect(() => toUtcDateTime('2026-10-23')).toThrow();
  });
  it('separates directory IDs from public slugs', () => {
    expect(ArticleIdSchema.safeParse('123').success).toBe(true);
    expect(SlugSchema.safeParse('123').success).toBe(false);
    expect(CategoryPathSchema.safeParse('notes/tool-2').success).toBe(true);
  });
  it.each([
    'assets/test',
    '_astro/test',
    'articles',
    'media/foo',
    'category/notes',
    'notes//child',
    '../notes',
    '/notes',
    'notes/42',
  ])('rejects unsafe or reserved category %s', (value) =>
    expect(CategoryPathSchema.safeParse(value).success).toBe(false),
  );
  it.each([
    '/foo//bar/',
    '/foo/../bar/',
    '//evil.invalid/',
    '/foo/?q=x',
    '/foo/%2e%2e/',
    '/foo\\bar/',
  ])('rejects ambiguous root path %s', (value) =>
    expect(RootPathSchema.safeParse(value).success).toBe(false),
  );
  it('accepts root and directory paths, rejects traversal resource keys', () => {
    expect(RootPathSchema.parse('/')).toBe('/');
    expect(RootPathSchema.parse('/foo/bar/')).toBe('/foo/bar/');
    for (const value of [
      '/etc/passwd',
      '../meta.json',
      'x/../meta.json',
      'x\\meta.json',
      'x//meta.json',
      'x\0meta.json',
    ])
      expect(RelativeResourceSchema.safeParse(value).success).toBe(false);
    expect(
      RelativeResourceSchema.parse('content/articles/article-one/meta.json'),
    ).toBe('content/articles/article-one/meta.json');
    expect(ETagSchema.safeParse(`"${hash}"`).success).toBe(true);
    expect(ETagSchema.safeParse('*').success).toBe(false);
  });
  it('keeps original LF text and enforces byte limits', () => {
    expect(HtmlContentSchema.parse('<p>  hello </p>\n')).toBe(
      '<p>  hello </p>\n',
    );
    expect(HtmlContentSchema.safeParse('<p>\r\n</p>').success).toBe(false);
    expect(HtmlContentSchema.safeParse('x\ry').success).toBe(false);
    expect(HtmlContentSchema.safeParse('x\0y').success).toBe(false);
    expect(
      HtmlContentSchema.safeParse(
        '中'.repeat(Math.floor(CONTENT_LIMITS.articleHtmlBytes / 3) + 1),
      ).success,
    ).toBe(false);
  });
});

describe('taxonomy, site and fixed pages', () => {
  it('permits empty taxonomy and explicit unsorted parents', () => {
    expect(CategoriesSchema.parse([])).toEqual([]);
    expect(TagsSchema.parse([])).toEqual([]);
    expect(
      CategoriesSchema.parse([
        { path: 'notes/tools', name: '工具', description: '工具資料' },
        { path: 'notes', name: '筆記', description: '筆記資料' },
      ]),
    ).toHaveLength(2);
  });
  it('rejects missing parents, duplicate identifiers and nested unknown SEO fields', () => {
    const category = { path: 'notes', name: '筆記', description: '筆記資料' };
    expect(
      CategoriesSchema.safeParse([{ ...category, path: 'notes/tools' }])
        .success,
    ).toBe(false);
    expect(CategoriesSchema.safeParse([category, category]).success).toBe(
      false,
    );
    const tag = { slug: 'example', name: '範例', description: '範例文章' };
    expect(TagsSchema.safeParse([tag, tag]).success).toBe(false);
    expect(
      CategoriesSchema.safeParse([
        { ...category, seo: { canonical: '/notes/' } },
      ]).success,
    ).toBe(false);
  });
  it('applies complete site defaults while preserving raw input', () => {
    const raw = site();
    const copy = structuredClone(raw);
    const result = SiteConfigSchema.parse(raw);
    expect(raw).toEqual(copy);
    expect(result.language).toBe('zh-Hant');
    expect(result.timeZone).toBe('Asia/Taipei');
    expect(result.pagination).toEqual({ category: 10, tag: 10, articles: 10 });
    expect(result.defaultSEO).toEqual({
      titleTemplate: '{title} | {siteName}',
      description: raw.siteDescription,
      index: true,
    });
    expect(result.rss).toEqual({
      title: raw.siteName,
      description: raw.siteDescription,
      maxItems: 100,
    });
  });
  it.each([
    { siteUrl: 'https://user:password@example.invalid/' },
    { siteUrl: 'https://example.invalid/blog/' },
    { siteUrl: 'https://example.invalid/?q=x' },
    { siteUrl: 'https://example.invalid/#x' },
    { siteUrl: 'https://example.invalid' },
    { siteUrl: 'javascript:alert(1)' },
    { language: 'bad_language' },
    { timeZone: 'Unknown/Nowhere' },
    { timeZone: '+08:00' },
    { pagination: { category: '2' } },
    { pagination: { category: 0 } },
    { pagination: { articles: 101 } },
    { defaultSEO: { titleTemplate: '{articleTitle}' } },
    { social: { twitterSite: 'alfred' } },
    { navigation: [{ label: '壞連結', href: 'notes/' }] },
    { home: { featuredArticleIds: ['one', 'one'] } },
    { author: { name: '作者', privateEmail: 'secret@example.invalid' } },
    { googleSiteVerification: '' },
  ])('rejects invalid site contract %j', (change) =>
    expect(SiteConfigSchema.safeParse(site(change)).success).toBe(false),
  );
  it('rejects invalid time zones and unmanaged media refs in fixed registry', () => {
    expect(TimeZoneSchema.safeParse('Asia/Taipei').success).toBe(true);
    expect(
      FixedPageSchema.parse({
        id: 'home',
        path: '/',
        entry: 'src/pages/index.astro',
        mediaRefs: [imagePath, `/media/${mediaId}/video.webm`],
      }).mediaRefs,
    ).toHaveLength(2);
    expect(
      FixedPageSchema.safeParse({
        id: 'home',
        path: '/',
        entry: '../index.astro',
      }).success,
    ).toBe(false);
    expect(
      FixedPageSchema.safeParse({
        id: 'home',
        path: '/',
        entry: 'src/pages/index.astro',
        mediaRefs: ['/media/not-a-uuid/video.webm'],
      }).success,
    ).toBe(false);
  });
});

describe('media manifest contract', () => {
  it('normalizes source display name and rejects type/path mismatches', () => {
    expect(
      MediaSourceSchema.parse({
        schemaVersion: 1,
        id: mediaId,
        kind: 'image',
        source: 'original.png',
      }).displayName,
    ).toBe('original.png');
    for (const source of [
      '../original.png',
      '/tmp/original.png',
      'original.gif',
      'original.png\0',
    ])
      expect(
        MediaSourceSchema.safeParse({
          schemaVersion: 1,
          id: mediaId,
          kind: 'image',
          source,
        }).success,
      ).toBe(false);
    expect(
      MediaSourceSchema.safeParse({
        schemaVersion: 1,
        id: mediaId,
        kind: 'image',
        source: 'original.mov',
      }).success,
    ).toBe(false);
    expect(
      MediaSourceSchema.safeParse({
        schemaVersion: 1,
        id: mediaId,
        kind: 'image',
        source: 'original.png',
        posterTimeSeconds: 0,
      }).success,
    ).toBe(false);
    expect(ManagedImagePathSchema.safeParse(imagePath).success).toBe(true);
  });
  it('enforces manifest version, hashes, ownership and output uniqueness', () => {
    expect(
      MediaManifestSchema.parse({ schemaVersion: 1, assets: [asset()] }).assets,
    ).toHaveLength(1);
    expect(
      MediaManifestSchema.safeParse({ schemaVersion: 2, assets: [] }).success,
    ).toBe(false);
    expect(
      MediaManifestSchema.safeParse({
        schemaVersion: 1,
        assets: [asset(), asset()],
      }).success,
    ).toBe(false);
    expect(
      MediaAssetSchema.safeParse(asset({ outputs: [output(), output()] }))
        .success,
    ).toBe(false);
    expect(
      MediaAssetSchema.safeParse(
        asset({
          outputs: [
            output({
              publicPath:
                '/media/c9b5681a-36f0-49bf-a715-7604db77a32f/image.webp',
            }),
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      MediaOutputSchema.safeParse(output({ sha256: 'not-a-hash' })).success,
    ).toBe(false);
    expect(
      MediaOutputSchema.safeParse(output({ mimeType: 'video/webm' })).success,
    ).toBe(false);
    expect(
      MediaOutputSchema.safeParse(output({ durationSeconds: 2 })).success,
    ).toBe(false);
  });
  it('requires video and poster and real duration contracts', () => {
    const video = output({
      publicPath: `/media/${mediaId}/video.webm`,
      mimeType: 'video/webm',
      durationSeconds: 2,
    });
    const poster = output({ publicPath: `/media/${mediaId}/poster.webp` });
    expect(
      MediaAssetSchema.safeParse(asset({ kind: 'video', outputs: [video] }))
        .success,
    ).toBe(false);
    expect(
      MediaAssetSchema.parse(
        asset({
          kind: 'video',
          outputs: [video, poster],
          tools: { ffmpeg: '7.1', ffprobe: '7.1', sharp: '0.35.5' },
        }),
      ).kind,
    ).toBe('video');
  });
});

describe('API and job contracts', () => {
  it('strictly separates HTTP numeric query strings from data coercion', () => {
    expect(
      ArticleListQuerySchema.parse({
        page: '2',
        pageSize: '10',
        status: 'draft',
      }),
    ).toMatchObject({ page: 2, pageSize: 10 });
    for (const page of ['0', '01', '-2', '1.5', 'NaN', '1e3'])
      expect(ArticleListQuerySchema.safeParse({ page }).success).toBe(false);
    expect(ArticleListQuerySchema.safeParse({ page: 2 }).success).toBe(false);
    expect(
      ArticleListQuerySchema.safeParse({ orderBy: 'privatePath' }).success,
    ).toBe(false);
  });
  it('uses exact resource mutation requests', () => {
    expect(BuildJobRequestSchema.parse({})).toEqual({});
    expect(BuildJobRequestSchema.safeParse({ command: 'sh' }).success).toBe(
      false,
    );
    expect(
      CancellationRequestSchema.safeParse({ requested: false }).success,
    ).toBe(false);
    expect(
      TaxonomyMigrationRequestSchema.safeParse({
        kind: 'tag',
        from: 'example',
        to: 'renamed',
        workspaceRevision: hash,
        confirmed: true,
      }).success,
    ).toBe(false);
    expect(
      TaxonomyMigrationRequestSchema.parse({
        kind: 'tag',
        from: 'example',
        to: 'renamed',
        workspaceRevision: hash,
        confirmed: true,
        planId: mediaId,
      }).confirmed,
    ).toBe(true);
  });
  it('keeps progress unknown until total exists and validates terminal job states', () => {
    expect(JobSchema.parse(job()).progress.total).toBeNull();
    expect(
      JobSchema.safeParse(job({ progress: { completed: 2, total: 1 } }))
        .success,
    ).toBe(false);
    expect(
      JobSchema.safeParse(job({ createdAt: '2026-10-23T09:00:00+08:00' }))
        .success,
    ).toBe(false);
    expect(JobSchema.safeParse(job({ status: 'running' })).success).toBe(false);
    expect(
      JobSchema.safeParse(
        job({ status: 'succeeded', finishedAt: '2026-10-23T01:01:00Z' }),
      ).success,
    ).toBe(false);
    expect(
      JobSchema.parse(
        job({
          status: 'succeeded',
          startedAt: '2026-10-23T01:00:01Z',
          finishedAt: '2026-10-23T01:01:00Z',
          result: {
            outputDirectory: 'dist',
            snapshotRevision: hash,
            routeCount: 0,
            fileCount: 1,
            warnings: [],
          },
        }),
      ).status,
    ).toBe('succeeded');
    expect(
      JobSchema.safeParse(
        job({
          status: 'succeeded',
          startedAt: '2026-10-23T01:00:01Z',
          finishedAt: '2026-10-23T01:01:00Z',
          result: {
            outputDirectory: 'dist',
            snapshotRevision: hash,
            routeCount: 0,
            fileCount: 1,
            warnings: [],
            privatePath: '/tmp/private',
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      JobSchema.safeParse(
        job({ status: 'interrupted', finishedAt: '2026-10-23T01:01:00Z' }),
      ).success,
    ).toBe(false);
  });
  it('accepts structured errors while excluding arbitrary details and stack fields', () => {
    const error = {
      code: 'VALIDATION_FAILED',
      message: '請選擇分類。',
      retryable: false,
      requestId: mediaId,
      issues: [
        {
          path: ['meta', 'category'],
          code: 'REQUIRED',
          message: '請選擇分類。',
        },
      ],
    };
    expect(ApiErrorSchema.parse({ error }).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      ApiErrorSchema.safeParse({ error: { ...error, stack: 'private stack' } })
        .success,
    ).toBe(false);
  });
  it('exposes complete workspace limits without runtime environment', () => {
    expect(
      WorkspaceSchema.parse({
        revision: hash,
        editMode: 'studio',
        recoveryState: 'ready',
        diagnostics: [],
        limits: CONTENT_LIMITS,
      }).limits.pageBytes,
    ).toBe(256 * 1024);
  });
  it('distinguishes missing, unknown and proven current artifacts without accepting private fields', () => {
    expect(
      CurrentArtifactSchema.parse({ recoveryState: 'ready', current: null })
        .current,
    ).toBeNull();
    const unknown = {
      recoveryState: 'ready',
      current: { digest: hash, build: null },
    };
    expect(CurrentArtifactSchema.parse(unknown)).toEqual(unknown);
    const current = {
      recoveryState: 'ready',
      current: {
        digest: hash,
        build: {
          jobId: mediaId,
          committedAt: '2026-10-23T01:00:00.123Z',
          result: {
            outputDirectory: 'dist',
            snapshotRevision: hash,
            routeCount: 2,
            fileCount: 3,
            warnings: [],
          },
        },
      },
    };
    expect(CurrentArtifactSchema.parse(current)).toEqual(current);
    expect(
      CurrentArtifactSchema.safeParse({ ...current, privatePath: '/private' })
        .success,
    ).toBe(false);
    expect(
      CurrentArtifactSchema.safeParse({
        ...current,
        current: { ...current.current, digest: 'not-a-hash' },
      }).success,
    ).toBe(false);
    expect(
      CurrentArtifactSchema.safeParse({
        ...current,
        current: {
          ...current.current,
          build: { ...current.current.build, jobId: 'not-a-uuid' },
        },
      }).success,
    ).toBe(false);
    expect(
      CurrentArtifactSchema.safeParse({
        ...current,
        current: {
          ...current.current,
          build: {
            ...current.current.build,
            committedAt: '2026-10-23T09:00:00+08:00',
          },
        },
      }).success,
    ).toBe(false);
  });
  it('requires complete explicit recovery revision lists with unique resource keys', () => {
    const revision = {
      resourceKey: 'content/articles/article-one/meta.json',
      revision: null,
    };
    expect(
      RecoveryResolutionSchema.parse({
        choice: 'restore-trash',
        revisions: [revision],
      }).revisions[0]?.revision,
    ).toBeNull();
    expect(
      RecoveryResolutionSchema.safeParse({
        choice: 'restore-trash',
        revisions: [revision, revision],
      }).success,
    ).toBe(false);
    expect(
      RecoveryResolutionSchema.safeParse({
        choice: 'force',
        revisions: [revision],
      }).success,
    ).toBe(false);
  });
  it('rejects unknown search index versions and private fields', () => {
    expect(
      SearchIndexSchema.parse({ version: 1, articles: [] }).articles,
    ).toEqual([]);
    expect(
      SearchIndexSchema.safeParse({ version: 2, articles: [] }).success,
    ).toBe(false);
    expect(
      SearchIndexSchema.safeParse({
        version: 1,
        articles: [],
        sourcePath: '/private',
      }).success,
    ).toBe(false);
  });
});

it('日期契約精度為毫秒，超出時拒絕且不默默截斷', () => {
  expect(DateTimeSchema.safeParse('2026-10-23T00:00:00.123Z').success).toBe(
    true,
  );
  expect(DateTimeSchema.safeParse('2026-10-23T08:00:00.1+08:00').success).toBe(
    true,
  );
  expect(toUtcDateTime('2026-10-23T08:00:00.123+08:00')).toBe(
    '2026-10-23T00:00:00.123Z',
  );
  expect(DateTimeSchema.safeParse('2026-10-23T00:00:00.1234Z').success).toBe(
    false,
  );
  expect(
    DateTimeSchema.safeParse('2026-10-23T00:00:00.123456789Z').success,
  ).toBe(false);
});
