import { describe, expect, it, vi } from 'vitest';
import {
  ArticleMetaSchema,
  ArticleOptionSchema,
  ArticleOptionsQuerySchema,
  ArticleOptionsSchema,
  CategorySchema,
  SiteConfigSchema,
  TagSchema,
} from '@foliohaven/core';
import type { Article } from '@foliohaven/core';
import { ContentSourceError } from '@foliohaven/core/node';
import type { ContentSources } from '@foliohaven/core/node';
import { ContentService } from '../../server/src/content/service.js';
import { FileRepository } from '../../server/src/files/repository.js';
import type { ReadSession } from '../../server/src/files/types.js';

describe('article option contracts', () => {
  it('uses the article-list defaults and accepts bounded selected identifiers', () => {
    expect(ArticleOptionsQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      q: '',
      sort: 'published-desc',
      selected: [],
    });
    expect(
      ArticleOptionsQuerySchema.parse({
        status: 'published',
        category: 'notes/edge',
        tag: 'cdn',
        q: 'Cloudflare cache',
        page: '2',
        pageSize: '7',
        sort: 'updated-desc',
        selected: ',one,,draft,',
      }),
    ).toMatchObject({
      selected: ['one', 'draft'],
      page: 2,
      pageSize: 7,
      q: 'Cloudflare cache',
      status: 'published',
    });
    const twenty = Array.from({ length: 20 }, (_, i) => `article-${i}`);
    expect(
      ArticleOptionsQuerySchema.parse({ selected: twenty.join(',') }).selected,
    ).toEqual(twenty);
  });

  it.each([
    { selected: '../private' },
    { selected: ' one' },
    { selected: ['one'] },
    { selected: 'a'.repeat(1621) },
    {
      selected: Array.from({ length: 21 }, (_, i) => `article-${i}`).join(','),
    },
    { page: '0' },
    { pageSize: '101' },
    { q: 'a'.repeat(201) },
    { arbitrary: 'value' },
  ])('rejects malformed or oversized option queries: %j', (value) => {
    expect(ArticleOptionsQuerySchema.safeParse(value).success).toBe(false);
  });

  it('supports untitled drafts but rejects response bodies and extra metadata', () => {
    const draft = { id: 'draft', title: '', status: 'draft' };
    expect(ArticleOptionSchema.parse(draft)).toEqual(draft);
    expect(
      ArticleOptionSchema.safeParse({ ...draft, contentHtml: '<p>body</p>' })
        .success,
    ).toBe(false);
    expect(ArticleOptionSchema.safeParse({ ...draft, meta: {} }).success).toBe(
      false,
    );
    expect(
      ArticleOptionsSchema.parse({
        items: [],
        selected: [draft],
        total: 0,
        page: 1,
        pageSize: 20,
      }),
    ).toMatchObject({ selected: [draft], total: 0 });
    expect(
      ArticleOptionsSchema.safeParse({
        items: [],
        selected: [],
        total: -1,
        page: 1,
        pageSize: 20,
      }).success,
    ).toBe(false);
  });
});

