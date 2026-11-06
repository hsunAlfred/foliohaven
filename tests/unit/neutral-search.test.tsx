import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSearchQuery } from '@foliohaven/core';
import { ArticlesPage } from '@foliohaven/ui';
import ArticlesSearch, {
  SearchFilters,
} from '../../site/src/components/ArticlesSearch.js';
import { uiModels } from '../fixtures/ui-models.js';

describe('neutral public search filters', () => {
  it('renders selected category/Tag controls in the ordinary search form without an embedded brand layout', () => {
    const model = uiModels().model;
    const html = renderToStaticMarkup(
      <SearchFilters
        query={parseSearchQuery('?category=notes&tag=example')}
        categories={model.home.categories}
        tags={[{ slug: 'example', name: '範例 <&>', articleCount: 2 }]}
      />,
    );
    expect(html).toContain('name="category"');
    expect(html).toContain('name="tag"');
    expect(html.match(/checked=""/gu)).toHaveLength(2);
    expect(html).toContain('範例 &lt;&amp;&gt;');
    expect(html).toContain('已選 2 項');
    expect(html).not.toContain('cl-');
  });

  it('keeps a complete SSR first page and native form while loading the optional search index', () => {
    const model = uiModels().model;
    const list = model.listPages.find((item) => item.kind === 'articles');
    if (!list) throw new Error('Missing article list');
    const html = renderToStaticMarkup(
      <ArticlesSearch
        model={list}
        categories={model.home.categories}
        tags={[{ slug: 'example', name: '範例', articleCount: 2 }]}
      />,
    );
    expect(html).toContain('data-search-state="loading"');
    expect(html).toContain('data-search-result-state="pending"');
    expect(html).toContain('action="/articles/"');
    expect(html).toContain('name="category"');
    expect(html).toContain('name="tag"');
    expect(html).toContain('清除搜尋與篩選');
    expect(html).toContain('article-card-title');
    expect(html).not.toContain('RAW_HTML_SENTINEL');
    const standalone = renderToStaticMarkup(
      <ArticlesPage
        model={list}
        filterControls={<p>FILTER_CONTROL_SENTINEL</p>}
      />,
    );
    expect(standalone).toContain('FILTER_CONTROL_SENTINEL');
  });
});
