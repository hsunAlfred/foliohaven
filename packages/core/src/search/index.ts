import type {
  Article,
  ArticleListQuery,
  SearchDocument,
  Category,
  Tag,
  Job,
  JobListQuery,
  MediaSourceResource,
  MediaListQuery,
  SiteConfig,
} from '../models/index.js';
import { SearchIndexSchema } from '../schemas/api.js';
import { CategoryPathSchema, SlugSchema } from '../schemas/common.js';
import { asciiCompare, paginate, sortArticles } from '../pagination/index.js';
import { resolveArticleDescription } from '../seo/index.js';
export { searchPageViewModel } from './page.js';

export class SearchQueryError extends Error {
  readonly code = 'SEARCH_QUERY_TOO_LONG';
  constructor() {
    super('搜尋文字最多 200 字元。');
    this.name = 'SearchQueryError';
  }
}
export function normalizeSearchQuery(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
  if (normalized.length > 200) throw new SearchQueryError();
  return normalized;
}
export interface SearchFilters {
  readonly categories?: readonly string[];
  readonly tags?: readonly string[];
}
export interface SearchQuery {
  readonly q: string;
  readonly categories: readonly string[];
  readonly tags: readonly string[];
  readonly page: number | null;
  readonly valid: boolean;
  readonly error: 'QUERY_TOO_LONG' | 'INVALID_PAGE' | null;
}
/** Ignore malformed identifiers, but keep valid unknown selections as empty matches. */
function normalizeFilterValues(
  values: readonly string[],
  kind: 'category' | 'tag',
) {
  const schema = kind === 'category' ? CategoryPathSchema : SlugSchema;
  return Object.freeze(
    [
      ...new Set(
        values.map((value) => value.normalize('NFKC').trim().toLowerCase()),
      ),
    ]
      .filter((value) => schema.safeParse(value).success)
      .sort(asciiCompare),
  );
}
export function parseSearchQuery(query: string | URLSearchParams): SearchQuery {
  const params =
    typeof query === 'string'
      ? new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
      : query;
  const categories = normalizeFilterValues(
    params.getAll('category'),
    'category',
  );
  const tags = normalizeFilterValues(params.getAll('tag'), 'tag');
  let q: string;
  try {
    q = normalizeSearchQuery(params.get('q') ?? '');
  } catch {
    return Object.freeze({
      q: params.get('q') ?? '',
      categories,
      tags,
      page: null,
      valid: false,
      error: 'QUERY_TOO_LONG',
    });
  }
  const rawPage = params.get('page');
  if (
    rawPage !== null &&
    (!/^[1-9]\d*$/u.test(rawPage) || !Number.isSafeInteger(Number(rawPage)))
  )
    return Object.freeze({
      q,
      categories,
      tags,
      page: null,
      valid: false,
      error: 'INVALID_PAGE',
    });
  return Object.freeze({
    q,
    categories,
    tags,
    page: rawPage === null ? 1 : Number(rawPage),
    valid: true,
    error: null,
  });
}
export function searchQueryUrl(
  q: string,
  page = 1,
  filters: SearchFilters = {},
): string {
  const normalized = normalizeSearchQuery(q);
  if (!Number.isSafeInteger(page) || page < 1)
    throw new RangeError('搜尋頁碼必須為正整數。');
  const params = new URLSearchParams();
  if (normalized !== '') params.set('q', normalized);
  for (const category of normalizeFilterValues(
    filters.categories ?? [],
    'category',
  ))
    params.append('category', category);
  for (const tag of normalizeFilterValues(filters.tags ?? [], 'tag'))
    params.append('tag', tag);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return `/articles/${query === '' ? '' : `?${query}`}`;
}
function searchText(document: SearchDocument): string {
  return normalizeSearchText(
    [
      document.title,
      document.description,
      document.category.path,
      document.category.name,
      ...document.tags.flatMap((tag) => [tag.slug, tag.name]),
    ].join(' '),
  );
}
function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');
}
/** Project only tags directly related to the active public search query. */
export function matchedSearchTags<
  T extends { readonly slug: string; readonly name: string },
