import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { ArticlePage } from '@foliohaven/ui';
import { uiModels } from '../fixtures/ui-models.js';

type Node = DefaultTreeAdapterMap['node'];
function elements(node: Node, tag: string): DefaultTreeAdapterMap['element'][] {
  return [
    ...('tagName' in node && node.tagName === tag ? [node] : []),
    ...('childNodes' in node
      ? node.childNodes.flatMap((child) => elements(child, tag))
      : []),
  ];
}
function attr(node: DefaultTreeAdapterMap['element'], name: string) {
  return node.attrs.find((item) => item.name === name)?.value;
}
function text(node: Node): string {
  return 'value' in node
    ? node.value
    : 'childNodes' in node
      ? node.childNodes.map(text).join('')
      : '';
}

describe('neutral article summary and related reading', () => {
  it('renders the chosen order, custom heading, summary and complete card metadata', () => {
    const model = uiModels().model;
    const article = model.articlePages[0];
    const cards = [...model.home.latest]
      .reverse()
      .slice(0, 2)
      .map((item, index) => ({
        ...item,
        description: `延伸摘要 ${index} <&>`,
      }));
    if (!article || cards.length !== 2)
      throw new Error('Missing related fixture');
    const html = renderToStaticMarkup(
      <ArticlePage
        article={{
          ...article,
          description: '文章獨立摘要 <&>',
          relatedReading: { title: '接著閱讀 <&>', articles: cards },
        }}
      />,
    );
    const fragment = parseFragment(html);
    const section = elements(fragment, 'section').find(
      (item) => attr(item, 'data-related-reading') !== undefined,
    );
    if (!section) throw new Error('Missing related section');
    expect(text(section)).toContain('接著閱讀 <&>');
    const titles = elements(section, 'h3');
    expect(titles.map(text)).toEqual(cards.map((item) => item.title));
    expect(
      titles
        .map((title) => elements(title, 'a')[0])
        .map((link) => link && attr(link, 'href')),
    ).toEqual(cards.map((item) => item.url));
    for (const card of cards) {
      expect(text(section)).toContain(card.description);
      expect(text(section)).toContain(card.category.name);
    }
    expect(elements(section, 'time')).toHaveLength(cards.length);
    expect(html).toContain('文章獨立摘要 &lt;&amp;&gt;');
    expect(html).not.toContain('data-cl-');
    expect(elements(fragment, 'main')).toHaveLength(1);
    expect(elements(fragment, 'h1')).toHaveLength(1);
  });

  it('omits the related section for empty selections and supports draft preview with the same layout', () => {
    const { preview } = uiModels();
    const html = renderToStaticMarkup(
      <ArticlePage
        article={{
          ...preview,
          relatedReading: { title: 'EMPTY_RELATED_SENTINEL', articles: [] },
        }}
      />,
    );
    expect(html).not.toContain('EMPTY_RELATED_SENTINEL');
    expect(html).not.toContain('data-related-reading');
    expect(html).toContain('草稿預覽');
    expect(html).toContain('未命名草稿正文');
  });
});
