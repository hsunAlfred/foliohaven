import { describe, expect, it } from 'vitest';
import {
  ArticleListQuerySchema,
  ArticleMetaSchema,
  CategoriesSchema,
  FixedPageSchema,
  SiteConfigSchema,
  TagsSchema,
  ContentValidationError,
  articleUrl,
  categoryUrl,
  tagUrl,
  createRouteManifest,
  pageOutputPath,
  validateRouteManifest,
  buildSiteModel,
  previewArticle,
  paginate,
  categoryContains,
  categoryArticles,
  buildCategoryTree,
  planTaxonomyMigration,
  scanTaxonomyReferences,
  sortArticles,
  resolveSeo,
  serializeJsonLd,
  notFoundSeo,
  normalizeSearchQuery,
  parseSearchQuery,
  searchDocuments,
  searchQueryUrl,
  filterArticles,
  validateSiteLinks,
} from '@foliohaven/core';
import type { Article, SiteModelInput, SiteModel } from '@foliohaven/core';

function settings(overrides: Record<string, unknown> = {}) {
  return SiteConfigSchema.parse({
    siteName: '範例網站',
    siteDescription: '網站說明',
    siteUrl: 'https://example.invalid/',
    author: { name: '作者', url: null },
    pagination: { category: 2, tag: 2, articles: 2 },
    googleSiteVerification: 'verification-placeholder',
    ...overrides,
  });
}
function article(
  id: string,
  category = 'notes',
  change: Record<string, unknown> = {},
  contentHtml = '<h2 id="intro">介紹</h2><p>內容</p>',
): Article {
  return {
    articleId: id,
    contentHtml,
    meta: ArticleMetaSchema.parse({
      status: 'published',
      title: `標題 ${id}`,
      slug: id,
      category,
      tags: ['example'],
      publishedAt: '2026-10-23T09:00:00+08:00',
      updatedAt: '2026-10-23T09:00:00+08:00',
      seo: { description: `${id} description` },
      ...change,
    }),
  };
}
function input(overrides: Partial<SiteModelInput> = {}): SiteModelInput {
  return {
    site: settings(),
    categories: CategoriesSchema.parse([
      { path: 'notes', name: '筆記', description: 'Notes description' },
      { path: 'tools', name: '工具', description: 'Tools description' },
    ]),
    tags: TagsSchema.parse([
      { slug: 'example', name: '範例', description: 'Example description' },
    ]),
    articles: [
      article('alpha'),
      article('beta', 'tools'),
      article('gamma'),
      article('delta', 'notes', {
        seo: { description: 'Delta description', index: false },
      }),
      article('epsilon', 'tools', { tags: [] }),
    ],
    fixedPages: [
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
    ],
    now: '2026-10-23T12:00:00Z',
    ...overrides,
  };
}
function errors(callback: () => unknown): readonly string[] {
  try {
    callback();
  } catch (error) {
    if (error instanceof ContentValidationError)
      return error.diagnostics
        .filter((item) => item.severity === 'error')
        .map((item) => item.code);
    throw error;
  }
  throw new Error('預期驗證失敗，但函式成功。');
}
function list(model: SiteModel, kind: string, key: string, page = 1) {
  return model.listPages.find(
    (item) =>
      item.kind === kind && item.key === key && item.pagination.page === page,
  );
}

