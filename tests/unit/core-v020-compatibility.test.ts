import { describe, expect, it } from 'vitest';
import {
  ArticleMetaSchema,
  ArticleWriteSchema,
  CategoriesSchema,
  FixedPageSchema,
  MediaAssetSchema,
  SiteConfigSchema,
  TagsSchema,
  buildSiteModel,
} from '@foliohaven/core';

const mediaId = '1fca5dfb-8aec-4d29-bd9a-ab64d403a104';
const imagePath = '/media/' + mediaId + '/image.webp';

/** A complete pre-upgrade source shape; no v0.3 fields are synthesized here. */
function legacySources() {
  return {
    site: {
      siteName: 'Legacy example',
      siteDescription: 'An existing author website.',
      siteUrl: 'https://example.invalid/',
      language: 'zh-Hant',
      timeZone: 'Asia/Taipei',
      author: { name: 'Existing author', url: null },
      navigation: [
        { label: '首頁', href: '/' },
        { label: '文章', href: '/articles/' },
      ],
      defaultSEO: {
        titleTemplate: '{title} | {siteName}',
        description: 'Existing global description.',
        index: true,
      },
      pagination: { category: 2, tag: 2, articles: 2 },
      home: { featuredArticleIds: ['legacy-article'], latestCount: 5 },
      rss: {
        title: 'Existing feed',
        description: 'Existing feed description.',
        maxItems: 100,
      },
      social: { defaultImage: imagePath, twitterSite: null },
      googleSiteVerification: null,
    },
    article: {
      articleId: 'legacy-article',
      contentHtml: '<h2 id="intro">既有內容</h2><p>Keep this body.</p>',
      meta: {
        status: 'published',
        title: '既有文章',
        slug: 'legacy-post',
        category: 'notes',
        tags: ['example'],
        publishedAt: '2026-10-20T09:00:00+08:00',
        updatedAt: '2026-10-22T01:00:00Z',
        featuredImage: imagePath,
        featuredImageAlt: 'Existing image description',
        seo: {
          title: 'Existing complete SEO title',
          description: 'Existing authored Meta Description.',
          index: false,
          ogImage: imagePath,
        },
      },
    },
  };
}