>(tags: readonly T[], query: SearchQuery | string): readonly T[] {
  const state = typeof query === 'string' ? parseSearchQuery(query) : query;
  if (!state.valid || state.page === null) return Object.freeze([] as T[]);
  let normalized: string;
  try {
    normalized = normalizeSearchQuery(state.q);
  } catch {
    return Object.freeze([] as T[]);
  }
  const tokens = [...new Set(normalized.split(' ').filter(Boolean))];
  return Object.freeze(
    tags.filter(
      (tag) =>
        state.tags.includes(tag.slug) ||
        tokens.some((token) =>
          normalizeSearchText(`${tag.name} ${tag.slug}`).includes(token),
        ),
    ),
  );
}
/** 管理集合共用純規則；儲存層可先分頁metadata，再讀取較昂貴的媒體資料。 */
export function filterMediaSources<
  T extends Pick<MediaSourceResource, 'id' | 'kind' | 'displayName'> & {
    readonly source?: string;
  },
>(sources: readonly T[], query: MediaListQuery) {
  const tokens = normalizeSearchQuery(query.q).split(' ').filter(Boolean);
  const filtered = sources
    .filter(
      (source) =>
        (query.type === undefined || source.kind === query.type) &&
        (query.format === undefined ||
          source.source === `original.${query.format}`) &&
        tokens.every((token) =>
          normalizeSearchText(`${source.displayName} ${source.id}`).includes(
            token,
          ),
        ),
    )
    .sort(
      (left, right) =>
        asciiCompare(
          normalizeSearchText(left.displayName),
          normalizeSearchText(right.displayName),
        ) || asciiCompare(left.id, right.id),
    );
  return paginate(filtered, query.page, query.pageSize);
}
export function filterJobs<
  T extends Pick<Job, 'id' | 'type' | 'status' | 'createdAt'>,
>(jobs: readonly T[], query: JobListQuery) {
  const filtered = jobs
    .filter(
      (job) =>
        (query.type === undefined || job.type === query.type) &&
        (query.status === undefined || job.status === query.status),
    )
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        asciiCompare(left.id, right.id),
    );
  return paginate(filtered, query.page, query.pageSize);
}
export function paginateRecoveries<
  T extends { readonly id: string; readonly createdAt: string },