describe('unified public content model', () => {
  it('builds five articles with independent categories, shared tags and noindex kept public', () => {
    const model = buildSiteModel(input());
    expect(model.articlePages).toHaveLength(5);
    expect(model.searchIndex.articles).toHaveLength(5);
    expect(
      model.routeManifest.routes.filter(
        (route) => route.kind === 'article' && route.index,
      ),
    ).toHaveLength(4);
    expect(list(model, 'category', 'notes')?.pagination.totalPages).toBe(2);
    expect(list(model, 'category', 'tools')?.pagination.totalPages).toBe(1);
    expect(list(model, 'tag', 'example')?.pagination.totalPages).toBe(2);
    expect(
      list(model, 'category', 'notes')?.articles.every(
        (item) => item.category.path === 'notes',
      ),
    ).toBe(true);
    expect(
      list(model, 'category', 'tools')?.articles.every(
        (item) => item.category.path === 'tools',
      ),
    ).toBe(true);
    expect(
      model.articlePages.find((item) => item.articleId === 'delta')?.seo.index,
    ).toBe(false);
    expect(model.articles.map((item) => item.articleId)).toEqual([
      'alpha',
      'beta',
      'delta',
      'epsilon',
      'gamma',
    ]);
    expect(model.searchIndex.articles[0]?.publishedAt).toBe(
      '2026-10-23T01:00:00.000Z',
    );
  });
  it('does not read or publish draft body/media/sentinel and does not modify inputs', () => {
    const raw = input();
    const draft: Article = {
      articleId: 'draft-only',
      meta: ArticleMetaSchema.parse({ status: 'draft' }),
      contentHtml:
        '<h1>DRAFT_SENTINEL</h1><img src="/media/not-real/image.webp">',
    };
    const candidate = { ...raw, articles: [...raw.articles, draft] };
    const before = JSON.stringify(candidate);
    const model = buildSiteModel(candidate);
    expect(JSON.stringify(candidate)).toBe(before);
    expect(Object.isFrozen(candidate.site)).toBe(false);
    expect(Object.isFrozen(candidate.articles[0])).toBe(false);
    expect(Object.isFrozen(candidate.articles[0]?.meta)).toBe(false);
    expect(Object.isFrozen(candidate.articles[0]?.meta.tags)).toBe(false);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.articlePages[0]?.meta.tags)).toBe(true);
    expect(JSON.stringify(model)).not.toContain('DRAFT_SENTINEL');
    expect(model.mediaRefs).toEqual([]);
  });
  it('supports a truly empty site with one noindex page for empty taxonomy', () => {
    const model = buildSiteModel(input({ articles: [] }));
    expect(model.articlePages).toEqual([]);
    expect(model.home.latest).toEqual([]);
    const empty = list(model, 'category', 'notes');
    expect(empty?.pagination.totalPages).toBe(1);
    expect(empty?.articles).toEqual([]);
    expect(empty?.seo.index).toBe(false);
    expect(
      model.routeManifest.routes.some((route) => route.path.endsWith('/1/')),
    ).toBe(false);
    expect(
      model.routeManifest.routes.some(
        (route) => route.path === '/category/notes/2/',
      ),
    ).toBe(false);
  });
  it('aggregates explicit parent, all descendants, boundary matches and unique article IDs', () => {
    const categories = CategoriesSchema.parse([
      { path: 'notes', name: '筆記', description: '筆記' },
      { path: 'notes/child', name: '子分類', description: '子分類' },
      { path: 'notes-other', name: '其他', description: '其他' },
    ]);
    const articles = [
      article('parent'),
      ...['child-a', 'child-b', 'child-c', 'child-d'].map((id) =>
        article(id, 'notes/child'),
      ),
      article('other', 'notes-other'),
    ];
    const model = buildSiteModel(input({ categories, articles }));
    expect(list(model, 'category', 'notes')?.pagination.totalPages).toBe(3);
    expect(list(model, 'category', 'notes/child')?.pagination.totalPages).toBe(
      2,
    );
    expect(categoryContains('notes', 'notes-other')).toBe(false);
    expect(
      categoryArticles('notes', [...articles, ...articles.slice(0, 1)]),
    ).toHaveLength(5);
    expect(
      buildCategoryTree(categories, articles).find(
        (item) => item.path === 'notes',
      )?.children[0]?.articleCount,
    ).toBe(4);
  });
  it('rejects unknown references, invalid featured selections and missing fixed registry', () => {
    expect(
      errors(() =>
        buildSiteModel(input({ articles: [article('bad', 'missing')] })),
      ),
    ).toContain('UNKNOWN_CATEGORY');
    expect(
      errors(() =>
        buildSiteModel(
          input({ articles: [article('bad', 'notes', { tags: ['missing'] })] }),
        ),
      ),
    ).toContain('UNKNOWN_TAG');
    expect(
      errors(() =>
        buildSiteModel(
          input({
            site: settings({ home: { featuredArticleIds: ['missing'] } }),
          }),
        ),
      ),
    ).toContain('INVALID_FEATURED_ARTICLE');
    expect(errors(() => buildSiteModel(input({ fixedPages: [] })))).toContain(
      'MISSING_FIXED_PAGE',
    );
  });
  it('does not synthesize fallback for malformed status or duplicate ID', () => {
    const raw = article('bad');
    const corrupted = {
      ...raw,
      meta: { ...raw.meta, status: 'scheduled' },
    } as unknown as Article;
    expect(
      errors(() => buildSiteModel(input({ articles: [corrupted] }))),
    ).toContain('SCHEMA_VALIDATION_FAILED');
    expect(
      errors(() => buildSiteModel(input({ articles: [raw, raw] }))),
    ).toContain('DUPLICATE_ARTICLE_ID');
  });
  it('warns about future publication without changing status or dates', () => {
    const future = article('future', 'notes', {
      publishedAt: '2099-01-01T00:00:00Z',
      updatedAt: '2099-01-01T00:00:00Z',
    });
    const model = buildSiteModel(input({ articles: [future] }));
    expect(model.articlePages).toHaveLength(1);
    expect(
      model.diagnostics.some(
        (item) =>
          item.code === 'FUTURE_PUBLICATION_DATE' &&
          item.severity === 'warning',
      ),
    ).toBe(true);
    expect(model.articles[0]?.meta.publishedAt).toBe('2099-01-01T00:00:00Z');
  });
  it('makes media incompleteness explicit and excludes draft-only references', () => {
    const mediaId = 'b9b5681a-36f0-49bf-a715-7604db77a32f';
    const image = `/media/${mediaId}/image.webp`;
    const articles = [
      article('image', 'notes', { featuredImage: image, featuredImageAlt: '' }),
    ];
    const model = buildSiteModel(input({ articles }));
    expect(model.mediaPending).toBe(true);
    expect(model.mediaRefs).toEqual([image]);
    expect(
      errors(() =>
        buildSiteModel(
          input({ articles, mediaManifest: { schemaVersion: 1, assets: [] } }),
        ),
      ),
    ).toContain('MEDIA_NOT_FOUND');
  });
});

