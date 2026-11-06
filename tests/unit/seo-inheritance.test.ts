import { describe, expect, it } from 'vitest';
import {
  ArticleMetaSchema,
  ArticleListQuerySchema,
  CategoriesSchema,
  ContentValidationError,
  FixedPageSchema,
  SEO_PAGE_TYPES,
  SeoOverrideSchema,
  SiteConfigSchema,
  TagsSchema,
  buildSiteModel,
  notFoundSeo,
  previewArticle,
  resolveArticleDescription,
  resolveSeo,
  filterArticles,
} from '@foliohaven/core';
import type { Article, SiteConfig } from '@foliohaven/core';

const globalImage = '/media/11111111-1111-4111-8111-111111111111/image.webp';
const typeImage = '/media/22222222-2222-4222-8222-222222222222/image.webp';
const ownImage = '/media/33333333-3333-4333-8333-333333333333/image.webp';
function site(change: Record<string, unknown> = {}) {
  return SiteConfigSchema.parse({
    siteName: 'Inheritance Site',
    siteDescription: 'Global description',
    siteUrl: 'https://example.invalid/',
    author: { name: 'Author' },
    defaultSEO: {
      titleTemplate: '{title} | {siteName}',
      description: 'Global SEO description',
      index: true,
    },
    ...change,
  });
}
function article(id: string, change: Record<string, unknown> = {}): Article {
  return {
    articleId: id,
    contentHtml: '<h2 id="intro">內容</h2><p>正文</p>',
    meta: ArticleMetaSchema.parse({
      status: 'published',
      title: `Article ${id}`,
      slug: id,
      category: 'notes',
      tags: [],
      publishedAt: '2026-10-20T00:00:00Z',
      updatedAt: '2026-10-21T00:00:00Z',
      seo: { description: `SEO ${id}` },
      ...change,
    }),
  };
}
function input(
  settings: SiteConfig = site(),
  articles: Article[] = [article('alpha'), article('beta')],
) {
  return {
    site: settings,
    articles,
    categories: CategoriesSchema.parse([
      { path: 'notes', name: 'Notes', description: 'Category content' },
    ]),
    tags: TagsSchema.parse([]),
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
      FixedPageSchema.parse({
        id: 'category-index',
        path: '/category/',
        entry: 'src/pages/category/index.astro',
      }),
      FixedPageSchema.parse({
        id: 'tag-index',
        path: '/tag/',
        entry: 'src/pages/tag/index.astro',
      }),
    ],
    now: '2026-10-23T00:00:00Z',
  };
}

