import type {
  BreadcrumbItem,
  DeepReadonly,
  JsonObject,
  SeoOverride,
  SeoViewModel,
  SiteConfig,
  SeoPageType,
  SeoSource,
  SeoSourceLayer,
  ArticleMeta,
} from '../models/index.js';
import {
  RootPathSchema,
  SiteUrlSchema,
  toUtcDateTime,
} from '../schemas/common.js';

export interface ResolveSeoInput {
  readonly site: SiteConfig;
  readonly title: string;
  readonly description?: string;
  readonly contentDescription?: string;
  readonly pageType?: SeoPageType;
  readonly path: string | null;
  readonly seo?: DeepReadonly<SeoOverride>;
  readonly kind?: 'website' | 'article';
  readonly featuredImage?: string | null;
  readonly page?: number;
  readonly forceNoindex?: boolean;
  readonly breadcrumb?: readonly BreadcrumbItem[];
  readonly article?: {
    readonly title: string;
    readonly publishedAt: string | null;
    readonly updatedAt: string | null;
  };
}
/** Known public page kinds; custom fixed pages continue to use the global defaults. */
export function seoPageTypeForPath(
  path: string | null,
): SeoPageType | undefined {
  if (path === null || path === '/404.html') return 'notFound';
  if (path === '/') return 'home';
  if (path === '/articles/') return 'articles';
  if (path === '/category/') return 'categoryIndex';
  if (path === '/tag/') return 'tagIndex';
  if (path.startsWith('/category/')) return 'category';
  if (path.startsWith('/tag/')) return 'tag';
  return undefined;
}
export const SEO_PAGE_TITLES: Readonly<Record<SeoPageType, string>> =
  Object.freeze({
    home: '首頁',
    article: '文章',
    articles: '文章總覽',
    categoryIndex: '分類總覽',
    category: '分類',
    tagIndex: 'Tag 總覽',
    tag: 'Tag',
    notFound: '找不到頁面',
  });