describe('routing and stable pagination', () => {
  it('creates one URL policy and permits equal slugs in distinct categories', () => {
    expect(articleUrl('notes/child', 'hello')).toBe('/notes/child/hello/');
    expect(categoryUrl('notes')).toBe('/category/notes/');
    expect(categoryUrl('notes', 2)).toBe('/category/notes/2/');
    expect(tagUrl('example', 2)).toBe('/tag/example/2/');
    expect(pageOutputPath('/')).toBe('index.html');
    expect(pageOutputPath('/notes/hello/')).toBe('notes/hello/index.html');
    expect(
      buildSiteModel(
        input({
          articles: [article('one'), article('two', 'tools', { slug: 'one' })],
        }),
      ).articlePages,
    ).toHaveLength(2);
    expect(() => articleUrl('notes', '123')).toThrow();
  });
  it('rejects complete route collisions', () => {
    const base = input();
    const fixed = FixedPageSchema.parse({
      id: 'collision',
      path: '/notes/alpha/',
      entry: 'src/pages/collision.astro',
    });
    expect(
      errors(() =>
        buildSiteModel({ ...base, fixedPages: [...base.fixedPages, fixed] }),
      ),
    ).toContain('ROUTE_COLLISION');
  });
  it.each([
    { defaultIndex: true, index: null },
    { defaultIndex: false, index: null },
    { defaultIndex: true, index: false },
    { defaultIndex: false, index: true },
  ])(
    'permits taxonomy overview roots with canonical and sitemap index policy ($defaultIndex / $index)',
    ({ defaultIndex, index }) => {
      const base = input({
        site: settings({ defaultSEO: { index: defaultIndex } }),
      });
      const overviews = ['category', 'tag'].map((kind) =>
        FixedPageSchema.parse({
          id: `${kind}-overview`,
          path: `/${kind}/`,
          entry: `src/pages/${kind}/index.astro`,
          seo: { index },
        }),
      );
      const model = buildSiteModel({
        ...base,
        fixedPages: [...base.fixedPages, ...overviews],
      });
      const expectedIndex = index ?? defaultIndex;
      for (const page of overviews) {
        const seo = resolveSeo({
          site: base.site,
          title: page.id,
          path: page.path,
          seo: page.seo,
        });
        expect(seo.canonical).toBe(`https://example.invalid${page.path}`);
        expect(seo.index).toBe(expectedIndex);
        expect(
          model.routeManifest.routes.filter(
            (route) => route.path === page.path,
          ),
        ).toEqual([
          {
            kind: 'fixed',
            path: page.path,
            outputPath: `${page.path.slice(1)}index.html`,
            index: expectedIndex,
          },
        ]);
      }
      const overviewPaths = new Set(overviews.map((page) => page.path));
      expect(
        model.routeManifest.routes
          .filter((route) => route.index && overviewPaths.has(route.path))
          .map((route) => route.path),
      ).toEqual(expectedIndex ? ['/category/', '/tag/'] : []);
      expect(
        model.routeManifest.routes.find(
          (route) => route.path === '/category/notes/',
        )?.kind,
      ).toBe('category');
      expect(
        model.routeManifest.routes.find(
          (route) => route.path === '/tag/example/',
        )?.kind,
      ).toBe('tag');
    },
  );
  it.each([
    '/category/extra/',
    '/category/extra/child/',
    '/category/notes/2/',
    '/tag/extra/',
    '/tag/example/2/',
    '/assets/',
    '/assets/extra/',
    '/media/',
    '/media/extra/',
    '/_astro/',
    '/_astro/extra/',
    '/articles/extra/',
    '/articles/2/',
  ])('keeps the fixed-page namespace reserved at %s', (path) => {
    const base = input();
    const reserved = FixedPageSchema.parse({
      id: 'reserved',
      path,
      entry: 'src/pages/reserved.astro',
    });
    expect(
      errors(() =>
        buildSiteModel({ ...base, fixedPages: [...base.fixedPages, reserved] }),
      ),
    ).toContain('RESERVED_FIXED_PAGE_ROUTE');
  });
  it('permits nested directory pages but rejects file-directory output collisions', () => {
    const routes = ['/foo/', '/foo/bar/'].map((path) => ({
      kind: 'fixed' as const,
      path,
      outputPath: pageOutputPath(path),
      index: true,
    }));
    expect(validateRouteManifest(createRouteManifest(routes))).toEqual([]);
    expect(
      validateRouteManifest(createRouteManifest(routes, ['/foo']))[0]?.code,
    ).toBe('OUTPUT_FILE_DIRECTORY_COLLISION');
    const fixed = FixedPageSchema.parse({
      id: 'rss-child',
      path: '/rss.xml/child/',
      entry: 'src/pages/rss-child.astro',
    });
    const base = input();
    expect(
      errors(() =>
        buildSiteModel({ ...base, fixedPages: [...base.fixedPages, fixed] }),
      ),
    ).toContain('OUTPUT_FILE_DIRECTORY_COLLISION');
  });
  it.each([
    '/foo//bar',
    '/foo/',
    '/%2e%2e/file',
    '/foo\u0000bar',
    '/foo\u0001bar',
    '/foo bar',
  ])('rejects ambiguous asset route %s', (asset) => {
    expect(
      validateRouteManifest({ routes: [], assets: [asset] })[0]?.code,
    ).toBe('INVALID_ASSET_ROUTE');
  });
  it('uses UTC instant then ASCII ID and leaves caller arrays untouched', () => {
    const records = [
      article('z', 'notes', {
        publishedAt: '2026-10-23T09:00:00+08:00',
        updatedAt: '2026-10-23T09:00:00+08:00',
      }),
      article('a', 'notes', {
        publishedAt: '2026-10-23T01:00:00Z',
        updatedAt: '2026-10-23T01:00:00Z',
      }),
    ];
    expect(sortArticles(records).map((item) => item.articleId)).toEqual([
      'a',
      'z',
    ]);
    expect(records[0]?.articleId).toBe('z');
    expect(paginate(records, 1, 2).items).toHaveLength(2);
    expect(paginate(records, 2, 2).validPage).toBe(false);
    expect(paginate([], 1, 2).totalPages).toBe(1);
  });
});

