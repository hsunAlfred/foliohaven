import { describe, expect, it } from 'vitest';
import type { SearchDocument } from '@foliohaven/core';
import {
  matchedSearchTags,
  parseSearchQuery,
  searchDocuments,
  searchQueryUrl,
  searchTagOptions,
} from '../../packages/core/src/search/index.js';
import { searchPageViewModel } from '../../packages/core/src/search/page.js';
import { uiModels } from '../fixtures/ui-models.js';

function fixtures() {
  const { model } = uiModels();
  const initial = model.listPages.find((page) => page.kind === 'articles');
  const sample = model.searchIndex.articles[0];
  if (!initial || !sample) throw new Error('Missing search fixture');
  const values = [
    {
      id: 'child',
      category: 'notes/child',
      tags: ['featured'],
      title: 'Deploy notes',
    },
    {
      id: 'parent',
      category: 'notes',
      tags: ['featured', 'backend'],
      title: 'Service notes',
    },
    {
      id: 'similarly-named',
      category: 'notes-other',
      tags: ['featured'],
      title: 'Other notes',
    },
    { id: 'tool', category: 'tools', tags: ['backend'], title: 'Deploy tool' },
    { id: 'untagged', category: 'tools', tags: [], title: 'Untagged tool' },
  ];
  const documents: readonly SearchDocument[] = values.map((value, index) => ({
    ...sample,
    id: value.id,
    slug: value.id,
    title: value.title,
    url: `/${value.category}/${value.id}/`,
    category: { path: value.category, name: value.category },
    tags: value.tags.map((slug) => ({
      slug,
      name: slug === 'backend' ? 'Backend' : 'Featured',
    })),
    description: 'Practical implementation.',
    publishedAt: `2026-10-${20 - index}T00:00:00Z`,
  }));
  return { initial, documents };
}

function rankedFixtures() {
  const { initial, documents } = fixtures();
  const sample = documents[0];
  if (!sample) throw new Error('Missing ranking fixture');
  const values = [
    {
      id: 'older-multi',
      title: 'Rust guide',
      description: 'Docker deployment',
      category: 'notes/child',
      tags: ['featured'],
      publishedAt: '2026-10-01T00:00:00Z',
    },
    {
      id: 'newer-single',
      title: 'Rust Rust Rust',
      description: 'Rust implementation',
      category: 'notes',
      tags: ['backend'],
      publishedAt: '2026-10-20T00:00:00Z',
    },
    {
      id: 'tie-z',
      title: 'Docker service',
      description: 'Deployment',
      category: 'tools',
      tags: ['backend'],
      publishedAt: '2026-10-19T00:00:00Z',
    },
    {
      id: 'tie-a',
      title: 'Docker service',
      description: 'Deployment',
      category: 'tools',
      tags: ['featured'],
      publishedAt: '2026-10-19T00:00:00Z',
    },
    {
      id: 'unmatched',
      title: 'Python guide',
      description: 'Database service',
      category: 'notes',
      tags: ['featured'],
      publishedAt: '2026-10-25T00:00:00Z',
    },
  ];
  return {
    initial,
    documents: values.map((value): SearchDocument => ({
      ...sample,
      ...value,
      slug: value.id,
      category: { path: value.category, name: value.category },
      tags: value.tags.map((slug) => ({ slug, name: slug })),
    })),
  };
}

const ids = (documents: readonly SearchDocument[]) =>
  documents.map((document) => document.id);