export function absoluteSiteUrl(site: SiteConfig, path: string): string {
  SiteUrlSchema.parse(site.siteUrl);
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\'))
    throw new TypeError('網址必須由站內根路徑建立。');
  return new URL(path, site.siteUrl).href;
}
export function serializeJsonLd(
  value: JsonObject | readonly JsonObject[],
): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}
function freezeJson(value: JsonObject | readonly unknown[]): void {
  for (const child of Object.values(value))
    if (typeof child === 'object' && child !== null)
      freezeJson(child as JsonObject | readonly unknown[]);
  Object.freeze(value);
}
export function resolveSeo(input: ResolveSeoInput): SeoViewModel {
  const { site } = input;
  if (input.path !== null) RootPathSchema.parse(input.path);
  const pageType =
    input.pageType ?? (input.kind === 'article' ? 'article' : undefined);
  const defaults = pageType === undefined ? undefined : site.pageSEO[pageType];
  const template = defaults?.titleTemplate ?? site.defaultSEO.titleTemplate;
  let title =
    input.seo?.title ??
    template
      .replaceAll('{title}', input.title)
      .replaceAll('{siteName}', site.siteName);
  if ((input.page ?? 1) > 1) title += `（第 ${input.page} 頁）`;
  const titleSource: SeoSource =
    input.seo?.title != null
      ? 'override'
      : defaults?.titleTemplate != null
        ? 'pageType'
        : 'global';
  let description = site.defaultSEO.description;
  let descriptionSource: SeoSource = 'global';
  const suppliedContentDescription =
    input.contentDescription ?? input.description;
  const contentDescription =
    pageType === 'home' && !suppliedContentDescription?.trim()
      ? site.siteDescription
      : (suppliedContentDescription ?? '');
  if (
    defaults?.descriptionSource === 'custom' &&
    defaults.description !== null
  ) {
    description = defaults.description;
    descriptionSource = 'pageType';
  } else if (
    (defaults?.descriptionSource === 'content' || defaults === undefined) &&
    contentDescription.trim() !== ''
  ) {
    description = contentDescription.trim();
    descriptionSource = 'content';
  }
  if (input.seo?.description != null) {
    description = input.seo.description;
    descriptionSource = 'override';
  }
  const forceNoindex =
    Boolean(input.forceNoindex) ||
    input.path === null ||
    pageType === 'notFound';
  const index =
    !forceNoindex &&
    (input.seo?.index ?? defaults?.index ?? site.defaultSEO.index);
  const indexSource: SeoSource = forceNoindex
    ? 'forced'
    : input.seo?.index != null
      ? 'override'
      : defaults?.index != null
        ? 'pageType'
        : 'global';
  const canonical =
    input.path === null ? null : absoluteSiteUrl(site, input.path);
  let imagePath = site.social.defaultImage;
  let imageSource: SeoSource = 'global';
  let imageLayer: SeoSourceLayer = 'global';
  if (defaults?.imageSource === 'none') {
    imagePath = null;
    imageSource = 'none';
    imageLayer = 'pageType';
  } else if (defaults?.imageSource === 'custom' && defaults.ogImage !== null) {
    imagePath = defaults.ogImage;
    imageSource = 'pageType';
    imageLayer = 'pageType';
  } else if (
    defaults?.imageSource === 'featured' &&
    input.featuredImage != null
  ) {
    imagePath = input.featuredImage;
    imageSource = 'content';
    imageLayer = 'pageType';
  }
  const overrideImageMode =
    input.seo?.imageSource ??
    (input.seo?.ogImage != null ? 'custom' : 'inherit');
  if (overrideImageMode === 'none') {
    imagePath = null;
    imageSource = 'none';
    imageLayer = 'override';
  } else if (overrideImageMode === 'custom' && input.seo?.ogImage != null) {
    imagePath = input.seo.ogImage;
    imageSource = 'override';
    imageLayer = 'override';
  }
  const image = imagePath === null ? null : absoluteSiteUrl(site, imagePath);
  const jsonLd: JsonObject[] = [];
  if (
    input.article !== undefined &&
    canonical !== null &&
    input.article.publishedAt !== null &&
    input.article.updatedAt !== null
  ) {
    jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: input.article.title,
      description: input.contentDescription?.trim() || description,
      ...(image === null ? {} : { image }),
      author: {
        '@type': 'Person',
        name: site.author.name,
        ...(site.author.url === null ? {} : { url: site.author.url }),
      },
      datePublished: toUtcDateTime(input.article.publishedAt),
      dateModified: toUtcDateTime(input.article.updatedAt),
      mainEntityOfPage: canonical,
    });
  }
  const breadcrumb =
    input.breadcrumb?.filter((item) => item.url !== null) ?? [];
  if (breadcrumb.length > 1)
    jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumb.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: absoluteSiteUrl(site, item.url ?? '/'),
      })),
    });
  freezeJson(jsonLd);
  const locale = new Intl.Locale(site.language).maximize();
  return Object.freeze({
    title,
    description,
    sources: Object.freeze({
      title: titleSource,
      description: descriptionSource,
      index: indexSource,
      image: imageSource,
    }),
    sourceLayers: Object.freeze({
      title: titleSource,
      description:
        descriptionSource === 'content' ? 'pageType' : descriptionSource,
      index: indexSource,
      image: imageLayer,
    }),
    canonical,
    index,
    robots: index ? 'index,follow' : 'noindex,follow',
    openGraph: Object.freeze({
      type: input.kind ?? 'website',
      title,
      description,
      url: canonical,
      siteName: site.siteName,
      locale: `${locale.language}_${locale.region ?? ''}`.replace(/_$/, ''),
      image,
    }),
    twitter: Object.freeze({
      card: image === null ? 'summary' : 'summary_large_image',
      title,
      description,
      image,
      site: site.social.twitterSite,
    }),
    jsonLd: Object.freeze(jsonLd),
    googleSiteVerification:
      input.path === '/' ? site.googleSiteVerification : null,
    rssUrl: absoluteSiteUrl(site, '/rss.xml'),
  });
}
export function notFoundSeo(site: SiteConfig): SeoViewModel {
  return resolveSeo({
    site,
    title: '找不到頁面',
    pageType: 'notFound',
    path: null,
    forceNoindex: true,
  });
}

/** Display content uses its own excerpt before the resolved SEO description. */
export function resolveArticleDescription(
  meta: DeepReadonly<ArticleMeta>,
  site?: SiteConfig | null,
): string {
  const excerpt = meta.excerpt?.trim() ?? '';
  if (excerpt !== '') return excerpt;
  if (meta.seo.description !== null) return meta.seo.description;
  if (!site) return meta.seo.description ?? '';
  return resolveSeo({
    site,
    pageType: 'article',
    kind: 'article',
    title: meta.title || '未命名草稿',
    contentDescription: excerpt,
    seo: meta.seo,
    featuredImage: meta.featuredImage,
    path: null,
  }).description;
}
