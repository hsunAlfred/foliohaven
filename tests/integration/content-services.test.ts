import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArticleResourceSchema,
  FixedPageSchema,
  PublishedArticleMetaSchema,
  SiteConfigSchema,
  TaxonomySchema,
  ContentValidationError,
  buildSiteModel,
  CONTENT_LIMITS,
} from '@foliohaven/core';
import type {
  ArticleResource,
  ArticleWrite,
  MediaManifest,
  Diagnostic,
} from '@foliohaven/core';
import { loadContent } from '@foliohaven/core/node';
import {
  ContentService,
  ContentServiceError,
  FileRepository,
} from '@foliohaven/server';
import type { ContentServiceOptions, Versioned } from '@foliohaven/server';

let root: string;
let repository: FileRepository;
let service: ContentService;
let clockMs: number;
let manifest: MediaManifest | undefined;
const now = () => new Date(clockMs);
const fixedPages = [
  FixedPageSchema.parse({
    id: 'home',
    path: '/',
    entry: 'src/pages/index.astro',
  }),
  FixedPageSchema.parse({
    id: 'articles',
    path: '/articles/',
    entry: 'src/pages/articles/index.astro',
  }),
];
const initialSite = () =>
  SiteConfigSchema.parse({
    siteName: '測試網站',
    siteDescription: '完整 domain 測試',
    siteUrl: 'https://example.invalid/',
    author: { name: '作者', url: null },
    pagination: { category: 2, tag: 2, articles: 2 },
  });
const initialTaxonomy = () =>
  TaxonomySchema.parse({
    categories: [{ path: 'notes', name: '筆記', description: '筆記資料' }],
    tags: [{ slug: 'example', name: '範例', description: '範例資料' }],
  });
async function writeJson(path: string, value: unknown) {
  await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}
