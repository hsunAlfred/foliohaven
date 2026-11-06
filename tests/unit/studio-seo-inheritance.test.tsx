import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import {
  SEO_PAGE_TYPES,
  SeoOverrideSchema,
  SiteConfigSchema,
} from '@foliohaven/core';
import { StudioApi } from '../../studio/src/api.js';
import { SeoFields } from '../../studio/src/components.js';
import { SeoSettingsPanel } from '../../studio/src/SeoSettingsPanel.js';
import {
  getSeoFieldDefaults,
  seoSourceLabel,
} from '../../studio/src/seo-defaults.js';
import {
  siteSettingsFieldLabel,
  siteSettingsIssues,
} from '../../studio/src/site-settings-validation.js';

const image = '/media/b9b5681a-36f0-49bf-a715-7604db77a32f/image.webp';
function site(overrides: Record<string, unknown> = {}) {
  return SiteConfigSchema.parse({
    siteName: '設定測試網站',
    siteDescription: '基本網站描述',
    siteUrl: 'https://example.invalid/',
    author: { name: '測試作者' },
    defaultSEO: {
      titleTemplate: '{title} | {siteName}',
      description: '全域 SEO 描述',
      index: true,
    },
    social: { defaultImage: image },
    ...overrides,
  });
}
function elements(
  node: DefaultTreeAdapterMap['node'],
  predicate: (element: DefaultTreeAdapterMap['element']) => boolean,
): DefaultTreeAdapterMap['element'][] {
  return [
    ...('tagName' in node && predicate(node) ? [node] : []),
    ...('childNodes' in node
      ? node.childNodes.flatMap((child) => elements(child, predicate))
      : []),
  ];
}
function hasClass(node: DefaultTreeAdapterMap['element'], name: string) {
  return node.attrs.some(
    (a) => a.name === 'class' && a.value.split(/\s+/u).includes(name),
  );
}

describe('Studio SEO inheritance projection', () => {
  it('uses Core for partial single-record overrides without replacing unrelated inherited fields', () => {
    const settings = site({
      pageSEO: {
        article: {
          titleTemplate: '類型：{title}',
          descriptionSource: 'content',
          index: false,
          imageSource: 'featured',
        },
      },
    });
    const own = SeoOverrideSchema.parse({
      title: '完整覆寫標題',
      imageSource: 'none',
    });
    const result = getSeoFieldDefaults(settings, {
      kind: 'article',
      pageType: 'article',
      title: '文章標題',
      excerpt: '文章摘要來源',
      featuredImage: image,
      seo: own,
    });
    expect(result).toMatchObject({
      title: '完整覆寫標題',
      description: '文章摘要來源',
      index: false,
      ogImage: null,
      sources: {
        title: 'override',
        description: 'content',
        index: 'pageType',
        image: 'none',
      },
    });
    expect(own.description).toBeNull();
    expect(own.index).toBeNull();
  });

  it('does not inject a taxonomy description when that type explicitly inherits the global value', () => {
    const inherited = site({
      pageSEO: { category: { descriptionSource: 'inherit' } },
    });
    const content = site({
      pageSEO: { category: { descriptionSource: 'content' } },
    });
    const input = {
      kind: 'website',
      pageType: 'category',
      title: 'Rust',
      description: '分類描述來源',
    } as const;
    expect(getSeoFieldDefaults(inherited, input)).toMatchObject({
      description: '全域 SEO 描述',
      sources: { description: 'global' },
    });
    expect(getSeoFieldDefaults(content, input)).toMatchObject({
      description: '分類描述來源',
      sources: { description: 'content' },
    });
  });

  it('falls back from an empty article excerpt and missing cover while leaving inherited settings unchanged', () => {
    const settings = site();
    const before = JSON.stringify(settings);
    expect(
      getSeoFieldDefaults(settings, {
        kind: 'article',
        pageType: 'article',
        title: '文章',
        excerpt: '',
        featuredImage: null,
      }),
    ).toMatchObject({
      description: '全域 SEO 描述',
      ogImage: image,
      sources: { description: 'global', image: 'global' },
    });
    expect(JSON.stringify(settings)).toBe(before);
    expect(settings.pageSEO.article.titleTemplate).toBeNull();
  });

  it('offers the website description as a concrete homepage content source', () => {
    const settings = site({
      pageSEO: { home: { descriptionSource: 'content' } },
    });
    const result = getSeoFieldDefaults(settings, {
      kind: 'website',
      pageType: 'home',
      title: '首頁',
    });
    expect(result).toMatchObject({
      description: '基本網站描述',
      sources: { description: 'content' },
    });
    expect(seoSourceLabel('content', 'description', 'home')).toBe(
      '首頁預設 · 網站描述',
    );
  });

  it('renders an explicit no-image choice without showing the inherited image as selected', () => {
    const settings = site();
    const input = {
      kind: 'article',
      pageType: 'article',
      title: '文章',
      excerpt: '摘要',
      featuredImage: image,
    } as const;
    const own = SeoOverrideSchema.parse({
      title: '覆寫標題',
      imageSource: 'none',
      index: false,
    });
    const fetcher = vi.fn<typeof fetch>();
    const html = renderToStaticMarkup(
      <SeoFields
        api={new StudioApi(fetcher)}
        value={own}
        defaults={getSeoFieldDefaults(settings, input)}
        resolved={getSeoFieldDefaults(settings, { ...input, seo: own })}
        onChange={() => undefined}
      />,
    );
    const imageControl = elements(parse(html), (element) =>
      hasClass(element, 'image-select'),
    )[0];
    expect(imageControl).toBeDefined();
    if (!imageControl) throw new Error('Missing image selection control');
    expect(serialize(imageControl)).not.toContain(image);
    expect(html).toContain('不使用分享圖片');
    expect(html).toContain('單筆覆寫');
    expect(html).toContain('單筆覆寫 · 不使用圖片');
    expect(html).toContain('覆寫標題');
    expect(html).toContain('不允許索引');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps page-type validation paths and labels specific enough to reveal the correct settings panel', () => {
    expect(siteSettingsFieldLabel(['pageSEO', 'article', 'ogImage'])).toBe(
      '文章頁 · 類型分享圖片',
    );
    expect(
      siteSettingsFieldLabel(['pageSEO', 'categoryIndex', 'description']),
    ).toBe('分類總覽 · 類型 Meta Description');
    const issues = siteSettingsIssues({
      issues: [
        {
          path: ['pageSEO', 'article', 'titleTemplate'],
          message: '標題模板僅接受 {title} 與 {siteName} placeholder',
        },
      ],
    });
    expect(issues[0]?.path).toEqual(['pageSEO', 'article', 'titleTemplate']);
    expect(issues[0]?.message).toContain('繼承全域 Title Template');
  });
});