describe('links and draft preview', () => {
  it('checks Unicode self and cross-article anchors with safe locations', () => {
    const model = buildSiteModel(
      input({
        articles: [
          article(
            'one',
            'notes',
            {},
            '<h2 id="章節">章節</h2><a href="#%E7%AB%A0%E7%AF%80">自己</a><a href="/tools/two/#target">下一篇</a>',
          ),
          article('two', 'tools', {}, '<h2 id="target">Target</h2>'),
        ],
      }),
    );
    expect(
      model.diagnostics.filter((item) => item.severity === 'error'),
    ).toEqual([]);
    expect(
      errors(() =>
        buildSiteModel(
          input({
            articles: [
              article(
                'bad',
                'notes',
                {},
                '<h2 id="intro">介紹</h2>\n<a href="#missing">失效</a>',
              ),
            ],
          }),
        ),
      ),
    ).toContain('BROKEN_FRAGMENT');
    expect(
      errors(() =>
        buildSiteModel(
          input({
            articles: [
              article('bad', 'notes', {}, '<a href="/missing/">失效</a>'),
            ],
          }),
        ),
      ),
    ).toContain('BROKEN_INTERNAL_LINK');
  });
  it('reports malformed or traversing links through diagnostics instead of throwing URL errors', () => {
    const model = buildSiteModel(input());
    const source = [
      {
        articleId: 'one',
        path: '/notes/one/',
        ids: [],
        links: [
          { href: 'http://' },
          { href: '/%2e%2e/articles/' },
          { href: 'javascript:alert(1)' },
        ],
      },
    ];
    const result = validateSiteLinks(source, model.routeManifest, {
      siteUrl: 'https://example.invalid/',
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'INVALID_LINK_ENCODING',
      'INVALID_INTERNAL_LINK',
      'INVALID_INTERNAL_LINK',
    ]);
  });
  it('records generated-page fragments until final rendered HTML is available', () => {
    const model = buildSiteModel(
      input({
        articles: [
          article(
            'one',
            'notes',
            {},
            '<a href="/articles/#ui-search">搜尋</a>',
          ),
        ],
      }),
    );
    expect(model.pendingLinkChecks).toHaveLength(1);
    const source = [
      {
        articleId: 'one',
        path: '/notes/one/',
        ids: [],
        links: [{ href: '/articles/#ui-search' }],
      },
    ];
    expect(
      validateSiteLinks(source, model.routeManifest, {
        pageIds: { '/articles/': ['ui-search'] },
      }).diagnostics,
    ).toEqual([]);
    expect(
      validateSiteLinks(source, model.routeManifest).diagnostics[0]?.code,
    ).toBe('UNKNOWN_FRAGMENT_TARGET');
  });
  it('keeps incomplete drafts renderable with null URL and no fake breadcrumb link', () => {
    const base = input();
    const article: Article = {
      articleId: 'draft-test',
      meta: ArticleMetaSchema.parse({ status: 'draft' }),
      contentHtml: '<p>尚未完成</p>',
    };
    const preview = previewArticle({ ...base, article });
    expect(preview.context).toBe('preview');
    expect(preview.url).toBeNull();
    expect(preview.publishable).toBe(false);
    expect(preview.breadcrumb.at(-1)?.url).toBeNull();
    expect(preview.seo.index).toBe(false);
    expect(preview.contentHtml).toBe(article.contentHtml);
  });
  it('previews links to generated category and tag second pages', () => {
    const base = input();
    const draft = article(
      'fresh',
      'notes',
      { status: 'draft' },
      '<a href="/category/notes/2/">分類第二頁</a><a href="/tag/example/2/">標籤第二頁</a>',
    );
    expect(previewArticle({ ...base, article: draft }).publishable).toBe(true);
  });
  it('previews the same complete article shape and detects publication conflicts', () => {
    const base = input();
    const draft = article('fresh', 'notes', { status: 'draft' });
    const preview = previewArticle({ ...base, article: draft });
    expect(preview.url).toBe('/notes/fresh/');
    expect(preview.publishable).toBe(true);
    expect(preview.toc).toEqual([{ id: 'intro', level: 2, text: '介紹' }]);
    const duplicate = article('fresh', 'notes', {
      status: 'draft',
      slug: 'alpha',
    });
    expect(
      previewArticle({ ...base, article: duplicate }).diagnostics.some(
        (item) => item.code === 'ROUTE_COLLISION',
      ),
    ).toBe(true);
  });
});

