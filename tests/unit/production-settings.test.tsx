import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomePage, SiteHeader, SiteFooter } from '@foliohaven/ui';
import { uiModels } from '../fixtures/ui-models.js';

describe('neutral website settings', () => {
  it('renders configured site name, description and navigation without author branding', () => {
    const site = {
      ...uiModels().model.home.site,
      siteName: '測試 <script> & 網站',
      siteDescription: 'SETTING_DESCRIPTION_SENTINEL <&>',
      author: { name: '網站作者', url: null },
      navigation: [
        { label: '參考資料', href: 'https://reference.example.invalid/' },
      ],
    };
    const html = renderToStaticMarkup(
      <>
        <SiteHeader site={site} />
        <SiteFooter site={site} />
      </>,
    );
    expect(html).toContain('測試 &lt;script&gt; &amp; 網站');
    expect(html).toContain('SETTING_DESCRIPTION_SENTINEL &lt;&amp;&gt;');
    expect(html).toContain('網站作者');
    expect(html).toContain('href="https://reference.example.invalid/"');
    expect(html).not.toContain('<script>');
  });

  it('uses the configured featured caption and allows an empty caption', () => {
    const model = uiModels().model.home;
    const custom = renderToStaticMarkup(
      <HomePage model={{ ...model, featuredCaption: '設定的精選 <&>' }} />,
    );
    expect(custom).toContain('設定的精選 &lt;&amp;&gt;');
    const empty = renderToStaticMarkup(
      <HomePage model={{ ...model, featuredCaption: '' }} />,
    );
    expect(empty).not.toContain('featured-caption');
    expect(empty).toContain('精選文章');
    const standard = renderToStaticMarkup(
      <HomePage model={{ ...model, featuredCaption: '精選文章' }} />,
    );
    expect(standard.match(/精選文章/gu)).toHaveLength(1);
  });

  it('keeps featured and latest card summaries from the Core model', () => {
    const model = uiModels().model.home;
    const article = model.latest[0];
    if (!article) throw new Error('Missing article fixture');
    const html = renderToStaticMarkup(
      <HomePage
        model={{
          ...model,
          featured: [],
          latest: [{ ...article, description: '獨立摘要 <&>' }],
        }}
      />,
    );
    expect(html).toContain('獨立摘要 &lt;&amp;&gt;');
    expect(html).not.toContain('RAW_HTML_SENTINEL');
  });
});
