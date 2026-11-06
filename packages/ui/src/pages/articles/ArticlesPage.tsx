import type { ReactNode } from 'react';
import type { ListPageViewModel } from '@foliohaven/core';
import { ArticleList } from '../../components/ArticleList.js';
import { Breadcrumb } from '../../components/Breadcrumb.js';
import { Pagination } from '../../components/Pagination.js';

export interface ArticlesPageProps {
  readonly model: ListPageViewModel;
  readonly searchControls?: ReactNode;
  readonly filterControls?: ReactNode;
  readonly resultsStatus?: ReactNode;
  readonly emptyMessage?: string;
  readonly showPagination?: boolean;
}
export function ArticlesPage({
  model,
  searchControls,
  filterControls,
  resultsStatus,
  emptyMessage = '目前還沒有已發布文章。',
  showPagination = false,
}: ArticlesPageProps) {
  return (
    <main id="ui-main" className="page-container articles-page" tabIndex={-1}>
      <Breadcrumb items={model.breadcrumb} />
      <header className="page-heading">
        <h1>{model.title}</h1>
        <p className="page-description">{model.description}</p>
      </header>
      <section className="search-section" aria-labelledby="ui-search-title">
        <h2 id="ui-search-title">搜尋文章</h2>
        {searchControls ?? (
          <form className="search-form" method="get" action="/articles/">
            <label htmlFor="ui-search-query">關鍵字</label>
            <div className="search-input-row">
              <input
                id="ui-search-query"
                type="search"
                name="q"
                maxLength={200}
                placeholder="標題、分類、標籤或摘要"
              />
              <button type="submit">搜尋</button>
            </div>
          </form>
        )}
        {filterControls}
        <noscript>
          <p className="search-notice">
            搜尋功能需要
            JavaScript。目前顯示預設第一頁文章，也可透過分類與標籤瀏覽。
          </p>
        </noscript>
      </section>
      <section className="page-section" aria-labelledby="ui-results-title">
        <h2 id="ui-results-title">文章列表</h2>
        <div className="result-count" role="status" aria-live="polite">
          {resultsStatus ??
            `共 ${model.pagination.totalItems} 篇文章，目前顯示預設第一頁。`}
        </div>
        <ArticleList
          articles={model.articles}
          site={model.site}
          headingLevel={3}
          emptyMessage={emptyMessage}
        />
        {showPagination && <Pagination pagination={model.pagination} />}
      </section>
    </main>
  );
}