describe('preview and migration consistency regressions', () => {
  it('uses the public route validator to reject preview file-directory collisions', () => {
    const base = input();
    const fixed = FixedPageSchema.parse({
      id: 'file-collision',
      path: '/notes/fresh/index.html/',
      entry: 'src/pages/notes/fresh/index.html/index.astro',
    });
    const draft = article('fresh', 'notes', { status: 'draft' });
    const preview = previewArticle({
      ...base,
      fixedPages: [...base.fixedPages, fixed],
      article: draft,
    });
    expect(preview.publishable).toBe(false);
    expect(
      preview.diagnostics.some(
        (item) => item.code === 'OUTPUT_FILE_DIRECTORY_COLLISION',
      ),
    ).toBe(true);
    expect(
      errors(() =>
        buildSiteModel({
          ...base,
          fixedPages: [...base.fixedPages, fixed],
          articles: [
            ...base.articles,
            {
              ...draft,
              meta: ArticleMetaSchema.parse({
                ...draft.meta,
                status: 'published',
              }),
            },
          ],
        }),
      ),
    ).toContain('OUTPUT_FILE_DIRECTORY_COLLISION');
  });
  it('checks the inherited social image through the same full media closure', () => {
    const base = input();
    const id = 'b9b5681a-36f0-49bf-a715-7604db77a32f';
    const path = `/media/${id}/image.webp`;
    const site = settings({ social: { defaultImage: path } });
    const draft = article('fresh', 'notes', { status: 'draft' });
    const missing = previewArticle({
      ...base,
      site,
      article: draft,
      mediaManifest: { schemaVersion: 1, assets: [] },
    });
    expect(missing.publishable).toBe(false);
    expect(
      missing.diagnostics.some((item) => item.code === 'MEDIA_NOT_FOUND'),
    ).toBe(true);
    const pending = previewArticle({ ...base, site, article: draft });
    expect(pending.publishable).toBe(false);
    expect(
      pending.diagnostics.some(
        (item) => item.code === 'MEDIA_VALIDATION_PENDING',
      ),
    ).toBe(true);
    const available = previewArticle({
      ...base,
      site,
      article: draft,
      mediaManifest: {
        schemaVersion: 1,
        assets: [
          {
            id,
            kind: 'image',
            sourceSha256: 'a'.repeat(64),
            presetVersion: 'image-v1',
            tools: { sharp: '0.35.5' },
            outputs: [
              {
                publicPath: path,
                mimeType: 'image/webp',
                width: 1280,
                height: 720,
                byteSize: 1000,
                sha256: 'b'.repeat(64),
              },
            ],
          },
        ],
      },
    });
    expect(available.publishable).toBe(true);
    expect(available.seo.openGraph.image).toBe(
      `https://example.invalid${path}`,
    );
  });
  it('normalizes same-origin encoded navigation consistently for build, references and migration', () => {
    const base = input({ articles: [] });
    const site = settings({
      navigation: [
        {
          label: '筆記',
          href: 'https://example.invalid/category/%6eotes/?ref=nav#top',
        },
      ],
    });
    expect(buildSiteModel({ ...base, site }).diagnostics).toEqual([]);
    const references = scanTaxonomyReferences({
      kind: 'category',
      key: 'notes',
      site,
      articles: [],
      categories: base.categories,
    });
    expect(references.referenced).toBe(true);
    expect(references.navigationReferences).toEqual([0]);
    const plan = planTaxonomyMigration({
      ...base,
      site,
      kind: 'category',
      from: 'notes',
      to: 'guides',
    });
    expect(plan.next.site.navigation[0]?.href).toBe(
      'https://example.invalid/category/guides/?ref=nav#top',
    );
    expect(buildSiteModel({ ...base, ...plan.next }).diagnostics).toEqual([]);
  });
  it('deduplicates tag migration results when a draft already carries the new unresolved tag', () => {
    const base = input();
    const draft = article('draft', 'notes', {
      status: 'draft',
      tags: ['example', 'renamed'],
    });
    const plan = planTaxonomyMigration({
      ...base,
      articles: [draft],
      kind: 'tag',
      from: 'example',
      to: 'renamed',
    });
    expect(plan.next.articles[0]?.meta.tags).toEqual(['renamed']);
    expect(
      plan.next.articles.every(
        (item) => ArticleMetaSchema.safeParse(item.meta).success,
      ),
    ).toBe(true);
    expect(plan.affectedArticleIds).toEqual(['draft']);
    expect(draft.meta.tags).toEqual(['example', 'renamed']);
  });
});

