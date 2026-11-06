import {
  useEffect,
  useState,
  useSyncExternalStore,
  type SubmitEvent,
  type MouseEvent,
} from 'react';
import {
  parseSearchIndex,
  parseSearchQuery,
  searchPageViewModel,
  searchQueryUrl,
  type CategoryTreeNode,
  type ListPageViewModel,
  type SearchIndex,
  type SearchQuery,
  type SearchTagOption,
} from '@foliohaven/core';
import { ArticlesPage } from '@foliohaven/ui';

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
const currentQuery = () => window.location.search;
const serverQuery = () => '';
type IndexState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly index: SearchIndex };
async function readIndex(signal: AbortSignal): Promise<SearchIndex> {
  const response = await fetch('/search-index.json', {
    signal,
    cache: 'no-cache',
    credentials: 'same-origin',
  });
  if (
    !response.ok ||
    !/^application\/json(?:;|$)/iu.test(
      response.headers.get('content-type') ?? '',
    ) ||
    !response.body
  )
    throw new Error('SEARCH_INDEX_UNAVAILABLE');
  const limit = 64 * 1024 * 1024;
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > limit)
    throw new Error('SEARCH_INDEX_TOO_LARGE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw new Error('SEARCH_INDEX_TOO_LARGE');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseSearchIndex(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown,
  );
}

function CategoryOptions({
  categories,
  selected,
}: {
  readonly categories: readonly CategoryTreeNode[];
  readonly selected: readonly string[];
}) {
  return (
    <ul>
      {categories.map((category) => (
        <li key={category.path}>
          <label>
            <input
              type="checkbox"
              name="category"
              value={category.path}
              defaultChecked={selected.includes(category.path)}
            />
            <span>{category.name}</span>
            <span className="category-count">{category.articleCount} 篇</span>
          </label>
          {category.children.length > 0 && (
            <CategoryOptions
              categories={category.children}
              selected={selected}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function SearchFilters({
  query,
  categories,
  tags,
}: {
  readonly query: SearchQuery;
  readonly categories: readonly CategoryTreeNode[];
  readonly tags: readonly SearchTagOption[];
}) {
  return (
    <details
      className="search-filters"
      open={query.categories.length > 0 || query.tags.length > 0}
    >
      <summary>
        分類與 Tag 篩選
        {query.categories.length + query.tags.length > 0
          ? `（已選 ${query.categories.length + query.tags.length} 項）`
          : ''}
      </summary>
      <div className="search-filter-columns">
        <fieldset>
          <legend>分類</legend>
          {categories.length > 0 ? (
            <CategoryOptions
              categories={categories}
              selected={query.categories}
            />
          ) : (
            <p>目前還沒有分類。</p>
          )}
        </fieldset>
        <fieldset>
          <legend>Tag</legend>
          {tags.length > 0 ? (
            <ul>
              {tags.map((tag) => (
                <li key={tag.slug}>
                  <label>
                    <input
                      type="checkbox"
                      name="tag"
                      value={tag.slug}
                      defaultChecked={query.tags.includes(tag.slug)}
                    />
                    <span>{tag.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p>目前還沒有 Tag。</p>
          )}
        </fieldset>
      </div>
      <p className="search-help">
        同組選項符合其中一項即可；分類、Tag
        與關鍵字一起篩選。選好後按「搜尋」套用。
      </p>
    </details>
  );
}

/** 唯一公開React島；SSR與hydration首畫面永遠為同一個預設第一頁。 */
export default function ArticlesSearch({
  model,
  categories = [],
  tags = [],
}: {
  readonly model: ListPageViewModel;
  readonly categories?: readonly CategoryTreeNode[];
  readonly tags?: readonly SearchTagOption[];
}) {
  const queryString = useSyncExternalStore(
    subscribe,
    currentQuery,
    serverQuery,
  );
  const query = parseSearchQuery(queryString);
  const [index, setIndex] = useState<IndexState>({ status: 'loading' });
  const [retry, setRetry] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    void readIndex(controller.signal)
      .then(
        (value) => {
          if (active) setIndex({ status: 'ready', index: value });
        },
        () => {
          if (active) setIndex({ status: 'failed' });
        },
      )
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [retry]);
  const result =
    index.status === 'ready'
      ? searchPageViewModel(model, index.index.articles, query)
      : null;
  const move = (url: string) => {
    setFormError(null);
    if (window.location.pathname + window.location.search !== url)
      window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = form.get('q');
    const params = new URLSearchParams({
      q: typeof value === 'string' ? value : '',
    });
    for (const name of ['category', 'tag']) {
      for (const selected of form.getAll(name))
        if (typeof selected === 'string') params.append(name, selected);
    }
    const next = parseSearchQuery(params);
    if (!next.valid) {
      setFormError('搜尋文字最多200字元。');
      return;
    }
    move(searchQueryUrl(next.q, 1, next));
  };
  const navigate = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      !(event.target instanceof Element)
    )
      return;
    const link = event.target.closest('a');
    if (
      !(link instanceof HTMLAnchorElement) ||
      link.target ||
      link.hasAttribute('download')
    )
      return;
    const url = new URL(link.href);
    if (
      url.origin !== window.location.origin ||
      url.pathname !== '/articles/' ||
      url.hash !== ''
    )
      return;
    event.preventDefault();
    move(url.pathname + url.search);
  };
  const error =
    formError ??
    (query.error === 'QUERY_TOO_LONG' ? '搜尋文字最多200字元。' : null);
  const controls = (
    <form
      key={queryString}
      className="search-form"
      method="get"
      action="/articles/"
      onSubmit={submit}
    >
      <label htmlFor="ui-search-query">關鍵字</label>
      <div className="search-input-row">
        <input
          key={queryString}
          id="ui-search-query"
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder="標題、分類、Tag 或摘要；空格可分開多個關鍵字"
          aria-invalid={error !== null}
          aria-describedby={error ? 'ui-query-error' : undefined}
        />
        <button type="submit">搜尋</button>
      </div>
      <SearchFilters query={query} categories={categories} tags={tags} />
      <p className="search-help">
        <a href="/articles/">清除搜尋與篩選</a>
      </p>
      {error && (
        <p id="ui-query-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
  const status =
    index.status === 'failed' ? (
      <>
        搜尋索引載入失敗，目前顯示預設第一頁。{' '}
        <button
          type="button"
          onClick={() => {
            setIndex({ status: 'loading' });
            setRetry((value) => value + 1);
          }}
        >
          重試
        </button>
      </>
    ) : result !== null ? (
      <>
        {result.validPage
          ? `共 ${result.model.pagination.totalItems} 篇文章，第 ${result.model.pagination.page} 頁。`
          : query.error === 'QUERY_TOO_LONG'
            ? '搜尋文字超過上限。'
            : '頁碼無效或超出範圍。'}
        {!result.validPage && (
          <>
            {' '}
            <a href={result.firstPageUrl}>回第一頁</a>
          </>
        )}
      </>
    ) : queryString !== '' ? (
      '搜尋索引載入中，目前顯示預設第一頁。'
    ) : undefined;
  return (
    <div
      onClick={navigate}
      data-search-state={index.status}
      data-search-result-state={
        index.status === 'loading'
          ? 'pending'
          : index.status === 'failed'
            ? 'fallback'
            : 'ready'
      }
    >
      <ArticlesPage
        model={result?.model ?? model}
        searchControls={controls}
        resultsStatus={status}
        emptyMessage={
          result !== null && !result.validPage
            ? '請調整搜尋文字或頁碼。'
            : '沒有符合條件的文章。'
        }
        showPagination={result?.validPage === true}
      />
    </div>
  );
}