describe('public search card tag projection', () => {
  it('hides tags without keywords or selected tags, including category-only queries', () => {
    const tags = [{ slug: 'notes', name: 'Notes' }];
    for (const query of ['', '?q=+++', '?category=notes', '?page=2'])
      expect(matchedSearchTags(tags, query)).toEqual([]);
  });

  it('OR-matches distinct normalized keyword tokens against tag names and slugs', () => {
    const tags = [
      { slug: 'ci-pipeline', name: '自動部署' },
      { slug: 'security', name: '安全\t實作' },
      { slug: 'workflow', name: 'ＷＯＲＫＦＬＯＷ' },
      { slug: 'coffee', name: 'Café' },
    ];
    const query = new URLSearchParams({
      q: '  ＣＩ\t 安全 \n workflow CI missing  ',
    }).toString();
    expect(matchedSearchTags(tags, query)).toEqual(tags.slice(0, 3));
    expect(matchedSearchTags(tags, '?q=cafe')).toEqual([]);
    expect(matchedSearchTags(tags, '?q=cafe%CC%81')).toEqual([tags[3]]);
  });

  it('unions selected tag slugs with keyword matches once in source order without changing metadata', () => {
    const tags = Object.freeze([
      Object.freeze({
        slug: 'workflow',
        name: 'Workflow',
        url: '/tag/workflow/',
      }),
      Object.freeze({
        slug: 'featured',
        name: 'Pinned',
        url: '/tag/featured/',
      }),
      Object.freeze({ slug: 'deploy', name: 'Deploy', url: '/tag/deploy/' }),
      Object.freeze({
        slug: 'feature',
        name: 'Unrelated',
        url: '/tag/feature/',
      }),
    ]);
    const before = JSON.stringify(tags);
    const query = parseSearchQuery(
      '?q=DEPLOY+workflow+deploy&tag=FEATURED&tag=featured',
    );
    const result = matchedSearchTags(tags, query);
    expect(result).toEqual(tags.slice(0, 3));
    expect(result.map((tag) => tag.url)).toEqual([
      '/tag/workflow/',
      '/tag/featured/',
      '/tag/deploy/',
    ]);
    expect(result.every((tag, index) => tag === tags[index])).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(matchedSearchTags(tags, '?tag=featured')).toEqual([tags[1]]);
    expect(JSON.stringify(tags)).toBe(before);
  });

  it('does not show unrelated tags when keywords match only other document fields', () => {
    const { documents } = fixtures();
    const matches = searchDocuments(documents, '?q=deploy').items;
    expect(ids(matches)).toEqual(['child', 'tool']);
    expect(
      matches.map((document) => matchedSearchTags(document.tags, '?q=deploy')),
    ).toEqual([[], []]);
  });

  it('returns no tags for invalid queries even when a tag is selected', () => {
    const tags = [{ slug: 'featured', name: 'Featured' }];
    for (const query of [
      `?q=${'x'.repeat(201)}&tag=featured`,
      '?tag=featured&page=0',
    ]) {
      expect(matchedSearchTags(tags, query)).toEqual([]);
      expect(matchedSearchTags(tags, parseSearchQuery(query))).toEqual([]);
    }
    expect(
      matchedSearchTags(tags, {
        ...parseSearchQuery('?tag=featured'),
        q: 'x'.repeat(201),
      }),
    ).toEqual([]);
  });
});