describe('SEO models and safe structured data', () => {
  it('uses explicit complete title and inheritance, then appends list page number', () => {
    const site = settings({
      defaultSEO: { index: false },
      social: { twitterSite: '@example' },
    });
    const inherited = resolveSeo({
      site,
      title: '標題',
      path: '/category/notes/',
    });
    expect(inherited.title).toBe('標題 | 範例網站');
    expect(inherited.index).toBe(false);
    const override = resolveSeo({
      site,
      title: '原始',
      path: '/category/notes/2/',
      page: 2,
      seo: {
        title: '完整標題',
        description: '覆寫',
        index: true,
        ogImage: null,
      },
    });
    expect(override.title).toBe('完整標題（第 2 頁）');
    expect(override.canonical).toBe(
      'https://example.invalid/category/notes/2/',
    );
    expect(override.index).toBe(true);
    expect(notFoundSeo(site).canonical).toBeNull();
    expect(notFoundSeo(site).index).toBe(false);
  });
  it('emits article dates, breadcrumbs, homepage-only GSC and omits absent image keys', () => {
    const model = buildSiteModel(input());
    const article = model.articlePages[0];
    expect(article?.seo.googleSiteVerification).toBeNull();
    expect(model.home.seo.googleSiteVerification).toBe(
      'verification-placeholder',
    );
    expect(article?.seo.twitter.card).toBe('summary');
    const blog = article?.seo.jsonLd.find(
      (item) => item['@type'] === 'BlogPosting',
    );
    expect(blog?.['datePublished']).toBe('2026-10-23T01:00:00.000Z');
    expect(blog).not.toHaveProperty('image');
    expect(Object.isFrozen(blog)).toBe(true);
    expect(Object.isFrozen(blog?.['author'])).toBe(true);
    expect(
      article?.seo.jsonLd.some((item) => item['@type'] === 'BreadcrumbList'),
    ).toBe(true);
    expect(
      serializeJsonLd({ text: '</script><script>alert(1)</script>\u2028' }),
    ).not.toContain('</script>');
    expect(
      JSON.parse(serializeJsonLd({ text: '</script>\u2028\u2029' })),
    ).toEqual({ text: '</script>\u2028\u2029' });
  });
  it('falls back article OG to featured image and all other pages only to social default', () => {
    const id = 'b9b5681a-36f0-49bf-a715-7604db77a32f';
    const featured = `/media/${id}/image.webp`;
    const poster = `/media/${id}/poster.webp`;
    const site = settings({ social: { defaultImage: poster } });
    expect(
      resolveSeo({
        site,
        title: '文章',
        path: '/notes/a/',
        kind: 'article',
        featuredImage: featured,
      }).openGraph.image,
    ).toBe(`https://example.invalid${featured}`);
    expect(
      resolveSeo({
        site,
        title: '列表',
        path: '/category/notes/',
        featuredImage: featured,
      }).openGraph.image,
    ).toBe(`https://example.invalid${poster}`);
  });
});

