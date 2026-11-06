import type { ListPageViewModel } from '@foliohaven/core';
import { ArticleList } from '../../components/ArticleList.js';
import { Breadcrumb } from '../../components/Breadcrumb.js';
import { Pagination } from '../../components/Pagination.js';

export interface CategoryPageProps {
  readonly model: ListPageViewModel;
}
export function CategoryPage({ model }: CategoryPageProps) {
  return (
    <main id="ui-main" className="page-container list-page" tabIndex={-1}>
      <Breadcrumb items={model.breadcrumb} />
      <header className="page-heading">
        <p className="eyebrow">文章分類</p>
        <h1>{model.title}</h1>
        <p className="page-description">{model.description}</p>
        <p className="result-count">共 {model.pagination.totalItems} 篇文章</p>
      </header>
      <ArticleList
        articles={model.articles}
        site={model.site}
        emptyMessage="這個分類目前還沒有已發布文章。"
      />
      <Pagination pagination={model.pagination} />
    </main>
  );
}
