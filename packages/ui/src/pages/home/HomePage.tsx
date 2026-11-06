import type { CategoryTreeNode, HomeViewModel } from '@foliohaven/core';
import { ArticleList } from '../../components/ArticleList.js';

export interface HomePageProps {
  readonly model: HomeViewModel;
}
function CategoryLinks({
  categories,
}: {
  readonly categories: readonly CategoryTreeNode[];
}) {
  return (
    <ul className="category-links">
      {categories.map((category) => (
        <li key={category.path}>
          <a href={category.url}>
            {category.name}
            <span className="category-count">{category.articleCount} 篇</span>
          </a>
          {category.children.length > 0 && (
            <CategoryLinks categories={category.children} />
          )}
        </li>
      ))}
    </ul>
  );
}
export function HomePage({ model }: HomePageProps) {
  return (
    <main id="ui-main" className="page-container home-page" tabIndex={-1}>
      <header className="page-heading">
        <p className="eyebrow">文章與筆記</p>
        <h1>{model.site.siteName}</h1>
        <p className="page-description">{model.site.siteDescription}</p>
      </header>
      {model.categories.length > 0 && (
        <section className="page-section" aria-labelledby="ui-categories-title">
          <h2 id="ui-categories-title">文章分類</h2>
          <CategoryLinks categories={model.categories} />
        </section>
      )}
      {model.featured.length > 0 && (
        <section className="page-section" aria-labelledby="ui-featured-title">
          <h2 id="ui-featured-title">精選文章</h2>
          {model.featuredCaption !== '' &&
            model.featuredCaption !== '精選文章' && (
              <p className="featured-caption">{model.featuredCaption}</p>
            )}
          <ArticleList
            articles={model.featured}
            site={model.site}
            headingLevel={3}
          />
        </section>
      )}
      <section className="page-section" aria-labelledby="ui-latest-title">
        <div className="section-heading">
          <h2 id="ui-latest-title">最新文章</h2>
          <a href="/articles/">所有文章</a>
        </div>
        <ArticleList
          articles={model.latest}
          site={model.site}
          headingLevel={3}
          emptyMessage="目前還沒有已發布文章。"
        />
      </section>
    </main>
  );
}