describe('three-level SEO inheritance', () => {
  it('resolves each field independently and preserves a page-type false index', () => {
    const settings = site({
      social: { defaultImage: globalImage },
      pageSEO: {
        article: {
          titleTemplate: 'Type {title}',
          descriptionSource: 'custom',
          description: 'Type description',
          index: false,
          imageSource: 'custom',
          ogImage: typeImage,
        },
      },
    });
    const result = resolveSeo({
      site: settings,
      pageType: 'article',
      kind: 'article',
      title: 'A',
      path: '/notes/a/',
      seo: SeoOverrideSchema.parse({ title: 'Own complete title' }),
      featuredImage: ownImage,
    });
    expect(result.title).toBe('Own complete title');
    expect(result.description).toBe('Type description');
    expect(result.index).toBe(false);
    expect(result.openGraph.image).toBe(`https://example.invalid${typeImage}`);
    expect(result.sources).toEqual({
      title: 'override',
      description: 'pageType',
      index: 'pageType',
      image: 'pageType',
    });
  });
  it('keeps inherited fields null rather than materializing effective values', () => {
    const settings = site({
      pageSEO: {
        article: {
          titleTemplate: null,
          descriptionSource: 'inherit',
          index: null,
          imageSource: 'inherit',
        },
      },
    });
    const result = resolveSeo({
      site: settings,
      pageType: 'article',
      title: 'A',
      path: '/notes/a/',
      contentDescription: 'Ignored content',
    });
    expect(settings.pageSEO.article.titleTemplate).toBeNull();
    expect(settings.pageSEO.article.description).toBeNull();
    expect(settings.pageSEO.article.index).toBeNull();
    expect(settings.pageSEO.article.ogImage).toBeNull();
    expect(result.title).toBe('A | Inheritance Site');
    expect(result.description).toBe('Global SEO description');
    expect(result.sources).toEqual({
      title: 'global',
      description: 'global',
      index: 'global',
      image: 'global',
    });
  });
  it('uses an automatic content description only when selected and falls back when empty', () => {
    const settings = site({
      pageSEO: { article: { descriptionSource: 'content' } },
    });
    const resolved = (contentDescription: string) =>
      resolveSeo({
        site: settings,
        pageType: 'article',
        title: 'A',
        contentDescription,
        path: '/notes/a/',
      });
    expect(resolved('Article excerpt').description).toBe('Article excerpt');
    expect(resolved('Article excerpt').sources.description).toBe('content');
    expect(resolved('').description).toBe('Global SEO description');
    expect(resolved('').sources.description).toBe('global');
  });
  it('distinguishes explicit no-image from inheritance and featured-image fallback', () => {
    const settings = site({ social: { defaultImage: globalImage } });
    const base = {
      site: settings,
      pageType: 'article' as const,
      kind: 'article' as const,
      title: 'A',
      path: '/notes/a/',
    };
    expect(
      resolveSeo({ ...base, featuredImage: ownImage }).openGraph.image,
    ).toBe(`https://example.invalid${ownImage}`);
    expect(resolveSeo(base).openGraph.image).toBe(
      `https://example.invalid${globalImage}`,
    );
    const none = resolveSeo({
      ...base,
      featuredImage: ownImage,
      seo: SeoOverrideSchema.parse({ imageSource: 'none', ogImage: ownImage }),
    });
    expect(none.openGraph.image).toBeNull();
    expect(none.twitter.image).toBeNull();
    expect(none.sources.image).toBe('none');
    expect(none.sourceLayers.image).toBe('override');
    const typeNone = site({
      social: { defaultImage: globalImage },
      pageSEO: { article: { imageSource: 'none' } },
    });
    expect(resolveSeo({ ...base, site: typeNone }).sourceLayers.image).toBe(
      'pageType',
    );
    expect(
      resolveSeo({ ...base, site: typeNone, featuredImage: ownImage }).openGraph
        .image,
    ).toBeNull();
    expect(
      resolveSeo({
        ...base,
        site: typeNone,
        seo: SeoOverrideSchema.parse({
          imageSource: 'custom',
          ogImage: ownImage,
        }),
      }).openGraph.image,
    ).toBe(`https://example.invalid${ownImage}`);
  });
  it('applies type settings to every public page type and keeps 404 and preview noindex', () => {
    const pageSEO = Object.fromEntries(
      SEO_PAGE_TYPES.map((type) => [
        type,
        {
          titleTemplate: `${type}: {title}`,
          descriptionSource: 'inherit',
          index: true,
          imageSource: 'inherit',
        },
      ]),
    );
    const settings = site({ pageSEO });
    for (const pageType of SEO_PAGE_TYPES) {
      const result = resolveSeo({
        site: settings,
        pageType,
        title: 'Label',
        path: pageType === 'notFound' ? null : '/page/',
      });
      expect(result.title).toBe(`${pageType}: Label`);
      expect(result.index).toBe(pageType !== 'notFound');
    }
    const model = buildSiteModel(input(settings));
    expect(model.home.seo.title).toBe('home: 首頁');
    expect(model.articlePages[0]?.seo.title).toContain('article: Article');
    expect(
      model.listPages.find((page) => page.kind === 'category')?.seo.title,
    ).toBe('category: Notes');
    expect(
      model.listPages.find((page) => page.kind === 'articles')?.seo.title,
    ).toBe('articles: 文章總覽');
    expect(notFoundSeo(settings).title).toBe('notFound: 找不到頁面');
    expect(notFoundSeo(settings).index).toBe(false);
    const preview = previewArticle({
      ...input(settings),
      article: article('alpha', { seo: { index: true } }),
    });
    expect(preview.seo.index).toBe(false);
    expect(preview.seo.sources.index).toBe('forced');
  });
  it('rejects unsupported automatic sources and incomplete custom values', () => {
    expect(
      SiteConfigSchema.safeParse({
        ...site(),
        pageSEO: { articles: { descriptionSource: 'content' } },
      }).success,
    ).toBe(false);
    expect(
      SiteConfigSchema.safeParse({
        ...site(),
        pageSEO: { category: { imageSource: 'featured' } },
      }).success,
    ).toBe(false);
    expect(
      SiteConfigSchema.safeParse({
        ...site(),
        pageSEO: { article: { descriptionSource: 'custom' } },
      }).success,
    ).toBe(false);
    expect(SeoOverrideSchema.safeParse({ imageSource: 'custom' }).success).toBe(
      false,
    );
  });
  it('uses the configured site description as the homepage automatic source', () => {
    const settings = site({
      pageSEO: { home: { descriptionSource: 'content' } },
    });
    expect(
      resolveSeo({ site: settings, pageType: 'home', title: '首頁', path: '/' })
        .description,
    ).toBe(settings.siteDescription);
    expect(
      resolveSeo({
        site: settings,
        pageType: 'home',
        title: '首頁',
        path: '/',
        contentDescription: '',
      }).description,
    ).toBe(settings.siteDescription);
  });
  it('includes page-type sharing images in the public media closure', () => {
    const model = buildSiteModel(
      input(
        site({
          pageSEO: { articles: { imageSource: 'custom', ogImage: typeImage } },
        }),
      ),
    );
    expect(model.mediaRefs).toContain(typeImage);
    expect(model.mediaPending).toBe(true);
  });
  it('does not publish inactive sharing-image values after choosing inherit or no image', () => {
    const settings = site({
      pageSEO: { article: { imageSource: 'inherit', ogImage: typeImage } },
    });
    const selected = article('alpha', {
      seo: { imageSource: 'none', ogImage: ownImage },
    });
    const model = buildSiteModel(input(settings, [selected]));
    expect(model.articlePages[0]?.seo.openGraph.image).toBeNull();
    expect(model.mediaRefs).toEqual([]);
    expect(model.mediaPending).toBe(false);
  });
});