describe('public search category and tag selection', () => {
  it('normalizes, validates, deduplicates and round-trips repeated filters in a stable URL', () => {
    const query = parseSearchQuery(
      '?q=Deploy&category=TOOLS&category=%20notes%2Fchild%20&category=tools&category=../private&category=articles&tag=ＣＩ&tag=backend&tag=ci&tag=123&tag=bad%2Ftag&page=2',
    );
    expect(query).toEqual({
      q: 'deploy',
      categories: ['notes/child', 'tools'],
      tags: ['backend', 'ci'],
      page: 2,
      valid: true,
      error: null,
    });
    const url = searchQueryUrl(query.q, query.page ?? 1, query);
    expect(url).toBe(
      '/articles/?q=deploy&category=notes%2Fchild&category=tools&tag=backend&tag=ci&page=2',
    );
    expect(parseSearchQuery(url.slice(url.indexOf('?')))).toEqual(query);
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.categories)).toBe(true);
    expect(Object.isFrozen(query.tags)).toBe(true);
    expect(
      parseSearchQuery(`?tag=${'x'.repeat(81)}&category=${'x'.repeat(513)}`)
        .categories,
    ).toEqual([]);
    expect(parseSearchQuery(`?tag=${'x'.repeat(81)}`).tags).toEqual([]);
  });

  it('OR-matches within each filter, AND-matches both filters and keyword, and includes category descendants', () => {
    const { documents } = fixtures();
    const before = JSON.stringify(documents);
    expect(ids(searchDocuments(documents, '?category=notes').items)).toEqual([
      'child',
      'parent',
    ]);
    expect(
      ids(searchDocuments(documents, '?category=notes&category=tools').items),
    ).toEqual(['child', 'parent', 'tool', 'untagged']);
    expect(
      ids(searchDocuments(documents, '?tag=featured&tag=backend').items),
    ).toEqual(['child', 'parent', 'similarly-named', 'tool']);
    expect(
      ids(
        searchDocuments(
          documents,
          '?category=notes&category=tools&tag=featured&tag=backend',
        ).items,
      ),
    ).toEqual(['child', 'parent', 'tool']);
    expect(
      ids(
        searchDocuments(
          documents,
          '?q=deploy&category=notes&category=tools&tag=featured&tag=backend',
        ).items,
      ),
    ).toEqual(['child', 'tool']);
    expect(JSON.stringify(documents)).toBe(before);
  });

  it('matches any keyword across titles, descriptions, category and tag fields without searching article slugs', () => {
    const { documents } = fixtures();
    const sample = documents[0];
    if (!sample) throw new Error('Missing search document');
    const document: SearchDocument = {
      ...sample,
      slug: 'slug-only-sentinel',
      title: 'Guide to ＤＥＰＬＯＹ',
      description: 'Prepare OAuth credentials safely.',
      category: {
        path: 'metadata-category',
        name: 'Category-only-sentinel Café 系統',
      },
      tags: [{ slug: 'metadata-tag', name: 'Tag-only-sentinel' }],
    };
    const decoy: SearchDocument = {
      ...document,
      id: 'decoy',
      slug: 'decoy',
      title: 'Deploy',
      description: 'Unrelated setup.',
      category: { path: 'other', name: 'Other' },
      tags: [],
    };
    for (const keyword of [
      'metadata-category',
      'category-only-sentinel',
      'metadata-tag',
      'tag-only-sentinel',
      'deploy',
      'oauth credentials',
      'deploy oauth',
    ]) {
      expect(
        searchDocuments(
          [document],
          new URLSearchParams({ q: keyword }).toString(),
        ).items,
      ).toEqual([document]);
    }
    expect(searchDocuments([document], '?q=slug-only-sentinel').items).toEqual(
      [],
    );
    expect(searchDocuments([document], '?q=deploy+missing').items).toEqual([
      document,
    ]);
    expect(
      searchDocuments(
        [document, decoy],
        '?q=deploy+oauth+category-only-sentinel+metadata-tag',
      ).items,
    ).toEqual([document, decoy]);
    expect(
      searchDocuments([document], '?category=metadata-category').items,
    ).toEqual([document]);
    expect(searchDocuments([document], '?tag=metadata-tag').items).toEqual([
      document,
    ]);
    expect(
      searchDocuments(
        [document],
        '?q=oauth&category=metadata-category&tag=metadata-tag',
      ).items,
    ).toEqual([document]);
    expect(
      searchDocuments([document], '?q=oauth&category=other').items,
    ).toEqual([]);
    expect(searchDocuments([document], '?q=oauth&tag=other').items).toEqual([]);
  });

  it('OR-includes partial matches and ranks distinct matched groups before recency and deterministic date/id ties', () => {
    const { documents } = rankedFixtures();
    const before = JSON.stringify(documents);
    const result = searchDocuments([...documents].reverse(), '?q=rust+docker');
    expect(ids(result.items)).toEqual([
      'older-multi',
      'newer-single',
      'tie-a',
      'tie-z',
    ]);
    expect(result.total).toBe(4);
    expect(ids(searchDocuments(documents, '?q=rust+unknown').items)).toEqual([
      'newer-single',
      'older-multi',
    ]);
    expect(searchDocuments(documents, '?q=unknown+absent').items).toEqual([]);
    expect(JSON.stringify(documents)).toBe(before);
  });

  it('counts normalized repeated query terms and repeated document occurrences only once per group', () => {
    const { documents } = rankedFixtures();
    const rust = documents.find((document) => document.id === 'newer-single');
    const docker = documents.find((document) => document.id === 'tie-a');
    if (!rust || !docker) throw new Error('Missing repeat fixture');
    const values = [
      { ...rust, publishedAt: '2026-10-01T00:00:00Z' },
      { ...docker, publishedAt: '2026-10-20T00:00:00Z' },
    ];
    const expected = ['tie-a', 'newer-single'];
    expect(ids(searchDocuments(values, '?q=rust+docker').items)).toEqual(
      expected,
    );
    expect(ids(searchDocuments(values, '?q=rust+rust+docker').items)).toEqual(
      expected,
    );
    expect(
      ids(
        searchDocuments(
          values,
          new URLSearchParams({ q: 'ＲＵＳＴ Rust rust Docker' }).toString(),
        ).items,
      ),
    ).toEqual(expected);
  });

  it('applies selected facets before ranking and pagination while leaving empty-keyword chronological order unchanged', () => {
    const { initial, documents } = rankedFixtures();
    const sample = documents[0];
    if (!sample) throw new Error('Missing ranked document');
    const values = [
      ...documents,
      {
        ...sample,
        id: 'excluded-category',
        category: { path: 'other', name: 'Other' },
        publishedAt: '2026-10-26T00:00:00Z',
      },
      {
        ...sample,
        id: 'excluded-tag',
        tags: [],
        publishedAt: '2026-10-26T00:00:00Z',
      },
    ];
    const query =
      '?q=rust+docker&category=notes&category=tools&tag=featured&tag=backend';
    const canonical =
      '/articles/?q=rust+docker&category=notes&category=tools&tag=backend&tag=featured';
    const first = searchPageViewModel(initial, values, query);
    expect(first.model.articles.map((article) => article.articleId)).toEqual([
      'older-multi',
      'newer-single',
    ]);
    expect(first.model.pagination.totalItems).toBe(4);
    expect(first.model.pagination.nextUrl).toBe(`${canonical}&page=2`);
    const second = searchPageViewModel(initial, values, `${query}&page=2`);
    expect(second.model.articles.map((article) => article.articleId)).toEqual([
      'tie-a',
      'tie-z',
    ]);
    expect(second.model.pagination.previousUrl).toBe(canonical);
    expect(second.firstPageUrl).toBe(canonical);
    expect(ids(searchDocuments(documents, '').items)).toEqual([
      'unmatched',
      'newer-single',
      'tie-a',
      'tie-z',
      'older-multi',
    ]);
    expect(ids(searchDocuments(documents, '?q=+++').items)).toEqual(
      ids(searchDocuments(documents, '').items),
    );
  });

  it('normalizes full-width characters, case and whitespace across fields while retaining accents', () => {
    const { documents } = fixtures();
    const sample = documents[0];
    if (!sample) throw new Error('Missing search document');
    const document: SearchDocument = {
      ...sample,
      title: 'Guide to ＤＥＰＬＯＹ',
      description: 'Prepare OAuth credentials safely.',
      category: { path: 'notes', name: 'Café 系統' },
      tags: [{ slug: 'security', name: '安全實作' }],
    };
    for (const keyword of [
      '  ＤＥＰＬＯＹ\t oAuth \n CAFÉ  安全實作  ',
      'cafe\u0301',
    ]) {
      expect(
        searchDocuments(
          [document],
          new URLSearchParams({ q: keyword }).toString(),
        ).items,
      ).toEqual([document]);
    }
    expect(searchDocuments([document], '?q=cafe').items).toEqual([]);
  });

  it('keeps legal unknown selections as zero results instead of silently displaying all articles', () => {
    const { documents } = fixtures();
    for (const query of [
      '?category=unknown',
      '?tag=unknown',
      '?category=notes&tag=backend-unknown',
    ]) {
      const result = searchDocuments(documents, query);
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.validPage).toBe(true);
    }
    expect(parseSearchQuery('?category=unknown&tag=unknown')).toMatchObject({
      categories: ['unknown'],
      tags: ['unknown'],
    });
    expect(searchDocuments(documents, '').total).toBe(documents.length);
  });

  it('paginates the filtered set using the configured page size and preserves every selection in page and recovery URLs', () => {
    const { initial, documents } = fixtures();
    const query = '?category=notes&category=tools&tag=featured&tag=backend';
    const canonical =
      '/articles/?category=notes&category=tools&tag=backend&tag=featured';
    const first = searchPageViewModel(initial, documents, query);
    expect(first.model.articles.map((article) => article.articleId)).toEqual([
      'child',
      'parent',
    ]);
    expect(first.model.pagination.totalItems).toBe(3);
    expect(first.model.pagination.totalPages).toBe(2);
    expect(first.model.pagination.nextUrl).toBe(`${canonical}&page=2`);
    expect(first.model.seo).toBe(initial.seo);
    const second = searchPageViewModel(initial, documents, `${query}&page=2`);
    expect(second.model.articles.map((article) => article.articleId)).toEqual([
      'tool',
    ]);
    expect(second.model.pagination.previousUrl).toBe(canonical);
    expect(second.firstPageUrl).toBe(canonical);
    const invalid = searchPageViewModel(initial, documents, `${query}&page=0`);
    expect(invalid.validPage).toBe(false);
    expect(invalid.firstPageUrl).toBe(canonical);
    expect(invalid.model.pagination.links[0]?.url).toBe(canonical);
    const keyword = searchPageViewModel(
      initial,
      documents,
      '?q=deploy&category=notes&tag=featured&page=99',
    );
    expect(keyword.firstPageUrl).toBe(
      '/articles/?q=deploy&category=notes&tag=featured',
    );
    const small = searchPageViewModel(
      { ...initial, pagination: { ...initial.pagination, pageSize: 1 } },
      documents,
      query,
    );
    expect(small.model.articles).toHaveLength(1);
    expect(small.model.pagination.totalPages).toBe(3);
  });

  it('projects all published-document tag choices with unique per-article counts and immutable stable ordering', () => {
    const { documents } = fixtures();
    const first = documents[0];
    const firstTag = first?.tags[0];
    if (!first || !firstTag) throw new Error('Missing tagged document');
    const options = searchTagOptions([
      { ...first, tags: [...first.tags, firstTag] },
      ...documents.slice(1),
    ]);
    expect(options).toEqual([
      { slug: 'backend', name: 'Backend', articleCount: 2 },
      { slug: 'featured', name: 'Featured', articleCount: 3 },
    ]);
    expect(searchTagOptions([...documents].reverse())).toEqual(options);
    expect(searchTagOptions([])).toEqual([]);
    expect(Object.isFrozen(options)).toBe(true);
    expect(options.every(Object.isFrozen)).toBe(true);
  });
});