async function scanInputs(): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (path: string): Promise<void> => {
    for (const item of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      if (item.name === '.alfred') continue;
      const full = join(path, item.name);
      if (item.isDirectory()) await walk(full);
      else {
        const key = relative(root, full);
        const bytes = await readFile(full);
        hash.update(`${key.length}:${key}:${bytes.length}:`);
        hash.update(bytes);
      }
    }
  };
  await walk(root);
  return hash.digest('hex');
}
function options(): ContentServiceOptions {
  return {
    repository,
    fixedPages,
    scanInputs,
    clock: now,
    getMediaManifest: async () => manifest ?? { schemaVersion: 1, assets: [] },
  };
}
async function createDraft(
  contentHtml = '<p>原始  文字</p>\n',
  change: Record<string, unknown> = {},
) {
  return service.createArticle({
    contentHtml,
    meta: { status: 'draft', ...change },
  });
}
function publishedWrite(
  slug: string,
  contentHtml = '<h2 id="intro">介紹</h2>\n<p>文章  內容</p>\n',
): ArticleWrite {
  return {
    contentHtml,
    meta: {
      status: 'published',
      title: `文章 ${slug}`,
      excerpt: '',
      relatedReading: { title: '延伸閱讀', articleIds: [] },
      slug,
      category: 'notes',
      tags: ['example'],
      publishedAt: '2026-10-23T09:00:00+08:00',
      updatedAt: '2026-10-23T09:00:00+08:00',
      featuredImage: null,
      featuredImageAlt: '',
      seo: {
        title: null,
        description: `${slug} 摘要`,
        index: null,
        ogImage: null,
      },
    },
  };
}
async function publish(
  slug: string,
  contentHtml?: string,
): Promise<Versioned<ArticleResource>> {
  const draft = await createDraft();
  return service.putArticle(
    draft.value.id,
    publishedWrite(slug, contentHtml),
    draft.etag,
  );
}
async function bytes(id: string) {
  return {
    html: await readFile(join(root, `content/articles/${id}/content.html`)),
    meta: await readFile(join(root, `content/articles/${id}/meta.json`)),
  };
}
async function coreDiagnostics(): Promise<readonly Diagnostic[]> {
  try {
    return buildSiteModel({
      ...(await loadContent(root, { mode: 'preview' })),
      fixedPages,
      mediaManifest: manifest ?? { schemaVersion: 1, assets: [] },
      now: now().toISOString(),
    }).diagnostics;
  } catch (error) {
    if (error instanceof ContentValidationError) return error.diagnostics;
    throw error;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'alfred-content-services-'));
  clockMs = Date.parse('2026-10-23T12:00:00Z');
  manifest = undefined;
  await mkdir(join(root, 'content/articles'), { recursive: true });
  await writeJson('content/site.json', initialSite());
  const taxonomy = initialTaxonomy();
  await writeJson('content/categories.json', taxonomy.categories);
  await writeJson('content/tags.json', taxonomy.tags);
  repository = new FileRepository({ repositoryRoot: root, clock: now });
  await repository.initialize();
  service = new ContentService(options());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('article domain transactions', () => {
  it('creates a complete server-named draft and preserves raw HTML and UTC response dates', async () => {
    const original = '<!-- author -->\n<p class="x">  未格式化   內容 </p>\n';
    const created = await createDraft(original);
    expect(created.value.id).toMatch(/^article-[0-9a-f-]{36}$/);
    expect(created.value.meta.status).toBe('draft');
    expect(created.value.contentHtml).toBe(original);
    expect(ArticleResourceSchema.safeParse(created.value).success).toBe(true);
    expect(created.value.diagnostics.length).toBeGreaterThan(0);
    const raw = await bytes(created.value.id);
    expect(raw.html.toString()).toBe(original);
    expect(raw.meta.toString()).toBe(
      `${JSON.stringify(created.value.meta, null, 2)}\n`,
    );
    const loaded = await service.getArticle(created.value.id);
    expect(loaded.etag).toBe(created.etag);
    const published = await service.putArticle(
      created.value.id,
      publishedWrite('first', original),
      created.etag,
    );
    expect(published.value.meta.publishedAt).toBe('2026-10-23T01:00:00.000Z');
    expect(
      JSON.parse((await bytes(created.value.id)).meta.toString()).publishedAt,
    ).toBe('2026-10-23T09:00:00+08:00');
    expect((await bytes(created.value.id)).html.toString()).toBe(original);
  });
  it('distinguishes an absent article from an incomplete pair and returns its actual ETag', async () => {
    await expect(service.getArticle('missing-article')).rejects.toMatchObject({
      status: 404,
      code: 'ARTICLE_NOT_FOUND',
    });
    const created = await createDraft();
    await rm(join(root, `content/articles/${created.value.id}/meta.json`));
    await expect(service.getArticle(created.value.id)).rejects.toMatchObject({
      status: 422,
      code: 'SOURCE_INCOMPLETE',
      etag: expect.stringMatching(/^"[a-f0-9]{64}"$/),
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          resource: `content/articles/${created.value.id}/meta.json`,
        }),
      ]),
    });
    expect(
      await readFile(
        join(root, `content/articles/${created.value.id}/content.html`),
        'utf8',
      ),
    ).toBe('<p>原始  文字</p>\n');
  });
  it('rejects creating article 10001 before adding any new source directory', async () => {
    // 只建立目錄以驗證集合上限，不建立或解析一萬份假正文。
    for (let offset = 0; offset < 10_000; offset += 100)
      await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          mkdir(join(root, `content/articles/article-${offset + index}`)),
        ),
      );
    await expect(createDraft()).rejects.toMatchObject({
      code: 'ARTICLE_CAPACITY_EXCEEDED',
      status: 422,
    });
    expect(await readdir(join(root, 'content/articles'))).toHaveLength(10_000);
  });
  it('does not allow initial published status or unknown write fields', async () => {
    await expect(
      service.createArticle(publishedWrite('initial')),
    ).rejects.toMatchObject({
      code: 'INITIAL_STATUS_MUST_BE_DRAFT',
      status: 422,
    });
    await expect(
      service.createArticle({
        contentHtml: '',
        meta: { status: 'draft' },
        id: 'forced-id',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect((await service.listArticles()).items).toEqual([]);
  });
  it('saves unfinished draft semantics but strictly rejects invalid types/dates/CRLF', async () => {
    const created = await createDraft('<h1>未完成</h1>\n', {
      slug: 'Not Ready',
      category: 'not defined',
      tags: ['not-yet-defined'],
    });
    expect(created.value.meta.status).toBe('draft');
    for (const meta of [
      { status: 'draft', publishedAt: '2026-02-30T00:00:00Z' },
      { status: 'draft', title: null },
      { status: 'draft', tags: 'example' },
    ])
      await expect(
        service.putArticle(
          created.value.id,
          { contentHtml: '', meta },
          created.etag,
        ),
      ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.putArticle(
        created.value.id,
        { contentHtml: '<p>\r\n</p>', meta: { status: 'draft' } },
        created.etag,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect((await service.getArticle(created.value.id)).etag).toBe(
      created.etag,
    );
  });
  it('rejects invalid publication without installing either candidate file', async () => {
    const created = await createDraft();
    const previous = await bytes(created.value.id);
    const bad = publishedWrite('bad', '<h1>錯誤</h1>\n');
    await expect(
      service.putArticle(created.value.id, bad, created.etag),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(await bytes(created.value.id)).toEqual(previous);
    const missingPublicationDate = {
      ...publishedWrite('bad'),
      meta: { ...publishedWrite('bad').meta, publishedAt: null },
    };
    expect(
      PublishedArticleMetaSchema.safeParse(missingPublicationDate.meta).success,
    ).toBe(false);
    await expect(
      service.putArticle(
        created.value.id,
        missingPublicationDate,
        created.etag,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(await bytes(created.value.id)).toEqual(previous);
  });
  it('publishes empty per-article SEO, reloads null overrides and resolves the current inherited description and source', async () => {
    const site = initialSite();
    const globalDescription = '網站共用的 Meta Description。';
    const inherited = SiteConfigSchema.parse({
      ...site,
      defaultSEO: { ...site.defaultSEO, description: globalDescription },
      pageSEO: {
        ...site.pageSEO,
        article: { ...site.pageSEO.article, descriptionSource: 'inherit' },
      },
    });
    await writeJson('content/site.json', inherited);
    const created = await createDraft();
    const payload = publishedWrite('inherited-seo');
    const saved = await service.putArticle(
      created.value.id,
      { ...payload, meta: { ...payload.meta, seo: {} } },
      created.etag,
    );
    expect(saved.value.meta.status).toBe('published');
    const reopened = new ContentService(options());
    const reloaded = await reopened.getArticle(created.value.id);
    expect(reloaded.etag).toBe(saved.etag);
    expect(reloaded.value.meta.seo.description).toBeNull();
    const stored = PublishedArticleMetaSchema.parse(
      JSON.parse(
        await readFile(
          join(root, `content/articles/${created.value.id}/meta.json`),
          'utf8',
        ),
      ),
    );
    expect(stored.seo.description).toBeNull();

    const effectiveArticle = async () =>
      buildSiteModel({
        ...(await loadContent(root, { mode: 'public' })),
        fixedPages,
        mediaManifest: { schemaVersion: 1, assets: [] },
        now: now().toISOString(),
      }).articlePages.find((article) => article.articleId === created.value.id);
    expect((await effectiveArticle())?.seo).toMatchObject({
      description: globalDescription,
      sources: { description: 'global' },
    });

    const articleDescription = '文章頁共用的 Meta Description。';
    await writeJson('content/site.json', {
      ...inherited,
      pageSEO: {
        ...inherited.pageSEO,
        article: {
          ...inherited.pageSEO.article,
          descriptionSource: 'custom',
          description: articleDescription,
        },
      },
    });
    expect(
      (await reopened.getArticle(created.value.id)).value.meta.seo.description,
    ).toBeNull();
    expect((await effectiveArticle())?.seo).toMatchObject({
      description: articleDescription,
      sources: { description: 'pageType' },
    });
  });
  it('uses full routes and media for publication and never pretends pending media is ready', async () => {
    const created = await createDraft();
    const image = '/media/b9b5681a-36f0-49bf-a715-7604db77a32f/image.webp';
    const payload = publishedWrite('image');
    const imagePayload = {
      ...payload,
      meta: { ...payload.meta, featuredImage: image },
    };
    await expect(
      service.putArticle(created.value.id, imagePayload, created.etag),
    ).rejects.toMatchObject({
      status: 422,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'MEDIA_NOT_FOUND' }),
      ]),
    });
    const noProvider = new ContentService({
      repository,
      fixedPages,
      scanInputs,
      clock: now,
    });
    await expect(
      noProvider.putArticle(created.value.id, imagePayload, created.etag),
    ).rejects.toMatchObject({
      status: 422,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'MEDIA_VALIDATION_PENDING' }),
      ]),
    });
    const first = await publish('duplicate');
    await expect(
      service.putArticle(
        created.value.id,
        publishedWrite('duplicate'),
        created.etag,
      ),
    ).rejects.toMatchObject({
      status: 422,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'ROUTE_COLLISION' }),
      ]),
    });
    expect((await service.getArticle(first.value.id)).value.meta.status).toBe(
      'published',
    );
  });
  it('enforces exact If-Match and preserves a later IDE edit', async () => {
    const created = await createDraft();
    await expect(
      service.putArticle(
        created.value.id,
        { contentHtml: '', meta: { status: 'draft' } },
        undefined,
      ),
    ).rejects.toMatchObject({ status: 428 });
    await expect(
      service.putArticle(
        created.value.id,
        { contentHtml: '', meta: { status: 'draft' } },
        '*',
      ),
    ).rejects.toMatchObject({ status: 400 });
    const saved = await service.putArticle(
      created.value.id,
      {
        contentHtml: '<p>最新</p>\n',
        meta: { status: 'draft', title: '最新' },
      },
      created.etag,
    );
    await expect(
      service.putArticle(
        created.value.id,
        { contentHtml: '<p>舊</p>', meta: { status: 'draft' } },
        created.etag,
      ),
    ).rejects.toMatchObject({ status: 412, etag: saved.etag });
    await writeFile(
      join(root, `content/articles/${created.value.id}/content.html`),
      '<p>IDE changed</p>\n',
    );
    await expect(
      service.putArticle(
        created.value.id,
        { contentHtml: 'overwrite', meta: { status: 'draft' } },
        saved.etag,
      ),
    ).rejects.toMatchObject({ status: 412 });
    expect((await bytes(created.value.id)).html.toString()).toBe(
      '<p>IDE changed</p>\n',
    );
  });
  it('rechecks cross-resource dependencies after preparing a published transaction', async () => {
    const created = await createDraft();
    const before = await bytes(created.value.id);
    let changed = false;
    const guardedRepository = new FileRepository({
      repositoryRoot: root,
      clock: now,
      fault: async (event) => {
        if (!changed && event.phase === 'prepared-journal') {
          changed = true;
          await writeJson('content/categories.json', []);
        }
      },
    });
    const guarded = new ContentService({
      ...options(),
      repository: guardedRepository,
    });
    await expect(
      guarded.putArticle(
        created.value.id,
        publishedWrite('guarded'),
        created.etag,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'EXTERNAL_CHANGE' });
    expect(await bytes(created.value.id)).toEqual(before);
    expect(
      JSON.parse(await readFile(join(root, 'content/categories.json'), 'utf8')),
    ).toEqual([]);
  });
  it('supports explicit publication PATCH without auto-updating author dates', async () => {
    const full = publishedWrite('patch');
    const draft = await createDraft(full.contentHtml, {
      ...full.meta,
      status: 'draft',
    });
    const published = await service.patchPublication(
      draft.value.id,
      {
        status: 'published',
        publishedAt: '2026-10-23T09:00:00+08:00',
        updatedAt: '2026-10-23T09:00:00+08:00',
      },
      draft.etag,
    );
    expect(published.value.meta.status).toBe('published');
    const previous = await bytes(draft.value.id);
    const withdrawn = await service.patchPublication(
      draft.value.id,
      {
        status: 'draft',
        publishedAt: published.value.meta.publishedAt,
        updatedAt: published.value.meta.updatedAt,
      },
      published.etag,
    );
    expect(withdrawn.value.meta.status).toBe('draft');
    expect((await bytes(draft.value.id)).html).toEqual(previous.html);
    clockMs += 86_400_000;
    const loaded = await service.getArticle(draft.value.id);
    expect(loaded.value.meta.updatedAt).toBe(published.value.meta.updatedAt);
  });
  it('lists drafts and published records with shared filters/sort/pagination and retains corrupted files', async () => {
    await publish('one');
    await publish('two');
    await createDraft('', {
      title: '草稿',
      category: 'notes',
      tags: ['example'],
    });
    const listed = await service.listArticles({
      status: 'published',
      q: '筆記 範例',
      page: '1',
      pageSize: '1',
    });
    expect(listed.total).toBe(2);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.meta.status).toBe('published');
    const broken = await createDraft();
    await writeFile(
      join(root, `content/articles/${broken.value.id}/meta.json`),
      '{ broken JSON',
    );
    await expect(service.getArticle(broken.value.id)).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_JSON',
    });
    await expect(service.listArticles()).rejects.toMatchObject({
      status: 422,
      code: 'SOURCE_INVALID',
    });
    expect((await bytes(broken.value.id)).meta.toString()).toBe(
      '{ broken JSON',
    );
  });
  it.each(['json', 'status', 'pair', 'symlink', 'oversize'] as const)(
    'management lists still reject structural %s failures instead of swallowing them as diagnostics',
    async (failure) => {
      const draft = await createDraft();
      const directory = join(root, 'content/articles', draft.value.id);
      if (failure === 'json')
        await writeFile(join(directory, 'meta.json'), '{ malformed JSON');
      if (failure === 'status')
        await writeJson(`content/articles/${draft.value.id}/meta.json`, {
          ...draft.value.meta,
          status: 'unknown',
        });
      if (failure === 'pair') await rm(join(directory, 'content.html'));
      if (failure === 'symlink') {
        const outside = join(root, 'outside.html');
        await writeFile(outside, '<p>external source</p>');
        await rm(join(directory, 'content.html'));
        await symlink(outside, join(directory, 'content.html'));
      }
      if (failure === 'oversize')
        await writeFile(
          join(directory, 'content.html'),
          'x'.repeat(CONTENT_LIMITS.articleHtmlBytes + 1),
        );
      await expect(service.listArticles()).rejects.toMatchObject({
        status: failure === 'symlink' ? 409 : 422,
        ...(failure === 'symlink' ? { code: 'RESOURCE_SYMLINK' } : {}),
      });
    },
  );
  it('blocks Studio writes in IDE mode while keeping reads available', async () => {
    const created = await createDraft();
    const workspace = await repository.workspace({ scanInputs });
    const ide = await repository.setEditMode('ide', workspace.etag, {
      scanInputs,
    });
    await expect(
      service.putArticle(
        created.value.id,
        { contentHtml: '', meta: { status: 'draft' } },
        created.etag,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'IDE_EDIT_MODE' });
    expect((await service.getArticle(created.value.id)).value.id).toBe(
      created.value.id,
    );
    await repository.setEditMode('studio', ide.etag, { scanInputs });
    await expect(
      service.putArticle(
        created.value.id,
        { contentHtml: '再次保存', meta: { status: 'draft' } },
        created.etag,
      ),
    ).resolves.toMatchObject({ value: { contentHtml: '再次保存' } });
  });
  it('deletes into recoverable trash and does not alter an existing dist artifact', async () => {
    const created = await createDraft();
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.html'), 'LAST_GOOD_DIST');
    const deleted = await service.deleteArticle(created.value.id, created.etag);
    await expect(service.getArticle(created.value.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await repository.listRecoveries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: deleted.transactionId, kind: 'trash' }),
      ]),
    );
    const recovery = await repository.recovery(deleted.transactionId);
    expect(
      recovery.value.resources.some((resource) =>
        resource.base.text?.includes('原始'),
      ),
    ).toBe(true);
    expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toBe(
      'LAST_GOOD_DIST',
    );
  });
  it('rejects deleting featured, navigation and article-body references with safe diagnostics', async () => {
    const target = await publish('target');
    const settings = await service.getSiteSettings();
    const featured = await service.putSiteSettings(
      {
        ...settings.value,
        home: { ...settings.value.home, featuredArticleIds: [target.value.id] },
      },
      settings.etag,
    );
    await expect(
      service.deleteArticle(target.value.id, target.etag),
    ).rejects.toMatchObject({ status: 409, code: 'ARTICLE_IN_USE' });
    const cleared = await service.putSiteSettings(
      {
        ...featured.value,
        home: { ...featured.value.home, featuredArticleIds: [] },
        navigation: [{ label: '目標', href: '/notes/target/' }],
      },
      featured.etag,
    );
    await expect(
      service.deleteArticle(target.value.id, target.etag),
    ).rejects.toMatchObject({ status: 409, code: 'ARTICLE_IN_USE' });
    await service.putSiteSettings(
      { ...cleared.value, navigation: [] },
      cleared.etag,
    );
    await publish('source', '<a href="/notes/target/#intro">參照</a>');
    try {
      await service.deleteArticle(target.value.id, target.etag);
      throw new Error('should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ContentServiceError);
      if (error instanceof ContentServiceError) {
        expect(error.status).toBe(409);
        expect(
          error.diagnostics.some(
            (item) => item.code === 'BROKEN_INTERNAL_LINK',
          ),
        ).toBe(true);
        expect(JSON.stringify(error.diagnostics)).not.toContain(root);
      }
    }
  });
  it('stores the original create operation response and ETag even after later edits', async () => {
    const receipt = {
      id: randomUUID(),
      key: randomUUID(),
      payloadHash: 'a'.repeat(64),
      httpStatus: 201,
    };
    const created = await service.createArticle(
      { contentHtml: '<p>原始冪等結果</p>\n', meta: { status: 'draft' } },
      { operation: receipt },
    );
    await service.putArticle(
      created.value.id,
      {
        contentHtml: '<p>後續修改</p>\n',
        meta: { status: 'draft', title: '已變更' },
      },
      created.etag,
    );
    const recorded = (await repository.listCommittedOperations()).find(
      (item) => item.id === receipt.id,
    );
    expect(recorded?.response).toEqual(created.value);
    expect(recorded?.headers).toEqual({
      ETag: created.etag,
      Location: `/api/v1/articles/${created.value.id}`,
    });
    expect(recorded?.resourceUrl).toBe(`/api/v1/articles/${created.value.id}`);
  });
});