describe('article excerpts and configured related reading', () => {
  it('uses effective page-type and global descriptions in Studio filtering when the excerpt and override are empty', () => {
    const selected = article('alpha', {
      excerpt: '',
      seo: { description: null },
    });
    const inherited = site({
      pageSEO: { article: { descriptionSource: 'inherit' } },
    });
    const type = site({
      pageSEO: {
        article: {
          descriptionSource: 'custom',
          description: 'type-description-sentinel',
        },
      },
    });
    const matches = (settings: SiteConfig, q: string) =>
      filterArticles([selected], ArticleListQuerySchema.parse({ q }), {
        site: settings,
      }).items.map((item) => item.articleId);
    expect(matches(inherited, 'GLOBAL SEO')).toEqual(['alpha']);
    expect(matches(type, 'TYPE-DESCRIPTION-SENTINEL')).toEqual(['alpha']);
    expect(matches(type, 'GLOBAL SEO')).toEqual([]);
  });
  it('keeps the excerpt ahead of explicit and inherited SEO text when Studio supplies site settings', () => {
    const settings = site({
      pageSEO: {
        article: {
          descriptionSource: 'custom',
          description: 'type-description-sentinel',
        },
      },
    });
    const selected = article('alpha', {
      excerpt: 'excerpt-sentinel',
      seo: { description: 'explicit-meta-sentinel' },
    });
    const matches = (q: string) =>
      filterArticles([selected], ArticleListQuerySchema.parse({ q }), {
        site: settings,
      }).items.map((item) => item.articleId);
    expect(matches('EXCERPT-SENTINEL')).toEqual(['alpha']);
    expect(matches('explicit-meta-sentinel')).toEqual([]);
    expect(matches('type-description-sentinel')).toEqual([]);
    expect(matches('Global SEO')).toEqual([]);
  });
  it('uses excerpt-first descriptions in Studio article filtering as well', () => {
    const articles = [
      article('alpha', {
        excerpt: 'excerpt-only-sentinel',
        seo: { description: 'meta-only-sentinel' },
      }),
      article('beta', { seo: { description: 'legacy-beta-sentinel' } }),
    ];
    const matches = (q: string) =>
      filterArticles(articles, ArticleListQuerySchema.parse({ q })).items.map(
        (item) => item.articleId,
      );
    expect(matches('EXCERPT-ONLY-SENTINEL')).toEqual(['alpha']);
    expect(matches('meta-only-sentinel')).toEqual([]);
    expect(matches('legacy-beta-sentinel')).toEqual(['beta']);
  });
  it('uses excerpts for non-meta output while preserving authored SEO descriptions', () => {
    const selected = article('alpha', {
      excerpt: 'Display excerpt',
      seo: { description: 'Search description' },
    });
    const model = buildSiteModel(
      input(site({ home: { featuredArticleIds: ['alpha'] } }), [selected]),
    );
    const page = model.articlePages[0];
    expect(page?.description).toBe('Display excerpt');
    expect(page?.seo.description).toBe('Search description');
    expect(page?.seo.openGraph.description).toBe('Search description');
    expect(
      page?.seo.jsonLd.find((item) => item['@type'] === 'BlogPosting')?.[
        'description'
      ],
    ).toBe('Display excerpt');
    expect(model.home.featured[0]?.description).toBe('Display excerpt');
    expect(model.searchIndex.articles[0]?.description).toBe('Display excerpt');
    expect(resolveArticleDescription(selected.meta, model.site)).toBe(
      'Display excerpt',
    );
  });
  it('retains related article order and uses each selected article display summary', () => {
    const selected = article('alpha', {
      relatedReading: { title: '繼續閱讀', articleIds: ['charlie', 'beta'] },
    });
    const model = buildSiteModel(
      input(site(), [
        selected,
        article('beta'),
        article('charlie', { excerpt: 'Charlie excerpt' }),
      ]),
    );
    const related = model.articlePages.find(
      (page) => page.articleId === 'alpha',
    )?.relatedReading;
    expect(related?.title).toBe('繼續閱讀');
    expect(related?.articles.map((card) => card.articleId)).toEqual([
      'charlie',
      'beta',
    ]);
    expect(related?.articles.map((card) => card.description)).toEqual([
      'Charlie excerpt',
      'SEO beta',
    ]);
  });
  it.each(['alpha', 'missing', 'draft'])(
    'rejects invalid related reading target %s',
    (target) => {
      const selected = article('alpha', {
        relatedReading: { title: '系列文章', articleIds: [target] },
      });
      const unpublished: Article = {
        articleId: 'draft',
        meta: ArticleMetaSchema.parse({ status: 'draft' }),
        contentHtml: '',
      };
      expect(() =>
        buildSiteModel(input(site(), [selected, unpublished])),
      ).toThrow(ContentValidationError);
    },
  );
  it('rejects duplicate related IDs and overlong excerpts at the schema boundary', () => {
    expect(
      ArticleMetaSchema.safeParse({
        status: 'draft',
        relatedReading: { articleIds: ['alpha', 'alpha'] },
      }).success,
    ).toBe(false);
    expect(
      ArticleMetaSchema.safeParse({ status: 'draft', excerpt: 'x'.repeat(301) })
        .success,
    ).toBe(false);
  });
  it('resolves selected published cards in incomplete draft previews without losing diagnostics', () => {
    const data = input();
    const draft: Article = {
      articleId: 'draft',
      contentHtml: '<p>Draft</p>',
      meta: ArticleMetaSchema.parse({
        status: 'draft',
        excerpt: 'Draft summary',
        relatedReading: { title: 'Related', articleIds: ['beta'] },
      }),
    };
    const preview = previewArticle({ ...data, article: draft });
    expect(preview.description).toBe('Draft summary');
    expect(
      preview.relatedReading?.articles.map((card) => card.articleId),
    ).toEqual(['beta']);
    expect(preview.publishable).toBe(false);
    expect(preview.diagnostics.length).toBeGreaterThan(0);
  });
});