function legacyAsset() {
  return {
    id: mediaId,
    kind: 'image',
    sourceSha256: 'a'.repeat(64),
    presetVersion: 'article-image-v1',
    tools: { sharp: '0.35.5', libvips: '8.18.0' },
    outputs: [
      {
        publicPath: imagePath,
        mimeType: 'image/webp',
        width: 1280,
        height: 720,
        byteSize: 1000,
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

describe('v0.2 source compatibility', () => {
  it('reads old sources without mutating them and keeps explicit SEO values', () => {
    const source = legacySources();
    const before = JSON.stringify(source);
    const site = SiteConfigSchema.parse(source.site);
    const meta = ArticleMetaSchema.parse(source.article.meta);

    expect(JSON.stringify(source)).toBe(before);
    expect(meta).toMatchObject(source.article.meta);
    expect(meta.excerpt).toBe('');
    expect(meta.relatedReading).toEqual({ title: '延伸閱讀', articleIds: [] });
    expect(meta.seo).toEqual(source.article.meta.seo);
    expect(site.social).toEqual(source.site.social);
    expect(site.home.featuredArticleIds).toEqual(['legacy-article']);
    expect(site.home.featuredCaption).toBe('精選文章');
    expect(site.icons.enabled).toBe(false);
    expect(site.favicon).toBeNull();
  });

  it('roundtrips upgraded JSON with the original dates, paths, body and overrides', () => {
    const source = legacySources();
    const savedArticle = JSON.stringify(
      ArticleWriteSchema.parse({
        contentHtml: source.article.contentHtml,
        meta: source.article.meta,
      }),
    );
    const savedSite = JSON.stringify(SiteConfigSchema.parse(source.site));
    const reopenedArticle = ArticleWriteSchema.parse(JSON.parse(savedArticle));
    const reopenedSite = SiteConfigSchema.parse(JSON.parse(savedSite));

    expect(reopenedArticle.contentHtml).toBe(source.article.contentHtml);
    expect(reopenedArticle.meta).toMatchObject(source.article.meta);
    expect(reopenedArticle.meta.seo).toEqual(source.article.meta.seo);
    expect(reopenedArticle.meta.publishedAt).toBe('2026-10-20T09:00:00+08:00');
    expect(reopenedSite.siteUrl).toBe(source.site.siteUrl);
    expect(reopenedSite.navigation).toEqual(source.site.navigation);
    expect(reopenedSite.social.defaultImage).toBe(imagePath);
    expect(JSON.stringify(reopenedArticle)).toBe(savedArticle);
    expect(JSON.stringify(reopenedSite)).toBe(savedSite);
  });

  it('adds explicit new fields on save, so a downgrade needs the old data backup', () => {
    const source = legacySources();
    const savedMeta = JSON.parse(
      JSON.stringify(ArticleMetaSchema.parse(source.article.meta)),
    );
    const savedSite = JSON.parse(
      JSON.stringify(SiteConfigSchema.parse(source.site)),
    );

    expect(
      Object.keys(savedMeta)
        .filter((key) => !Object.hasOwn(source.article.meta, key))
        .sort(),
    ).toEqual(['excerpt', 'relatedReading']);
    expect(
      Object.keys(savedSite)
        .filter((key) => !Object.hasOwn(source.site, key))
        .sort(),
    ).toEqual(['favicon', 'icons', 'pageSEO']);
    expect(savedSite.home.featuredCaption).toBe('精選文章');
  });

  it('keeps legacy managed image output and complete explicit SEO in a public model', () => {
    const source = legacySources();
    const previousAsset = legacyAsset();
    expect(MediaAssetSchema.parse(previousAsset)).toEqual(previousAsset);
    const model = buildSiteModel({
      site: SiteConfigSchema.parse(source.site),
      articles: [
        {
          ...source.article,
          meta: ArticleMetaSchema.parse(source.article.meta),
        },
      ],
      categories: CategoriesSchema.parse([
        { path: 'notes', name: '筆記', description: 'Existing category.' },
      ]),
      tags: TagsSchema.parse([
        { slug: 'example', name: '範例', description: 'Existing tag.' },
      ]),
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
      mediaManifest: {
        schemaVersion: 1,
        assets: [MediaAssetSchema.parse(previousAsset)],
      },
      now: '2026-11-01T00:00:00Z',
    });
    const page = model.articlePages[0];
    expect(page?.url).toBe('/notes/legacy-post/');
    expect(page?.seo.title).toBe(source.article.meta.seo.title);
    expect(page?.seo.description).toBe(source.article.meta.seo.description);
    expect(page?.seo.index).toBe(false);
    expect(page?.seo.openGraph.image).toBe(
      'https://example.invalid' + imagePath,
    );
    expect(page?.description).toBe(source.article.meta.seo.description);
    expect(model.mediaRefs).toEqual([imagePath]);
    expect(model.home.featured[0]?.url).toBe('/notes/legacy-post/');
    expect(model.home.site.iconSet?.manifest).toBeNull();
  });

  it('uses neutral defaults while preserving all author-selected icon colors and captions', () => {
    const source = legacySources();
    const defaults = SiteConfigSchema.parse(source.site);
    expect(defaults.icons).toMatchObject({
      maskColor: '#404040',
      themeLight: '#ffffff',
      themeDark: '#262626',
      backgroundColor: '#ffffff',
    });
    const custom = SiteConfigSchema.parse({
      ...source.site,
      icons: {
        maskColor: '#123456',
        themeLight: '#abcdef',
        themeDark: '#654321',
        backgroundColor: '#fedcba',
      },
      home: { ...source.site.home, featuredCaption: '作者自訂精選' },
    });
    expect(custom.icons).toMatchObject({
      maskColor: '#123456',
      themeLight: '#abcdef',
      themeDark: '#654321',
      backgroundColor: '#fedcba',
    });
    expect(custom.home.featuredCaption).toBe('作者自訂精選');
  });
});
