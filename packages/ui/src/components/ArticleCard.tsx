import type { ArticleCardViewModel, SiteViewModel } from '@foliohaven/core';
import { ArticleDate } from './ArticleDate.js';
import { ManagedImage } from './ManagedImage.js';

export interface ArticleCardProps {
  readonly article: ArticleCardViewModel;
  readonly site: Pick<SiteViewModel, 'language' | 'timeZone'>;
  readonly headingLevel?: 2 | 3;
}
export function ArticleCard({
  article,
  site,
  headingLevel = 2,
}: ArticleCardProps) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <article className="article-card">
      {article.featuredImage !== null && (
        <a
          className="article-card-image"
          href={article.url}
          tabIndex={-1}
          aria-hidden="true"
        >
          <ManagedImage image={article.featuredImage} />
        </a>
      )}
      <div className="article-card-content">
        <div className="article-card-meta">
          <a href={article.category.url}>{article.category.name}</a>
          <ArticleDate
            value={article.publishedAt}
            language={site.language}
            timeZone={site.timeZone}
          />
        </div>
        <Heading className="article-card-title">
          <a href={article.url}>{article.title}</a>
        </Heading>
        <p>{article.description}</p>
        {article.tags.length > 0 && (
          <ul className="tag-list" aria-label="文章標籤">
            {article.tags.map((tag) => (
              <li key={tag.slug}>
                <a href={tag.url}>{tag.name}</a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