describe('taxonomy/settings transactions and migration plans', () => {
  it('uses raw taxonomy/site ETags and rejects missing or stale versions', async () => {
    const taxonomy = await service.getTaxonomy();
    await expect(
      service.putTaxonomy(taxonomy.value, undefined),
    ).rejects.toMatchObject({ status: 428 });
    const changed = await service.putTaxonomy(
      {
        ...taxonomy.value,
        categories: taxonomy.value.categories.map((category) => ({
          ...category,
          name: '改名',
        })),
      },
      taxonomy.etag,
    );
    expect(changed.etag).not.toBe(taxonomy.etag);
    await expect(
      service.putTaxonomy(taxonomy.value, taxonomy.etag),
    ).rejects.toMatchObject({ status: 412 });
    const settings = await service.getSiteSettings();
    const updated = await service.putSiteSettings(
      { ...settings.value, siteName: '新站名' },
      settings.etag,
    );
    expect(updated.value.siteName).toBe('新站名');
    await expect(
      service.putSiteSettings(settings.value, settings.etag),
    ).rejects.toMatchObject({ status: 412 });
  });
  it('rejects the real serialized UTF-8 taxonomy size before modifying either file', async () => {
    const original = await service.getTaxonomy();
    const categories = await readFile(join(root, 'content/categories.json'));
    const tags = await readFile(join(root, 'content/tags.json'));
    const oversized = Array.from({ length: 4000 }, (_, index) => ({
      slug: `tag-${index}`,
      name: '中'.repeat(120),
      description: '文'.repeat(300),
    }));
    expect(
      Buffer.byteLength(
        JSON.stringify({
          categories: original.value.categories,
          tags: oversized,
        }),
      ),
    ).toBeLessThan(32 * 1024 * 1024);
    expect(
      Buffer.byteLength(JSON.stringify(oversized, null, 2)),
    ).toBeGreaterThan(4 * 1024 * 1024);
    await expect(
      service.putTaxonomy(
        { categories: original.value.categories, tags: oversized },
        original.etag,
      ),
    ).rejects.toMatchObject({ status: 413, code: 'SOURCE_TOO_LARGE' });
    expect(await readFile(join(root, 'content/categories.json'))).toEqual(
      categories,
    );
    expect(await readFile(join(root, 'content/tags.json'))).toEqual(tags);
    expect((await service.getTaxonomy()).etag).toBe(original.etag);
  });
  it('does not delete taxonomy referenced by draft articles or child categories', async () => {
    const draft = await createDraft('', {
      category: 'notes',
      tags: ['example'],
    });
    const taxonomy = await service.getTaxonomy();
    await expect(
      service.putTaxonomy(
        { categories: [], tags: taxonomy.value.tags },
        taxonomy.etag,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'TAXONOMY_IN_USE',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ articleId: draft.value.id }),
      ]),
    });
    await expect(
      service.putTaxonomy(
        { categories: taxonomy.value.categories, tags: [] },
        taxonomy.etag,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'TAXONOMY_IN_USE' });
    expect((await service.getTaxonomy()).etag).toBe(taxonomy.etag);
  });
  it('reports child-category and navigation references before deleting taxonomy', async () => {
    const current = await service.getTaxonomy();
    const withChild = await service.putTaxonomy(
      {
        ...current.value,
        categories: [
          ...current.value.categories,
          { path: 'notes/child', name: '子分類', description: '子分類說明' },
        ],
      },
      current.etag,
    );
    await expect(
      service.putTaxonomy(
        { ...withChild.value, categories: [] },
        withChild.etag,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'TAXONOMY_IN_USE',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'CHILD_CATEGORY_REFERENCE',
          path: ['categories', 'notes/child'],
        }),
      ]),
    });
    const site = await service.getSiteSettings();
    await service.putSiteSettings(
      { ...site.value, navigation: [{ label: '範例', href: '/tag/example/' }] },
      site.etag,
    );
    await expect(
      service.putTaxonomy({ ...withChild.value, tags: [] }, withChild.etag),
    ).rejects.toMatchObject({
      status: 409,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'NAVIGATION_REFERENCE',
          path: ['site', 'navigation', 0],
        }),
      ]),
    });
  });
  it('validates complete site navigation and inherited media without installing invalid settings', async () => {
    const settings = await service.getSiteSettings();
    const before = await readFile(join(root, 'content/site.json'));
    await expect(
      service.putSiteSettings(
        {
          ...settings.value,
          navigation: [{ label: '不存在', href: '/missing/' }],
        },
        settings.etag,
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.putSiteSettings(
        {
          ...settings.value,
          social: {
            defaultImage:
              '/media/b9b5681a-36f0-49bf-a715-7604db77a32f/image.webp',
            twitterSite: null,
          },
        },
        settings.etag,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await readFile(join(root, 'content/site.json'))).toEqual(before);
  });
  it('plans without source changes and migrates category definitions, articles and encoded navigation atomically', async () => {
    const parent = await publish('parent');
    const draft = await createDraft('', {
      category: 'notes',
      tags: ['example'],
    });
    const settings = await service.getSiteSettings();
    await service.putSiteSettings(
      {
        ...settings.value,
        navigation: [
          { label: '筆記', href: 'https://example.invalid/category/%6eotes/' },
        ],
      },
      settings.etag,
    );
    const before = await scanInputs();
    const plan = await service.planMigration({
      kind: 'category',
      from: 'notes',
      to: 'guides',
      workspaceRevision: before,
    });
    expect(await scanInputs()).toBe(before);
    expect(plan.affectedArticleIds.sort()).toEqual(
      [parent.value.id, draft.value.id].sort(),
    );
    expect(plan.navigationReferences).toEqual([0]);
    const oldHtml = (await bytes(parent.value.id)).html;
    const migrated = await service.executeMigration({
      kind: 'category',
      from: 'notes',
      to: 'guides',
      workspaceRevision: before,
      planId: plan.planId,
    });
    expect(
      migrated.value.changedUrls.some(
        (item) =>
          item.from === '/notes/parent/' && item.to === '/guides/parent/',
      ),
    ).toBe(true);
    expect(
      (await service.getArticle(parent.value.id)).value.meta.category,
    ).toBe('guides');
    expect((await service.getArticle(draft.value.id)).value.meta.category).toBe(
      'guides',
    );
    expect((await service.getSiteSettings()).value.navigation[0]?.href).toBe(
      'https://example.invalid/category/guides/',
    );
    expect((await bytes(parent.value.id)).html).toEqual(oldHtml);
  });
  it('preserves old HTML links after migration and reports that Build must wait for repair', async () => {
    const target = await publish('target');
    const source = await publish(
      'source',
      '<a href="/notes/target/#intro">舊站內連結</a>\n',
    );
    const revision = await scanInputs();
    const plan = await service.planMigration({
      kind: 'category',
      from: 'notes',
      to: 'guides',
      workspaceRevision: revision,
    });
    const result = await service.executeMigration({
      kind: 'category',
      from: 'notes',
      to: 'guides',
      workspaceRevision: revision,
      planId: plan.planId,
    });
    expect(
      result.diagnostics.some((item) => item.code === 'BROKEN_INTERNAL_LINK'),
    ).toBe(true);
    expect((await bytes(source.value.id)).html.toString()).toContain(
      '/notes/target/#intro',
    );
    expect(
      (await service.getArticle(target.value.id)).value.meta.category,
    ).toBe('guides');
    const listed = await service.listArticles();
    expect(listed.total).toBe(2);
    const expected = (await coreDiagnostics()).filter(
      (diagnostic) => diagnostic.articleId === source.value.id,
    );
    expect(expected).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'BROKEN_INTERNAL_LINK',
        articleId: source.value.id,
        resource: `content/articles/${source.value.id}/content.html`,
      }),
    ]);
    expect(
      listed.items.find((item) => item.id === source.value.id)?.diagnostics,
    ).toEqual(expected);
    expect(
      listed.items.find((item) => item.id === target.value.id)?.diagnostics,
    ).toEqual([]);
  });
  it('repairs two published articles one by one after migration without rewriting the other source or weakening Core Build', async () => {
    const target = await publish('target');
    const first = await publish(
      'first',
      '<h2 id="first">第一篇</h2><a href="/notes/target/#intro">連結</a>',
    );
    const second = await publish(
      'second',
      '<h2 id="second">第二篇</h2><a href="/notes/target/#intro">連結</a>',
    );
    const revision = await scanInputs();
    const plan = await service.planMigration({
      kind: 'category',
      from: 'notes',
      to: 'guides',
      workspaceRevision: revision,
    });
    await service.executeMigration({ ...plan });
    const listed = await service.listArticles();
    expect(listed.total).toBe(3);
    const expectedErrors = (await coreDiagnostics()).filter(
      (item) => item.severity === 'error',
    );
    expect(expectedErrors.map((item) => item.articleId).sort()).toEqual(
      [first.value.id, second.value.id].sort(),
    );
    for (const id of [first.value.id, second.value.id])
      expect(listed.items.find((item) => item.id === id)?.diagnostics).toEqual(
        expectedErrors.filter((item) => item.articleId === id),
      );
    const secondBefore = await bytes(second.value.id);
    const targetBefore = await bytes(target.value.id);
    const firstRead = await service.getArticle(first.value.id);
    const repairedFirst = await service.putArticle(
      first.value.id,
      {
        contentHtml: firstRead.value.contentHtml.replace(
          '/notes/target/',
          '/guides/target/',
        ),
        meta: firstRead.value.meta,
      },
      firstRead.etag,
    );
    expect(repairedFirst.value.meta.status).toBe('published');
    expect(
      (await coreDiagnostics()).filter((item) => item.severity === 'error'),
    ).toEqual(
      expectedErrors.filter((item) => item.articleId === second.value.id),
    );
    expect(await bytes(second.value.id)).toEqual(secondBefore);
    expect(await bytes(target.value.id)).toEqual(targetBefore);
    const secondRead = await service.getArticle(second.value.id);
    await service.putArticle(
      second.value.id,
      {
        contentHtml: secondRead.value.contentHtml.replace(
          '/notes/target/',
          '/guides/target/',
        ),
        meta: secondRead.value.meta,
      },
      secondRead.etag,
    );
    expect(
      (await coreDiagnostics()).filter((item) => item.severity === 'error'),
    ).toEqual([]);
    expect(
      (await service.listArticles()).items.every(
        (item) => item.diagnostics.length === 0,
      ),
    ).toBe(true);
  });
  it('rejects a new error on another unchanged article even with an existing error of the same code', async () => {
    const target = await publish('target');
    const other = await publish(
      'other',
      '<h2 id="other">其他篇</h2><a href="/notes/target/#intro">原本有效</a>',
    );
    await writeFile(
      join(root, `content/articles/${other.value.id}/content.html`),
      '<h2 id="other">其他篇</h2><a href="/notes/target/#missing">原有錯誤</a>\n<a href="/notes/target/#intro">原本有效</a>',
    );
    const current = await service.getArticle(target.value.id);
    const before = await bytes(target.value.id);
    const otherBefore = await bytes(other.value.id);
    const baseline = (await coreDiagnostics()).filter(
      (item) => item.severity === 'error',
    );
    expect(baseline).toHaveLength(1);
    expect(baseline[0]).toMatchObject({
      code: 'BROKEN_FRAGMENT',
      articleId: other.value.id,
    });
    await expect(
      service.putArticle(
        target.value.id,
        {
          contentHtml: '<h2 id="replacement">新標題</h2>',
          meta: current.value.meta,
        },
        current.etag,
      ),
    ).rejects.toMatchObject({
      status: 422,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'BROKEN_FRAGMENT',
          articleId: other.value.id,
        }),
      ]),
    });
    expect(await bytes(target.value.id)).toEqual(before);
    expect(await bytes(other.value.id)).toEqual(otherBefore);
  });
  it('does not allow a candidate error or a pre-existing global error to use the other-article exemption', async () => {
    const target = await publish('target');
    const other = await publish('other');
    await writeFile(
      join(root, `content/articles/${other.value.id}/content.html`),
      '<h2>其他篇缺id</h2>',
    );
    const current = await service.getArticle(target.value.id);
    const before = await bytes(target.value.id);
    await expect(
      service.putArticle(
        target.value.id,
        { contentHtml: '<h2>本篇也缺id</h2>', meta: current.value.meta },
        current.etag,
      ),
    ).rejects.toMatchObject({
      status: 422,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'HTML_HEADING_ID_REQUIRED',
          articleId: target.value.id,
        }),
      ]),
    });
    expect(await bytes(target.value.id)).toEqual(before);
    await writeJson('content/site.json', {
      ...initialSite(),
      navigation: [{ label: '未知頁', href: '/missing-page/' }],
    });
    const latest = await service.getArticle(target.value.id);
    await expect(
      service.putArticle(
        target.value.id,
        { contentHtml: latest.value.contentHtml, meta: latest.value.meta },
        latest.etag,
      ),
    ).rejects.toMatchObject({
      status: 422,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'INVALID_NAVIGATION',
          resource: 'content/site.json',
        }),
      ]),
    });
    expect(await bytes(target.value.id)).toEqual(before);
  });
  it('guards the raw bytes of exempted other articles through the prepared-journal boundary', async () => {
    const target = await publish('target');
    const other = await publish('other');
    const otherKey = `content/articles/${other.value.id}/content.html`;
    await writeFile(join(root, otherKey), '<h2>既有缺id</h2>');
    const current = await service.getArticle(target.value.id);
    const before = await bytes(target.value.id);
    const external = '<h2>外部改了另一篇</h2>';
    repository = new FileRepository({
      repositoryRoot: root,
      clock: now,
      fault: async (event) => {
        if (event.phase === 'prepared-journal')
          await writeFile(join(root, otherKey), external);
      },
    });
    service = new ContentService(options());
    await expect(
      service.putArticle(
        target.value.id,
        {
          contentHtml: '<h2 id="intro">修復保存</h2>',
          meta: current.value.meta,
        },
        current.etag,
      ),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    expect(await bytes(target.value.id)).toEqual(before);
    expect(await readFile(join(root, otherKey), 'utf8')).toBe(external);
  });
  it('does not swallow pre-existing bad body links as an allowed migration effect', async () => {
    const source = await publish('source');
    await writeFile(
      join(root, `content/articles/${source.value.id}/content.html`),
      '<a href="/already-missing/">既有錯誤</a>',
    );
    const revision = await scanInputs();
    const plan = await service.planMigration({
      kind: 'category',
      from: 'notes',
      to: 'guides',
      workspaceRevision: revision,
    });
    await expect(
      service.executeMigration({
        kind: 'category',
        from: 'notes',
        to: 'guides',
        workspaceRevision: revision,
        planId: plan.planId,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect((await service.getTaxonomy()).value.categories[0]?.path).toBe(
      'notes',
    );
  });
  it('invalidates plans after source/code changes, expiry or a coordinated edit-then-revert', async () => {
    const revision = await scanInputs();
    const plan = await service.planMigration({
      kind: 'tag',
      from: 'example',
      to: 'renamed',
      workspaceRevision: revision,
    });
    await writeFile(join(root, 'app.ts'), 'export const changed = true;\n');
    await expect(
      service.executeMigration({
        kind: 'tag',
        from: 'example',
        to: 'renamed',
        workspaceRevision: revision,
        planId: plan.planId,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'MIGRATION_PLAN_STALE' });
    await rm(join(root, 'app.ts'));
    const fresh = await service.planMigration({
      kind: 'tag',
      from: 'example',
      to: 'renamed',
      workspaceRevision: await scanInputs(),
    });
    clockMs += 600_001;
    await expect(
      service.executeMigration({
        kind: 'tag',
        from: 'example',
        to: 'renamed',
        workspaceRevision: fresh.workspaceRevision,
        planId: fresh.planId,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'MIGRATION_PLAN_STALE' });
    // 先保存一次完整正規化設定，之後變更再還原才是相同 raw bytes。
    const canonical = await service.getSiteSettings();
    await service.putSiteSettings(canonical.value, canonical.etag);
    const reverted = await service.planMigration({
      kind: 'tag',
      from: 'example',
      to: 'renamed',
      workspaceRevision: await scanInputs(),
    });
    const site = await service.getSiteSettings();
    const changed = await service.putSiteSettings(
      { ...site.value, siteName: 'changed' },
      site.etag,
    );
    await service.putSiteSettings(site.value, changed.etag);
    expect(await scanInputs()).toBe(reverted.workspaceRevision);
    await expect(
      service.executeMigration({
        kind: 'tag',
        from: 'example',
        to: 'renamed',
        workspaceRevision: reverted.workspaceRevision,
        planId: reverted.planId,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'MIGRATION_PLAN_STALE' });
  });
  it('deduplicates unresolved draft tags during a real multi-file migration', async () => {
    const draft = await createDraft('', {
      category: 'notes',
      tags: ['example', 'renamed'],
    });
    const revision = await scanInputs();
    const plan = await service.planMigration({
      kind: 'tag',
      from: 'example',
      to: 'renamed',
      workspaceRevision: revision,
    });
    await service.executeMigration({
      kind: 'tag',
      from: 'example',
      to: 'renamed',
      workspaceRevision: revision,
      planId: plan.planId,
    });
    expect((await service.getArticle(draft.value.id)).value.meta.tags).toEqual([
      'renamed',
    ]);
    expect((await service.getTaxonomy()).value.tags[0]?.slug).toBe('renamed');
  });
});