describe('search and taxonomy operations', () => {
  it('normalizes NFKC/case/whitespace and OR-ranks only indexed fields', () => {
    expect(normalizeSearchQuery('  ＡＬＰＨＡ\t Description  ')).toBe(
      'alpha description',
    );
    const model = buildSiteModel(input());
    expect(
      searchDocuments(
        model.searchIndex.articles,
        '?q=ALPHA+description',
        2,
      ).items.map((item) => item.id),
    ).toEqual(['alpha', 'beta']);
    expect(
      searchDocuments(
        model.searchIndex.articles,
        '?q=alpha+not-present',
        2,
      ).items.map((item) => item.id),
    ).toEqual(['alpha']);
    expect(
      searchDocuments(model.searchIndex.articles, '?q=內容', 2).items,
    ).toEqual([]);
    expect(
      searchDocuments(model.searchIndex.articles, '?page=99', 2).validPage,
    ).toBe(false);
  });
  it('supports first duplicate params, unknown params, shareable URL and invalid-page errors', () => {
    expect(
      parseSearchQuery('?q=alpha&q=beta&page=2&page=3&unknown=yes'),
    ).toEqual({
      q: 'alpha',
      categories: [],
      tags: [],
      page: 2,
      valid: true,
      error: null,
    });
    for (const page of ['0', '-1', '01', 'NaN', '1.5'])
      expect(parseSearchQuery(`?page=${page}`).valid).toBe(false);
    expect(parseSearchQuery(`?q=${'x'.repeat(201)}`).error).toBe(
      'QUERY_TOO_LONG',
    );
    expect(searchQueryUrl(' ALPHA ', 1)).toBe('/articles/?q=alpha');
    expect(searchQueryUrl('', 1)).toBe('/articles/');
    expect(searchQueryUrl('alpha', 2)).toBe('/articles/?q=alpha&page=2');
    expect(
      filterArticles(
        input().articles,
        ArticleListQuerySchema.parse({
          category: 'tools',
          sort: 'id-asc',
          pageSize: '2',
        }),
      ).items.map((item) => item.articleId),
    ).toEqual(['beta', 'epsilon']);
  });
  it('shares taxonomy display-name filtering with Studio without duplicating search rules', () => {
    const base = input();
    expect(
      filterArticles(
        base.articles,
        ArticleListQuerySchema.parse({ q: '筆記 範例' }),
        { categories: base.categories, tags: base.tags },
      ).items.map((item) => item.articleId),
    ).toEqual(['alpha', 'delta', 'gamma']);
  });
  it('plans category subtree migration across all statuses and navigation without rewriting HTML', () => {
    const categories = CategoriesSchema.parse([
      { path: 'notes', name: '筆記', description: '筆記' },
      { path: 'notes/child', name: '子分類', description: '子分類' },
    ]);
    const articles = [
      article('parent'),
      article('child', 'notes/child'),
      article('draft', 'notes/child', { status: 'draft' }),
    ];
    const site = settings({
      navigation: [
        { label: '筆記', href: '/category/notes/' },
        { label: '文章', href: '/notes/child/child/' },
      ],
    });
    const original = JSON.stringify({ categories, articles, site });
    const plan = planTaxonomyMigration({
      kind: 'category',
      from: 'notes',
      to: 'guides',
      categories,
      tags: input().tags,
      articles,
      site,
    });
    expect(plan.affectedArticleIds).toEqual(['child', 'draft', 'parent']);
    expect(plan.next.categories.map((item) => item.path)).toEqual([
      'guides',
      'guides/child',
    ]);
    expect(plan.next.site.navigation.map((item) => item.href)).toEqual([
      '/category/guides/',
      '/guides/child/child/',
    ]);
    expect(plan.next.articles[0]?.contentHtml).toBe(articles[0]?.contentHtml);
    expect(plan.changedUrls).toHaveLength(3);
    expect(JSON.stringify({ categories, articles, site })).toBe(original);
    expect(
      scanTaxonomyReferences({
        kind: 'category',
        key: 'notes',
        articles,
        categories,
        site,
      }),
    ).toMatchObject({
      articleCount: 3,
      childCategoryPaths: ['notes/child'],
      navigationReferences: [0, 1],
      referenced: true,
    });
  });
  it('migrates tags without article URL changes and rejects collisions or missing parents', () => {
    const base = input();
    const plan = planTaxonomyMigration({
      ...base,
      kind: 'tag',
      from: 'example',
      to: 'renamed',
    });
    expect(plan.next.tags[0]?.slug).toBe('renamed');
    expect(plan.changedUrls).toEqual([]);
    expect(
      plan.next.articles.find((item) => item.articleId === 'alpha')?.meta.tags,
    ).toEqual(['renamed']);
    expect(() =>
      planTaxonomyMigration({
        ...base,
        kind: 'category',
        from: 'notes',
        to: 'tools',
      }),
    ).toThrow();
    expect(() =>
      planTaxonomyMigration({
        ...base,
        kind: 'category',
        from: 'notes',
        to: 'missing/child',
      }),
    ).toThrow();
    expect(() =>
      planTaxonomyMigration({
        ...base,
        kind: 'tag',
        from: 'missing',
        to: 'renamed',
      }),
    ).toThrow();
  });
});
