import { resolveSeo } from '@foliohaven/core';
import type {
  SeoOverride,
  SeoPageType,
  SeoSource,
  SeoSourceLayer,
  SiteConfig,
} from '@foliohaven/core';

export const seoPageTypeLabels: Readonly<Record<SeoPageType, string>> = {
  home: '首頁',
  article: '文章頁',
  articles: '文章總覽／搜尋',
  categoryIndex: '分類總覽',
  category: '分類頁',
  tagIndex: 'Tag 總覽',
  tag: 'Tag 頁',
  notFound: '404',
};

export type SeoResultField = 'title' | 'description' | 'index' | 'image';

export interface SeoFieldDefaults {
  readonly title: string;
  readonly description: string;
  readonly index: boolean;
  readonly ogImage: string | null;
  readonly ogImageSource:
    'Featured Image' | 'Site Default' | 'Page Type' | 'None';
  readonly pageType: SeoPageType | null;
  readonly sources: Readonly<Record<SeoResultField, SeoSource>>;
  readonly sourceLayers: Readonly<Record<SeoResultField, SeoSourceLayer>>;
}

export function seoSourceLabel(
  source: SeoSource,
  field: SeoResultField,
  pageType: SeoPageType | null,
  layer?: SeoSourceLayer,
): string {
  switch (source) {
    case 'override':
      return '單筆覆寫';
    case 'pageType':
      return `${pageType ? seoPageTypeLabels[pageType] : '頁面類型'}預設`;
    case 'content': {
      const name =
        field === 'image'
          ? '文章精選圖片'
          : pageType === 'home'
            ? '網站描述'
            : pageType === 'category'
              ? '分類描述'
              : pageType === 'tag'
                ? 'Tag 描述'
                : '文章摘要';
      return `${pageType ? seoPageTypeLabels[pageType] : '頁面類型'}預設 · ${name}`;
    }
    case 'none':
      return `${layer === 'override' ? '單筆覆寫' : layer === 'pageType' ? `${pageType ? seoPageTypeLabels[pageType] : '頁面類型'}預設` : '明確設定'} · 不使用圖片`;
    case 'forced':
      return '固定不收錄規則';
    case 'global':
      return '全域預設';
  }
}

/** Read the same inherited values used by the public renderer; never persist them as overrides. */
export function getSeoFieldDefaults(
  site: SiteConfig | null,
  input: {
    readonly kind: 'article' | 'website';
    readonly pageType?: SeoPageType;
    readonly title: string;
    readonly description?: string;
    readonly excerpt?: string;
    readonly featuredImage?: string | null;
    readonly seo?: SeoOverride;
  },
): SeoFieldDefaults | null {
  if (!site) return null;
  const pageType =
    input.pageType ?? (input.kind === 'article' ? 'article' : null);
  const contentDescription = input.excerpt ?? input.description;
  const resolved = resolveSeo({
    site,
    title: input.title,
    kind: input.kind,
    path: pageType === 'notFound' ? null : '/',
    ...(pageType === null ? {} : { pageType }),
    ...(input.seo === undefined ? {} : { seo: input.seo }),
    ...(contentDescription === undefined ? {} : { contentDescription }),
    ...(input.featuredImage === undefined
      ? {}
      : { featuredImage: input.featuredImage }),
  });
  const image = resolved.openGraph.image;
  return {
    title: resolved.title,
    description: resolved.description,
    index: resolved.index,
    ogImage: image === null ? null : new URL(image).pathname,
    ogImageSource:
      resolved.sources.image === 'content'
        ? 'Featured Image'
        : resolved.sources.image === 'pageType'
          ? 'Page Type'
          : resolved.sources.image === 'none'
            ? 'None'
            : 'Site Default',
    pageType,
    sources: resolved.sources,
    sourceLayers: resolved.sourceLayers,
  };
}
