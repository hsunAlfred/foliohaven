import type { ArticleViewModel } from '@foliohaven/core';
import { ArticleDate } from '../components/ArticleDate.js';
import { Breadcrumb } from '../components/Breadcrumb.js';
import { ManagedImage } from '../components/ManagedImage.js';
import { StateMessage } from '../components/StateMessage.js';
import { ArticleList } from '../components/ArticleList.js';
import { TableOfContents } from './TableOfContents.js';

export interface ArticlePageProps {
  readonly article: ArticleViewModel;
}
export function ArticlePage({ article }: ArticlePageProps) {
  return (
    <main id="ui-main" className="page-container article-page" tabIndex={-1}>
      <Breadcrumb items={article.breadcrumb} />
      {article.context === 'preview' && (
        <StateMessage
          kind="info"
          title={article.meta.status === 'draft' ? '草稿預覽' : '文章預覽'}
        >
          <p>
            {article.publishable
              ? '內容已通過目前的發布檢查。'
              : '文章尚未符合發布條件，請查看編輯器中的診斷。'}
          </p>
        </StateMessage>
      )}
      <article>
        <header className="article-header">
          {article.category !== null && (
            <a className="article-category" href={article.category.url}>
              {article.category.name}
            </a>
          )}
          <h1>
            {article.meta.title.trim() === ''
              ? '未命名草稿'
              : article.meta.title}
          </h1>
          {article.description !== '' && (
            <p className="article-summary">{article.description}</p>
          )}
          <div className="article-dates">
            {article.meta.publishedAt !== null && (
              <ArticleDate
                label="發布"
                value={article.meta.publishedAt}
                language={article.site.language}
                timeZone={article.site.timeZone}
              />
            )}
            {article.meta.updatedAt !== null && (
              <ArticleDate
                label="更新"
                value={article.meta.updatedAt}
                language={article.site.language}
                timeZone={article.site.timeZone}
              />
            )}
            {article.meta.publishedAt === null &&
              article.context === 'preview' && <span>發布日期尚未設定</span>}
          </div>
          {article.tags.length > 0 && (
            <ul className="tag-list" aria-label="文章標籤">
              {article.tags.map((tag) => (
                <li key={tag.slug}>
                  <a href={tag.url}>{tag.name}</a>
                </li>
              ))}
            </ul>
          )}
          {article.featuredImage !== null && (
            <figure className="article-featured-image">
              <ManagedImage image={article.featuredImage} priority />
            </figure>
          )}
        </header>
        <div
          className={
            article.toc.length > 0 ? 'article-grid' : 'article-grid without-toc'
          }
        >
          <TableOfContents entries={article.toc} />
          <div
            className="article-body"
            data-article-body
            dangerouslySetInnerHTML={{ __html: article.contentHtml }}
          />
        </div>
        {article.relatedReading !== undefined &&
          article.relatedReading.articles.length > 0 && (
            <section
              className="page-section related-reading"
              aria-labelledby="ui-related-reading-title"
              data-related-reading
            >
              <h2 id="ui-related-reading-title">
                {article.relatedReading.title}
              </h2>
              <ArticleList
                articles={article.relatedReading.articles}
                site={article.site}
                headingLevel={3}
              />
            </section>
          )}
      </article>
    </main>
  );
}