describe('Studio page-type SEO tabs', () => {
  it('links eight tabs to their own panels with one selected tab and only its settings exposed', () => {
    const fetcher = vi.fn<typeof fetch>();
    const html = renderToStaticMarkup(
      <SeoSettingsPanel
        api={new StudioApi(fetcher)}
        value={site()}
        pageType="article"
        onChange={() => undefined}
        onPageTypeChange={() => undefined}
        disabled={false}
      />,
    );
    const document = parse(html);
    const attribute = (
      element: DefaultTreeAdapterMap['element'],
      name: string,
    ) => element.attrs.find((item) => item.name === name)?.value;
    const tablist = elements(
      document,
      (element) => attribute(element, 'role') === 'tablist',
    );
    expect(tablist).toHaveLength(1);
    const typeTabs = tablist[0];
    if (!typeTabs) throw new Error('Missing page-type tablist');
    expect(attribute(typeTabs, 'aria-label')).toBe('頁面類型');
    const tabs = elements(
      document,
      (element) => attribute(element, 'role') === 'tab',
    );
    const panels = elements(
      document,
      (element) => attribute(element, 'role') === 'tabpanel',
    );
    expect(tabs).toHaveLength(8);
    expect(panels).toHaveLength(8);
    expect(tabs.map((tab) => attribute(tab, 'data-page-type'))).toEqual(
      SEO_PAGE_TYPES,
    );
    for (const tab of tabs) {
      const selected = attribute(tab, 'data-page-type') === 'article';
      expect(attribute(tab, 'aria-selected')).toBe(String(selected));
      expect(attribute(tab, 'tabindex')).toBe(selected ? '0' : '-1');
      const panel = panels.find(
        (item) => attribute(item, 'id') === attribute(tab, 'aria-controls'),
      );
      expect(panel).toBeDefined();
      if (!panel) throw new Error('Missing controlled page-type panel');
      expect(attribute(panel, 'aria-labelledby')).toBe(attribute(tab, 'id'));
      expect(panel.attrs.some((item) => item.name === 'hidden')).toBe(
        !selected,
      );
    }
    const active = panels.find(
      (panel) => !panel.attrs.some((item) => item.name === 'hidden'),
    );
    expect(active).toBeDefined();
    if (!active) throw new Error('Missing active page-type panel');
    expect(serialize(active)).toContain('pageSEO.article.descriptionSource');
    expect(serialize(active)).not.toContain('pageSEO.home.descriptionSource');
    expect(
      elements(
        document,
        (element) =>
          element.tagName === 'select' &&
          attribute(element, 'data-field') === 'pageSEO',
      ),
    ).toHaveLength(0);
    expect(html).toContain('清除此類型自訂內容');
    expect(html).not.toContain('此類型全部繼承全域');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
