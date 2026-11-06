import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { TaxonomyOverviewPage } from '@foliohaven/ui';
import type { CategoryTreeNode } from '@foliohaven/core';

type Node = DefaultTreeAdapterMap['node'];
function elements(node: Node, tag: string): DefaultTreeAdapterMap['element'][] {
  return [
    ...('tagName' in node && node.tagName === tag ? [node] : []),
    ...('childNodes' in node
      ? node.childNodes.flatMap((child) => elements(child, tag))
      : []),
  ];
}
const categories: readonly CategoryTreeNode[] = [
  {
    path: 'notes',
    name: '筆記 <&>',
    description: '父分類的完整說明。',
    url: '/category/notes/',
    articleCount: 4,
    children: [
      {
        path: 'notes/child',
        name: '子分類',
        description: '子分類說明。',
        url: '/category/notes/child/',
        articleCount: 2,
        children: [],
      },
    ],
  },
  {
    path: 'empty',
    name: '空分類',
    description: '尚無公開文章。',
    url: '/category/empty/',
    articleCount: 0,
    children: [],
  },
];

describe('neutral taxonomy overview', () => {
  it('renders the complete category hierarchy, description and counts in supplied order', () => {
    const html = renderToStaticMarkup(
      <TaxonomyOverviewPage
        kind="category"
        description="頁型設定說明"
        categories={categories}
        tags={[]}
      />,
    );
    const fragment = parseFragment(html);
    expect(elements(fragment, 'main')).toHaveLength(1);
    expect(elements(fragment, 'h1')).toHaveLength(1);
    const links = elements(fragment, 'a').map(
      (item) => item.attrs.find(({ name }) => name === 'href')?.value,
    );
    expect(links).toEqual([
      '/',
      '/tag/',
      '/category/notes/',
      '/category/notes/child/',
      '/category/empty/',
    ]);
    expect(html).toContain('筆記 &lt;&amp;&gt;');
    expect(html).toContain('父分類的完整說明。');
    expect(html).toContain('子分類說明。');
    expect(html).toContain('4 篇');
    expect(html).toContain('0 篇');
    expect(html).toContain('頁型設定說明');
    expect(html).not.toContain('cl-');
  });

  it('renders Tag descriptions/counts and an explicit empty state for either directory', () => {
    const html = renderToStaticMarkup(
      <TaxonomyOverviewPage
        kind="tag"
        description="Tag 頁型說明"
        categories={categories}
        tags={[
          {
            slug: 'example',
            name: '範例 <&>',
            description: '完整 Tag 說明。',
            url: '/tag/example/',
            articleCount: 0,
          },
        ]}
      />,
    );
    expect(html).toContain('範例 &lt;&amp;&gt;');
    expect(html).toContain('完整 Tag 說明。');
    expect(html).toContain('0 篇');
    expect(html).toContain('href="/category/"');
    for (const kind of ['category', 'tag'] as const) {
      expect(
        renderToStaticMarkup(
          <TaxonomyOverviewPage
            kind={kind}
            description=""
            categories={[]}
            tags={[]}
          />,
        ),
      ).toContain(
        kind === 'category' ? '目前還沒有分類。' : '目前還沒有 Tag。',
      );
    }
  });
});
