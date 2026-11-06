import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import {
  ArticleCard,
  ArticlePage,
  ArticlesPage,
  Breadcrumb,
  CategoryPage,
  HomePage,
  Navigation,
  NotFoundPage,
  Pagination,
  SiteFooter,
  SiteHeader,
  StateMessage,
  TableOfContents,
  TagPage,
} from '@foliohaven/ui';
import { uiModels, uiRawHtml } from '../fixtures/ui-models.js';

function elements(
  html: string,
  tag: string,
): DefaultTreeAdapterMap['element'][] {
  const result: DefaultTreeAdapterMap['element'][] = [];
  const walk = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node && node.tagName === tag) result.push(node);
    if ('childNodes' in node) for (const child of node.childNodes) walk(child);
  };
  walk(parse(html));
  return result;
}
function attr(
  element: DefaultTreeAdapterMap['element'] | undefined,
  name: string,
) {
  return element?.attrs.find((item) => item.name === name)?.value;
}
function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('測試模型缺少必要項目。');
  return item;
}

describe('compiled shared UI public entry', () => {
  it('pre-renders the complete article and keeps author HTML byte-for-byte inside its wrapper', () => {
    const { model } = uiModels();
    const article = first(model.articlePages);
    const html = renderToStaticMarkup(<ArticlePage article={article} />);
    expect(html).toContain(uiRawHtml);
    expect(elements(html, 'main')).toHaveLength(1);
    expect(elements(html, 'h1')).toHaveLength(1);
    expect(attr(first(elements(html, 'main')), 'id')).toBe('ui-main');
    expect(html).toContain(
      '文字 &lt;script&gt;不執行&lt;/script&gt; &amp; 標題',
    );
    expect(html).not.toContain('<script>不執行</script>');
    expect(html).toContain('範例 &lt;&amp;&gt;');
    expect(html).toContain('RAW_HTML_SENTINEL');
    expect(html).not.toContain('client:load');
    expect(html).not.toContain('<script');
  });
  it('renders manifest-provided image dimensions/srcset, explicit alt and timezone-formatted dates', () => {
    const article = first(uiModels().model.articlePages);
    const html = renderToStaticMarkup(<ArticlePage article={article} />);
    const image = first(elements(html, 'img'));
    expect(attr(image, 'width')).toBe('1200');
    expect(attr(image, 'height')).toBe('675');
    expect(attr(image, 'alt')).toBe('圖片 & 替代文字');
    expect(attr(image, 'srcset')).toContain('image-480.webp 480w');
    expect(attr(image, 'sizes')).toBe('(max-width: 768px) 100vw, 1280px');
    const times = elements(html, 'time');
    expect(attr(times[0], 'datetime')).toBe('2026-10-22T23:30:00Z');
    expect(html).toContain('2026年10月23日');
  });
  it('renders TOC anchor IDs safely, preserving ordering and omitting an empty TOC', () => {
    const html = renderToStaticMarkup(
      <TableOfContents
        entries={[
          { id: '章節', text: '<img onerror="bad">', level: 2 },
          { id: 'details', text: '詳細', level: 3 },
        ]}
      />,
    );
    expect(html).toContain('href="#%E7%AB%A0%E7%AF%80"');
    expect(html).toContain('&lt;img onerror=&quot;bad&quot;&gt;');
    expect(html).not.toContain('<img');
    expect(html.indexOf('href="#%E7%AB%A0%E7%AF%80"')).toBeLessThan(
      html.indexOf('href="#details"'),
    );
    expect(renderToStaticMarkup(<TableOfContents entries={[]} />)).toBe('');
    const withoutHeading = uiModels().model.articlePages.find(
      (article) => article.articleId === 'ui-third',
    );
    if (withoutHeading === undefined) throw new Error('缺少零 Tag 模型');
    const page = renderToStaticMarkup(<ArticlePage article={withoutHeading} />);
    expect(page).not.toContain('ui-toc-title');
    expect(page).not.toContain('aria-label="文章標籤"');
  });
  it('uses the same ArticlePage for incomplete draft previews without fake route links', () => {
    const { preview } = uiModels();
    const html = renderToStaticMarkup(<ArticlePage article={preview} />);
    expect(elements(html, 'h1')).toHaveLength(1);
    expect(html).toContain('未命名草稿');
    expect(html).toContain('未命名草稿正文。');
    expect(html).toContain('草稿預覽');
    expect(html).toContain('發布日期尚未設定');
    expect(
      elements(html, 'a').some((element) => attr(element, 'href') === ''),
    ).toBe(false);
    expect(html).not.toContain('href="null"');
  });
  it('provides semantic site landmarks, skip link, navigation state and RSS', () => {
    const site = uiModels().model.home.site;
    const html = renderToStaticMarkup(
      <>
        <SiteHeader site={site} currentPath="/category/notes/" />
        <main id="ui-main">
          <h1>內容</h1>
        </main>
        <SiteFooter site={site} />
      </>,
    );
    expect(elements(html, 'header')).toHaveLength(1);
    expect(elements(html, 'footer')).toHaveLength(1);
    expect(html).toContain('href="#ui-main"');
    expect(
      elements(html, 'a').some(
        (element) =>
          attr(element, 'href') === '/category/notes/' &&
          attr(element, 'aria-current') === 'page',
      ),
    ).toBe(true);
    expect(html).toContain('訂閱 RSS');
    expect(renderToStaticMarkup(<Navigation items={[]} />)).toBe('');
  });
  it('renders breadcrumbs and static pagination as ordinary links with current-page semantics', () => {
    const model = uiModels().model;
    const category = model.listPages.find(
      (page) =>
        page.kind === 'category' &&
        page.key === 'notes' &&
        page.pagination.page === 1,
    );
    if (category === undefined) throw new Error('缺少分類模型');
    const html = renderToStaticMarkup(<CategoryPage model={category} />);
    expect(elements(html, 'h1')).toHaveLength(1);
    expect(html).toContain('href="/category/notes/2/"');
    expect(html).not.toContain('/category/notes/1/');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('rel="next"');
    expect(
      renderToStaticMarkup(
        <Pagination pagination={{ ...category.pagination, totalPages: 1 }} />,
      ),
    ).toBe('');
    const breadcrumb = renderToStaticMarkup(
      <Breadcrumb
        items={[
          { name: '首頁', url: '/' },
          { name: '尚無路由', url: null },
        ]}
      />,
    );
    expect(breadcrumb).not.toContain('href="null"');
    expect(breadcrumb).toContain('<span aria-current="page">尚無路由</span>');
  });
  it('renders homepage categories, featured/latest collections and empty list pages', () => {
    const { model } = uiModels();
    const home = renderToStaticMarkup(<HomePage model={model.home} />);
    expect(elements(home, 'h1')).toHaveLength(1);
    expect(home).toContain('精選文章');
    expect(home).toContain('最新文章');
    expect(home).toContain('/category/notes/');
    expect(home).toContain('/articles/');
    const category = model.listPages.find(
      (page) => page.kind === 'category' && page.key === 'empty',
    );
    const tag = model.listPages.find(
      (page) => page.kind === 'tag' && page.key === 'empty',
    );
    if (category === undefined || tag === undefined)
      throw new Error('缺少空集合模型');
    expect(renderToStaticMarkup(<CategoryPage model={category} />)).toContain(
      '這個分類目前還沒有已發布文章。',
    );
    expect(renderToStaticMarkup(<TagPage model={tag} />)).toContain(
      '這個標籤目前還沒有已發布文章。',
    );
  });
  it('renders a complete initial articles page with search and no false no-JS query pagination', () => {
    const model = uiModels().model.listPages.find(
      (page) => page.kind === 'articles',
    );
    if (model === undefined) throw new Error('缺少總覽模型');
    const html = renderToStaticMarkup(<ArticlesPage model={model} />);
    expect(elements(html, 'main')).toHaveLength(1);
    expect(elements(html, 'h1')).toHaveLength(1);
    expect(elements(html, 'form')).toHaveLength(1);
    expect(html).toContain('name="q"');
    expect(html).not.toContain('RAW_HTML_SENTINEL');
    expect(html).toContain('搜尋功能需要 JavaScript');
    expect(html).not.toContain('aria-label="文章分頁"');
    const interactive = renderToStaticMarkup(
      <ArticlesPage
        model={model}
        searchControls={<p>查詢控制介面</p>}
        resultsStatus="索引載入中"
        showPagination
      />,
    );
    expect(interactive).toContain('查詢控制介面');
    expect(interactive).toContain('索引載入中');
    expect(interactive).toContain('aria-label="文章分頁"');
  });
  it('provides meaningful loading/error/empty states and a navigable 404', () => {
    const html = renderToStaticMarkup(
      <>
        <StateMessage kind="loading" title="載入中" />
        <StateMessage
          kind="error"
          title="載入失敗"
          action={<button>重試</button>}
        />
        <StateMessage title="沒有資料" />
      </>,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('重試');
    const page = renderToStaticMarkup(
      <NotFoundPage site={uiModels().model.home.site} />,
    );
    expect(elements(page, 'h1')).toHaveLength(1);
    expect(page).toContain('找不到這個頁面');
    expect(page).toContain('href="/articles/"');
  });
  it('renders article cards without adding another main or h1', () => {
    const { model } = uiModels();
    const html = renderToStaticMarkup(
      <ArticleCard article={first(model.home.latest)} site={model.home.site} />,
    );
    expect(elements(html, 'main')).toHaveLength(0);
    expect(elements(html, 'h1')).toHaveLength(0);
    expect(elements(html, 'h2')).toHaveLength(1);
    expect(html).toContain('展示文章 1 的摘要。');
  });
});
