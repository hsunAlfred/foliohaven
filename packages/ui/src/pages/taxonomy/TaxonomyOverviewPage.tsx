import type { CategoryTreeNode } from '@foliohaven/core';
import { Breadcrumb } from '../../components/Breadcrumb.js';
import { StateMessage } from '../../components/StateMessage.js';

export interface TagDirectoryEntry {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly articleCount: number;
}

export interface TaxonomyOverviewPageProps {
  readonly kind: 'category' | 'tag';
  readonly description: string;
  readonly categories: readonly CategoryTreeNode[];
  readonly tags: readonly TagDirectoryEntry[];
}

function CategoryDirectory({
  categories,
}: {
  readonly categories: readonly CategoryTreeNode[];
}) {
  return (
    <ul className="taxonomy-directory">
      {categories.map((category) => (
        <li key={category.path}>
          <a href={category.url} className="taxonomy-directory-link">
            <span className="taxonomy-directory-name">{category.name}</span>
            <span className="category-count">{category.articleCount} 篇</span>
          </a>
          {category.description !== '' && <p>{category.description}</p>}
          {category.children.length > 0 && (
            <CategoryDirectory categories={category.children} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** Present Core's taxonomy order, descriptions, links and published counts. */
export function TaxonomyOverviewPage({
  kind,
  description,
  categories,
  tags,
}: TaxonomyOverviewPageProps) {
  const category = kind === 'category';
  const title = category ? '分類總覽' : 'Tag 總覽';
  return (
    <main
      id="ui-main"
      className="page-container taxonomy-overview"
      tabIndex={-1}
    >
      <Breadcrumb
        items={[
          { name: '首頁', url: '/' },
          { name: title, url: null },
        ]}
      />
      <header className="page-heading">
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
        <a href={category ? '/tag/' : '/category/'}>
          {category ? 'Tag 總覽' : '分類總覽'}
        </a>
      </header>
      <section aria-label={category ? '全部分類' : '全部 Tag'}>
        {category ? (
          categories.length > 0 ? (
            <CategoryDirectory categories={categories} />
          ) : (
            <StateMessage title="目前還沒有分類。" />
          )
        ) : tags.length > 0 ? (
          <ul className="taxonomy-directory">
            {tags.map((tag) => (
              <li key={tag.slug}>
                <a className="taxonomy-directory-link" href={tag.url}>
                  <span className="taxonomy-directory-name">{tag.name}</span>
                  <span className="category-count">{tag.articleCount} 篇</span>
                </a>
                {tag.description !== '' && <p>{tag.description}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <StateMessage title="目前還沒有 Tag。" />
        )}
      </section>
    </main>
  );
}