>(
  recoveries: readonly T[],
  query: { readonly page: number; readonly pageSize: number },
) {
  return paginate(
    [...recoveries].sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        asciiCompare(left.id, right.id),
    ),
    query.page,
    query.pageSize,
  );
}
export function searchDocuments(
  documents: readonly SearchDocument[],
  query: SearchQuery | string,
  pageSize = 10,
) {
  const state = typeof query === 'string' ? parseSearchQuery(query) : query;
  if (!state.valid || state.page === null)
    return Object.freeze({
      items: Object.freeze([] as SearchDocument[]),
      total: 0,
      page: state.page,
      pageSize,
      totalPages: 1,
      validPage: false,
      error: state.error,
    });
  const tokens = [
    ...new Set(normalizeSearchQuery(state.q).split(' ').filter(Boolean)),
  ];
  const filtered = documents
    .filter(
      (document) =>
        (state.categories.length === 0 ||
          state.categories.some(
            (category) =>
              document.category.path === category ||
              document.category.path.startsWith(`${category}/`),
          )) &&
        (state.tags.length === 0 ||
          document.tags.some((tag) => state.tags.includes(tag.slug))),
    )
    .map((document) => {
      const text = tokens.length === 0 ? '' : searchText(document);
      return {
        document,
        matchedTerms: tokens.filter((token) => text.includes(token)).length,
      };
    })
    .filter(({ matchedTerms }) => tokens.length === 0 || matchedTerms > 0)
    .sort(
      (left, right) =>
        right.matchedTerms - left.matchedTerms ||
        Date.parse(right.document.publishedAt) -
          Date.parse(left.document.publishedAt) ||
        asciiCompare(left.document.id, right.document.id),
    )
    .map(({ document }) => document);
  return Object.freeze({
    ...paginate(filtered, state.page, pageSize),
    error: null,
  });
}
export interface SearchTagOption {
  readonly slug: string;
  readonly name: string;
  readonly articleCount: number;
}
/** Build all tag choices from the same published documents used by search. */
export function searchTagOptions(
  documents: readonly SearchDocument[],
): readonly SearchTagOption[] {
  const options = new Map<string, SearchTagOption>();
  for (const document of documents) {
    const seen = new Set<string>();
    for (const tag of document.tags) {
      if (seen.has(tag.slug)) continue;
      seen.add(tag.slug);
      const previous = options.get(tag.slug);
      options.set(tag.slug, {
        slug: tag.slug,
        name: previous?.name ?? tag.name,
        articleCount: (previous?.articleCount ?? 0) + 1,
      });
    }
  }
  return Object.freeze(
    [...options.values()]
      .sort(
        (left, right) =>
          asciiCompare(left.name, right.name) ||
          asciiCompare(left.slug, right.slug),
      )
      .map((option) => Object.freeze(option)),
  );
}
export function parseSearchIndex(input: unknown) {
  return SearchIndexSchema.parse(input);
}
export function filterArticles<T extends Article>(
  articles: readonly T[],
  query: ArticleListQuery,
  taxonomy: {
    readonly categories?: readonly Category[];
    readonly tags?: readonly Tag[];
    readonly site?: SiteConfig;
  } = {},
) {
  const q = normalizeSearchQuery(query.q);
  const tokens = q.split(' ').filter(Boolean);
  const filtered = articles.filter(
    (article) =>
      (query.status === undefined || article.meta.status === query.status) &&
      (query.category === undefined ||
        article.meta.category === query.category ||
        article.meta.category?.startsWith(`${query.category}/`)) &&
      (query.tag === undefined || article.meta.tags.includes(query.tag)) &&
      tokens.every((token) =>
        normalizeSearchText(
          [
            article.meta.title,
            article.meta.slug,
            article.meta.category ?? '',
            taxonomy.categories?.find(
              (category) => category.path === article.meta.category,
            )?.name ?? '',
            ...article.meta.tags,
            ...article.meta.tags.map(
              (slug) =>
                taxonomy.tags?.find((tag) => tag.slug === slug)?.name ?? '',
            ),
            resolveArticleDescription(article.meta, taxonomy.site),
          ].join(' '),
        ).includes(token),
      ),
  );
  let sorted = [...sortArticles(filtered)];
  if (query.sort === 'published-asc')
    sorted = [...filtered].sort((left, right) => {
      const leftTime =
        left.meta.publishedAt === null
          ? Number.POSITIVE_INFINITY
          : Date.parse(left.meta.publishedAt);
      const rightTime =
        right.meta.publishedAt === null
          ? Number.POSITIVE_INFINITY
          : Date.parse(right.meta.publishedAt);
      return (
        (leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0) ||
        asciiCompare(left.articleId, right.articleId)
      );
    });
  if (query.sort === 'updated-desc')
    sorted = [...filtered].sort(
      (left, right) =>
        (right.meta.updatedAt === null ? 0 : Date.parse(right.meta.updatedAt)) -
          (left.meta.updatedAt === null
            ? 0
            : Date.parse(left.meta.updatedAt)) ||
        asciiCompare(left.articleId, right.articleId),
    );
  if (query.sort === 'title-asc')
    sorted = [...filtered].sort(
      (left, right) =>
        asciiCompare(left.meta.title, right.meta.title) ||
        asciiCompare(left.articleId, right.articleId),
    );
  if (query.sort === 'id-asc')
    sorted = [...filtered].sort((left, right) =>
      asciiCompare(left.articleId, right.articleId),
    );
  return paginate(sorted, query.page, query.pageSize);
}
