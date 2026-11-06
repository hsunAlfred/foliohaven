import type {
  ArticleCardViewModel,
  ListPageViewModel,
  SearchDocument,
} from '../models/index.js';
import { paginationViewModel } from '../pagination/index.js';
import { categoryUrl, tagUrl } from '../routing/index.js';
import {
  parseSearchQuery,
  searchDocuments,
  searchQueryUrl,
  type SearchQuery,
} from './index.js';

/** 公開搜尋的卡片、路由與分頁由Core投影；保留SSG的SEO／站台／頁面資訊。 */
export function searchPageViewModel(
  initial: ListPageViewModel,
  documents: readonly SearchDocument[],
  query: SearchQuery | string,
) {
  const state = typeof query === 'string' ? parseSearchQuery(query) : query;
  const result = searchDocuments(documents, state, initial.pagination.pageSize);
  const articles: readonly ArticleCardViewModel[] = result.items.map(
    (document) =>
      Object.freeze({
        articleId: document.id,
        title: document.title,
        url: document.url,
        description: document.description,
        publishedAt: document.publishedAt,
        updatedAt: document.updatedAt,
        category: Object.freeze({
          ...document.category,
          description: '',
          url: categoryUrl(document.category.path),
        }),
        tags: Object.freeze(
          document.tags.map((tag) =>
            Object.freeze({ ...tag, description: '', url: tagUrl(tag.slug) }),
          ),
        ),
        featuredImage: document.featuredImage,
      }),
  );
  const firstPageUrl =
    state.error === 'QUERY_TOO_LONG'
      ? '/articles/'
      : searchQueryUrl(state.q, 1, state);
  const pagination = paginationViewModel(
    result.total,
    result.page ?? 1,
    initial.pagination.pageSize,
    (page) =>
      searchQueryUrl(
        state.error === 'QUERY_TOO_LONG' ? '' : state.q,
        page,
        state.error === 'QUERY_TOO_LONG' ? {} : state,
      ),
  );
  return Object.freeze({
    model: Object.freeze({
      ...initial,
      articles: Object.freeze(articles),
      pagination,
    }),
    validPage: result.validPage,
    error: result.error,
    firstPageUrl,
  });
}
