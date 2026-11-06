import type { ArticleCardViewModel, SiteViewModel } from '@foliohaven/core';
import { ArticleCard } from './ArticleCard.js';
import { StateMessage } from './StateMessage.js';

export interface ArticleListProps {
  readonly articles: readonly ArticleCardViewModel[];
  readonly site: Pick<SiteViewModel, 'language' | 'timeZone'>;
  readonly headingLevel?: 2 | 3;
  readonly emptyMessage?: string;
}
export function ArticleList({
  articles,
  site,
  headingLevel = 2,
  emptyMessage = '目前還沒有文章。',
}: ArticleListProps) {
  if (articles.length === 0) return <StateMessage title={emptyMessage} />;
  return (
    <ul className="article-list">
      {articles.map((article) => (
        <li key={article.articleId}>
          <ArticleCard
            article={article}
            site={site}
            headingLevel={headingLevel}
          />
        </li>
      ))}
    </ul>
  );
}