function fixture() {
  const body = vi.fn((): string => {
    throw new Error('Option projection must not inspect or analyze HTML.');
  });
  const published = (
    articleId: string,
    title: string,
    publishedAt: string,
    options: { category?: string; tags?: string[]; excerpt?: string } = {},
  ): Article => ({
    articleId,
    meta: ArticleMetaSchema.parse({
      status: 'published',
      title,
      slug: articleId,
      category: options.category ?? 'notes',
      tags: options.tags ?? [],
      excerpt: options.excerpt ?? '',
      publishedAt,
      updatedAt: publishedAt,
    }),
    get contentHtml() {
      return body();
    },
  });
  const sources: ContentSources = {
    site: SiteConfigSchema.parse({
      siteName: 'Options fixture',
      siteDescription: 'Isolated read-only article option tests.',
      siteUrl: 'https://example.invalid/',
      author: { name: 'Fixture author', url: null },
    }),
    categories: [
      CategorySchema.parse({
        path: 'notes',
        name: '筆記',
        description: '測試筆記分類',
      }),
      CategorySchema.parse({
        path: 'notes/edge',
        name: '邊緣網路',
        description: '測試子分類',
      }),
    ],
    tags: [
      TagSchema.parse({
        slug: 'cdn',
        name: 'Cloudflare CDN',
        description: '測試快取主題',
      }),
    ],
    articles: [
      published('alpha', 'Cloudflare cache', '2026-02-01T00:00:00Z', {
        category: 'notes/edge',
        tags: ['cdn'],
        excerpt: '資源快取清單',
      }),
      published('bravo', 'Rust request', '2026-02-02T00:00:00Z'),
      published('charlie', 'Second cache', '2026-01-01T00:00:00Z', {
        tags: ['cdn'],
      }),
      {
        articleId: 'draft',
        meta: ArticleMetaSchema.parse({ status: 'draft' }),
        get contentHtml() {
          return body();
        },
      },
    ],
    pages: {},
  };
  const repository = new FileRepository({
    repositoryRoot: '/tmp/unused-article-options-fixture',
  });
  const loadContent = vi.fn(async () => sources);
  const read = vi.fn(async () => null);
  const session: ReadSession = {
    generation: 0,
    read,
    etag: async () => `"${'a'.repeat(64)}"`,
    listArticleIds: async () => [],
    loadContent,
  };
  const consistent = vi
    .spyOn(repository, 'withConsistentRead')
    .mockImplementation(async (fn) => fn(session));
  const manifest = vi.fn(async (): Promise<never> => {
    throw new Error('Article options must not scan media.');
  });
  const service = new ContentService({
    repository,
    fixedPages: [],
    scanInputs: async () => {
      throw new Error('No build input scan is needed for article options.');
    },
    getMediaManifest: manifest,
  });
  return { service, sources, loadContent, read, consistent, manifest, body };
}

describe('read-only article option projection', () => {
  it('returns one sorted page and selected records from the same complete source snapshot without HTML or media work', async () => {
    const { service, loadContent, read, consistent, manifest, body } =
      fixture();
    const result = await service.listArticleOptions({
      status: 'published',
      page: '2',
      pageSize: '1',
      selected: 'draft,missing,charlie',
    });
    expect(result).toEqual({
      items: [{ id: 'alpha', title: 'Cloudflare cache', status: 'published' }],
      selected: [
        { id: 'draft', title: '', status: 'draft' },
        { id: 'charlie', title: 'Second cache', status: 'published' },
      ],
      total: 3,
      page: 2,
      pageSize: 1,
    });
    expect(consistent).toHaveBeenCalledOnce();
    expect(loadContent).toHaveBeenCalledExactlyOnceWith({ mode: 'preview' });
    expect(read).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    expect(manifest).not.toHaveBeenCalled();
  });

  it('keeps existing keyword, taxonomy, status and sort behavior without filtering selected records', async () => {
    const { service } = fixture();
    const result = await service.listArticleOptions({
      status: 'published',
      category: 'notes',
      tag: 'cdn',
      q: 'CLOUDFLARE 快取',
      sort: 'title-asc',
      selected: 'bravo,draft',
    });
    expect(result.items.map((article) => article.id)).toEqual(['alpha']);
    expect(result.selected.map((article) => article.id)).toEqual([
      'bravo',
      'draft',
    ]);
    expect(result.total).toBe(1);
  });

  it('returns empty out-of-range pages and resolves the selected subset independently', async () => {
    const { service } = fixture();
    const result = await service.listArticleOptions({
      status: 'published',
      page: '10',
      pageSize: '20',
      selected: 'alpha',
    });
    expect(result.items).toEqual([]);
    expect(result.selected.map((article) => article.id)).toEqual(['alpha']);
    expect(result).toMatchObject({ total: 3, page: 10, pageSize: 20 });
  });

  it('rejects invalid queries before acquiring a repository session', async () => {
    const { service, consistent, loadContent } = fixture();
    await expect(
      service.listArticleOptions({ selected: '../private' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(consistent).not.toHaveBeenCalled();
    expect(loadContent).not.toHaveBeenCalled();
  });

  it('preserves source validation failures instead of returning a partial list', async () => {
    const { service, loadContent, manifest } = fixture();
    loadContent.mockRejectedValueOnce(
      new ContentSourceError(
        'SOURCE_INCOMPLETE',
        'Missing paired article source.',
        'content/articles/alpha/meta.json',
      ),
    );
    await expect(service.listArticleOptions()).rejects.toMatchObject({
      code: 'SOURCE_INVALID',
      status: 422,
    });
    expect(manifest).not.toHaveBeenCalled();
  });
});
