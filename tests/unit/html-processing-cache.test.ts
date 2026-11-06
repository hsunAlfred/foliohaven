import { describe, expect, it } from 'vitest';
import {
  ArticleMetaSchema,
  CategoriesSchema,
  FixedPageSchema,
  SiteConfigSchema,
  TagsSchema,
} from '../../packages/core/src/index.js';
import type { MediaManifest } from '../../packages/core/src/models/index.js';
import {
  HtmlProcessingCache,
  analyzeHtml,
  enhanceHtmlMedia,
} from '../../packages/core/src/html/index.js';
import {
  buildSiteModel,
  ContentValidationError,
  previewArticle,
} from '../../packages/core/src/content/index.js';
import type { SiteModelInput } from '../../packages/core/src/content/index.js';

function sources(): SiteModelInput {
  return {
    site: SiteConfigSchema.parse({
      siteName: 'Cache fixture',
      siteDescription: 'Cache equivalence fixture',
      siteUrl: 'https://example.invalid/',
      author: { name: 'Fixture author', url: null },
    }),
    categories: CategoriesSchema.parse([
      { path: 'notes', name: 'Notes', description: 'Fixture notes' },
    ]),
    tags: TagsSchema.parse([
      { slug: 'test', name: 'Test', description: 'Fixture tag' },
    ]),
    fixedPages: ['/', '/articles/'].map((path, index) =>
      FixedPageSchema.parse({
        id: index === 0 ? 'home' : 'articles',
        path,
        entry:
          index === 0
            ? 'src/pages/index.astro'
            : 'src/pages/articles/index.astro',
      }),
    ),
    articles: [
      {
        articleId: 'one',
        contentHtml: '<h2 id="one">One</h2>',
        meta: ArticleMetaSchema.parse({
          status: 'published',
          title: 'One',
          slug: 'one',
          category: 'notes',
          tags: ['test'],
          publishedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          seo: { description: 'Cache fixture article' },
        }),
      },
    ],
    mediaManifest: { schemaVersion: 1, assets: [] },
    now: '2026-11-03T00:00:00Z',
  };
}

function outcome(input: SiteModelInput) {
  try {
    return buildSiteModel(input);
  } catch (error) {
    if (error instanceof ContentValidationError) return error.diagnostics;
    throw error;
  }
}

describe('opt-in immutable HTML processing cache', () => {
  it('keys exact HTML, article ID and mode, and never shares mutable outputs', () => {
    const cache = new HtmlProcessingCache();
    const html = '<h2>One</h2>';
    const options = { articleId: 'one', mode: 'published' as const };
    const first = cache.analyze(html, options);
    expect(first).toEqual(analyzeHtml(html, options));
    expect(cache.analyze(html, options)).toBe(first);
    expect(cache.analyze('<h2>Two</h2>', options)).not.toBe(first);
    expect(cache.analyze(html, { ...options, articleId: 'two' })).toEqual(
      analyzeHtml(html, { ...options, articleId: 'two' }),
    );
    const draft = cache.analyze(html, { ...options, mode: 'draft' });
    expect(draft).toEqual(analyzeHtml(html, { ...options, mode: 'draft' }));
    expect(draft).not.toBe(first);
    expect(Reflect.set(first.diagnostics, '0', { code: 'POISON' })).toBe(false);
    expect(Object.isFrozen(first.diagnostics[0])).toBe(true);
    expect(cache.analyze(html, options)).toEqual(analyzeHtml(html, options));
  });

  it('invalidates all media dependencies, including in-place manifest edits', () => {
    const id = 'c854748f-5d6f-42b7-aebc-cbdf42cb711a';
    const path = `/media/${id}/image.webp`;
    const html = `<img src="${path}" alt="Image">`;
    const manifest: MediaManifest = {
      schemaVersion: 1,
      assets: [
        {
          id,
          kind: 'image',
          sourceSha256: 'a'.repeat(64),
          presetVersion: 'fixture-v1',
          tools: { sharp: 'fixture' },
          outputs: [
            {
              publicPath: path,
              mimeType: 'image/webp',
              width: 100,
              height: 50,
              byteSize: 10,
              sha256: 'b'.repeat(64),
            },
          ],
        },
      ],
    };
    const cache = new HtmlProcessingCache();
    const first = cache.enhance(html, manifest);
    expect(cache.enhance(html, manifest)).toBe(first);
    expect(first).toEqual(enhanceHtmlMedia(html, manifest));
    const output = manifest.assets[0]?.outputs[0];
    if (output === undefined) throw new Error('Missing fixture output');
    output.width = 200;
    expect(cache.enhance(html, manifest)).toEqual(
      enhanceHtmlMedia(html, manifest),
    );
    expect(cache.enhance(html, manifest).contentHtml).toContain('width="200"');
    manifest.assets.splice(0);
    expect(cache.enhance(html, manifest)).toEqual(
      enhanceHtmlMedia(html, manifest),
    );
    expect(Object.isFrozen(first.diagnostics)).toBe(true);
  });

  it('bounds retained entries and oversized results', () => {
    const cache = new HtmlProcessingCache(1);
    const first = cache.analyze('<p>One</p>');
    cache.analyze('<p>Two</p>');
    expect(cache.analyze('<p>One</p>')).not.toBe(first);
    const tiny = new HtmlProcessingCache(256, 1);
    expect(tiny.analyze('<p>One</p>')).not.toBe(tiny.analyze('<p>One</p>'));
  });

  it('preserves full site/preview validation while changed HTML, taxonomy and navigation take effect', async () => {
    const input = sources();
    const cache = new HtmlProcessingCache();
    expect(outcome({ ...input, htmlCache: cache })).toEqual(outcome(input));
    const article = input.articles[0];
    if (article === undefined) throw new Error('Missing fixture article');
    expect(previewArticle({ ...input, article, htmlCache: cache })).toEqual(
      previewArticle({ ...input, article }),
    );
    const changed = { ...article, contentHtml: '<h2 id="two">Two</h2>' };
    const [first, second] = await Promise.all([
      Promise.resolve().then(() =>
        previewArticle({ ...input, article, htmlCache: cache }),
      ),
      Promise.resolve().then(() =>
        previewArticle({ ...input, article: changed, htmlCache: cache }),
      ),
    ]);
    expect(first.toc[0]?.id).toBe('one');
    expect(second.toc[0]?.id).toBe('two');
    for (const next of [
      { ...input, tags: [] },
      {
        ...input,
        articles: [
          { ...article, contentHtml: '<a href="/missing/">Missing</a>' },
        ],
      },
      {
        ...input,
        site: {
          ...input.site,
          navigation: [{ label: 'Missing', href: '/missing/' }],
        },
      },
    ])
      expect(outcome({ ...next, htmlCache: cache })).toEqual(outcome(next));
  });
});
