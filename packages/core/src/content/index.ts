import type {
  Article,
  ArticleCardViewModel,
  BreadcrumbItem,
  Category,
  Diagnostic,
  FixedPage,
  HomeViewModel,
  ImageViewModel,
  ListPageViewModel,
  MediaManifest,
  PreviewArticleViewModel,
  PublicArticleViewModel,
  PublishedArticleMeta,
  RouteEntry,
  RouteManifest,
  SearchDocument,
  SiteConfig,
  SiteViewModel,
  SeoOverride,
  Tag,
  TocEntry,
} from '../models/index.js';
import { buildSiteIconSet, siteIconMediaRefs } from './site-icons.js';
export { buildSiteIconSet, siteIconMediaRefs } from './site-icons.js';
import {
  ArticleMetaSchema,
  CategoriesSchema,
  FixedPageSchema,
  PublishedArticleMetaSchema,
  SiteConfigSchema,
  TagsSchema,
} from '../schemas/content.js';
import {
  ArticleIdSchema,
  CONTENT_LIMITS,
  DateTimeSchema,
  HtmlContentSchema,
  ManagedMediaPathSchema,
  mediaImageGroup,
  SlugSchema,
  toUtcDateTime,
  utf8ByteLength,
} from '../schemas/common.js';
import { MediaManifestSchema } from '../schemas/media.js';
import { analyzeHtml, enhanceHtmlMedia } from '../html/index.js';
import type { HtmlProcessingCache } from '../html/index.js';
import {
  AUXILIARY_PATHS,
  articleUrl,
  categoryUrl,
  createRouteManifest,
  pageOutputPath,
  tagUrl,
  validateRouteManifest,
  siteRelativePath,
} from '../routing/index.js';
import {
  asciiCompare,
  paginate,
  paginationViewModel,
  sortArticles,
} from '../pagination/index.js';
import {
  buildCategoryTree,
  categoryArticles,
  categoryBreadcrumb,
  categoryView,
  tagArticles,
  tagView,
} from '../taxonomy/index.js';
import {
  absoluteSiteUrl,
  resolveSeo,
  resolveArticleDescription,
  seoPageTypeForPath,
  SEO_PAGE_TITLES,
} from '../seo/index.js';

export interface PublishedArticle extends Article {
  readonly meta: PublishedArticleMeta;
}
export interface SiteModelInput {
  readonly site: SiteConfig;
  readonly categories: readonly Category[];
  readonly tags: readonly Tag[];
  readonly articles: readonly Article[];
  readonly fixedPages: readonly FixedPage[];
  readonly mediaManifest?: MediaManifest;
  readonly now?: string;
  readonly htmlCache?: HtmlProcessingCache;
}
export interface PendingLinkCheck {
  readonly articleId: string;
  readonly href: string;
  readonly targetPath: string;
  readonly fragment: string;
  readonly line?: number;
  readonly column?: number;
}
export interface SiteModel {
  readonly site: SiteConfig;
  readonly articles: readonly PublishedArticle[];
  readonly articlePages: readonly PublicArticleViewModel[];
  readonly listPages: readonly ListPageViewModel[];
  readonly home: HomeViewModel;
  readonly searchIndex: {
    readonly version: 1;
    readonly articles: readonly SearchDocument[];
  };
  readonly routeManifest: RouteManifest;
  readonly diagnostics: readonly Diagnostic[];
  readonly mediaRefs: readonly string[];
  readonly mediaPending: boolean;
  readonly pendingLinkChecks: readonly PendingLinkCheck[];
}
export class ContentValidationError extends Error {
  readonly code = 'CONTENT_VALIDATION_FAILED';
  readonly diagnostics: readonly Diagnostic[];
  constructor(diagnostics: readonly Diagnostic[]) {
    super('內容未符合公開建置規則，請依診斷修正。');
    this.name = 'ContentValidationError';
    this.diagnostics = diagnostics;
  }
}
function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'object' && value !== null && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
function schemaDiagnostics(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[],
  resource: string,
  articleId?: string,
): Diagnostic[] {
  return issues.map((issue) => ({
    severity: 'error',
    code: 'SCHEMA_VALIDATION_FAILED',
    message: issue.message,
    resource,
    ...(articleId === undefined ? {} : { articleId }),
    ...(issue.path.length === 0
      ? {}
      : { field: issue.path.map(String).join('.') }),
  }));
}
function siteView(site: SiteConfig): SiteViewModel {
  return {
    siteName: site.siteName,
    siteDescription: site.siteDescription,
    favicon: site.favicon,
    iconSet: buildSiteIconSet(site),
    siteUrl: site.siteUrl,
    language: site.language,
    timeZone: site.timeZone,
    author: { ...site.author },
    navigation: site.navigation.map((item) => ({ ...item })),
    rssUrl: absoluteSiteUrl(site, '/rss.xml'),
  };
}
function appendArticleDiagnostic(
  diagnostics: Diagnostic[],
  articleId: string,
  code: string,
  message: string,
  field?: string,
  severity: 'error' | 'warning' = 'error',
): void {
  diagnostics.push({
    severity,
    code,
    message,
    articleId,
    resource: `content/articles/${articleId}/meta.json`,
    ...(field === undefined ? {} : { field }),
  });
}
function imageView(
  path: string | null,
  alt: string,
  manifest: MediaManifest | undefined,
): ImageViewModel | null {
  if (path === null || manifest === undefined) return null;
  const asset = manifest.assets.find((item) =>
    item.outputs.some((output) => output.publicPath === path),
  );
  const output = asset?.outputs.find(
    (item) => item.publicPath === path && item.mimeType.startsWith('image/'),
  );
  if (output === undefined) return null;
  const variants =
    asset?.outputs
      .filter(
        (item) =>
          item.mimeType.startsWith('image/') &&
          (mediaImageGroup(path) === 'responsive'
            ? mediaImageGroup(item.publicPath) === 'responsive'
            : item.publicPath === path),
      )
      .sort((left, right) => left.width - right.width) ?? [];
  return {
    src: path,
    alt,
    width: output.width,
    height: output.height,
    srcset:
      variants.length > 1
        ? variants.map((item) => `${item.publicPath} ${item.width}w`).join(', ')
        : null,
    sizes: variants.length > 1 ? '(max-width: 768px) 100vw, 1280px' : null,
  };
}
function shareImageReference(seo: SeoOverride): string | null {
  const mode = seo.imageSource ?? (seo.ogImage !== null ? 'custom' : 'inherit');
  return mode === 'custom' ? seo.ogImage : null;
}
function articleMedia(meta: Article['meta']): string[] {
  return [meta.featuredImage, shareImageReference(meta.seo)].filter(
    (path): path is string => path !== null,
  );
}
function verifyMediaPaths(
  refs: readonly string[],
  manifest: MediaManifest | undefined,
  diagnostics: Diagnostic[],
  articleId?: string,
): void {
  if (manifest === undefined) return;
  const outputs = new Set(
    manifest.assets.flatMap((asset) =>
      asset.outputs.map((output) => output.publicPath),
    ),
  );
  for (const ref of new Set(refs))
    if (!outputs.has(ref))
      diagnostics.push({
        severity: 'error',
        code: 'MEDIA_NOT_FOUND',
        message: `受管媒體尚未完成或不存在：${ref}`,
        ...(articleId === undefined ? {} : { articleId }),
      });
}
function resolveMediaClosure(
  refs: readonly string[],
  manifest: MediaManifest | undefined,
): readonly string[] {
  const result = new Set(refs);
  if (manifest !== undefined)
    for (const asset of manifest.assets)
      if (asset.outputs.some((output) => result.has(output.publicPath))) {
        for (const output of asset.outputs) {
          // Keep the article asset closure, while optional icon outputs require
          // their own reference so a disabled platform does not ship its files.
          const optionalIcon =
            asset.presetVersion === 'site-icons-v1' &&
            (output.publicPath.endsWith('/favicon.ico') ||
              (mediaImageGroup(output.publicPath) === 'favicon' &&
                !output.publicPath.endsWith('/favicon.png')));
          if (!optionalIcon || result.has(output.publicPath))
            result.add(output.publicPath);
        }
      }
  return [...result].sort(asciiCompare);
}
export interface SiteLinkSource {
  readonly articleId: string;
  readonly path: string;
  readonly ids: readonly string[];
  readonly links: readonly {
    readonly href: string;
    readonly line?: number;
    readonly column?: number;
  }[];
}
export function validateSiteLinks(
  sources: readonly SiteLinkSource[],
  manifest: RouteManifest,
  options: {
    readonly siteUrl?: string;
    readonly pageIds?: Readonly<Record<string, readonly string[]>>;
    readonly allowPending?: boolean;
  } = {},
) {
  const diagnostics: Diagnostic[] = [];
  const pending: PendingLinkCheck[] = [];
  const known = new Set([
    ...manifest.routes.map((route) => route.path),
    ...manifest.assets,
  ]);
  const idsByPath = new Map(
    sources.map((source) => [source.path, new Set(source.ids)]),
  );
  if (options.pageIds !== undefined)
    for (const [path, ids] of Object.entries(options.pageIds))
      idsByPath.set(path, new Set(ids));
  for (const source of sources)
    for (const link of source.links) {
      const location = {
        ...(link.line === undefined ? {} : { line: link.line }),
        ...(link.column === undefined ? {} : { column: link.column }),
      };
      const error = (code: string, message: string) =>
        diagnostics.push({
          severity: 'error',
          code,
          message,
          articleId: source.articleId,
          resource: `content/articles/${source.articleId}/content.html`,
          ...location,
        });
      let target: URL;
      try {
        if (link.href.startsWith('#'))
          target = new URL(
            `${source.path}${link.href}`,
            options.siteUrl ?? 'https://example.invalid/',
          );
        else if (link.href.startsWith('/') && !link.href.startsWith('//')) {
          const rawPath = decodeURIComponent(link.href.split(/[?#]/u)[0] ?? '');
          if (
            rawPath.includes('\\') ||
            rawPath.split('/').some((part) => part === '.' || part === '..') ||
            /\p{Cc}/u.test(rawPath)
          ) {
            error('INVALID_INTERNAL_LINK', '站內 URL 不可包含穿越或控制字元。');
            continue;
          }
          target = new URL(
            link.href,
            options.siteUrl ?? 'https://example.invalid/',
          );
        } else if (/^https?:\/\//iu.test(link.href)) {
          target = new URL(link.href);
          if (
            options.siteUrl === undefined ||
            target.origin !== new URL(options.siteUrl).origin
          )
            continue;
        } else if (/^(mailto|tel):/iu.test(link.href)) continue;
        else {
          error(
            'INVALID_INTERNAL_LINK',
            '連結必須使用明確站內根路徑或允許的外部協定。',
          );
          continue;
        }
      } catch {
        error('INVALID_LINK_ENCODING', '連結使用無法解析的 URL。');
        continue;
      }
      let path: string;
      let fragment: string;
      try {
        path = decodeURI(target.pathname);
        fragment = decodeURIComponent(target.hash.slice(1));
      } catch {
        error('INVALID_LINK_ENCODING', '連結使用無法解析的 URL 編碼。');
        continue;
      }
      if (!known.has(path)) {
        error('BROKEN_INTERNAL_LINK', `站內連結不存在：${path}`);
        continue;
      }
      if (fragment === '') continue;
      const targetIds = idsByPath.get(path);
      if (targetIds === undefined) {
        if (options.allowPending)
          pending.push({
            articleId: source.articleId,
            href: link.href,
            targetPath: path,
            fragment,
            ...location,
          });
        else
          error(
            'UNKNOWN_FRAGMENT_TARGET',
            `無法取得目標頁面的 anchor：${path}#${fragment}`,
          );
      } else if (!targetIds.has(fragment))
        error('BROKEN_FRAGMENT', `目標頁面沒有 anchor：${path}#${fragment}`);
    }
  return freeze({ diagnostics, pending });
}

export function buildSiteModel(input: SiteModelInput): SiteModel {
  const analyze = input.htmlCache?.analyze.bind(input.htmlCache) ?? analyzeHtml;
  const enhance =
    input.htmlCache?.enhance.bind(input.htmlCache) ?? enhanceHtmlMedia;
  const diagnostics: Diagnostic[] = [];
  const siteResult = SiteConfigSchema.safeParse(input.site);
  const categoryResult = CategoriesSchema.safeParse(input.categories);
  const tagResult = TagsSchema.safeParse(input.tags);
  if (!siteResult.success)
    diagnostics.push(
      ...schemaDiagnostics(siteResult.error.issues, 'content/site.json'),
    );
  if (!categoryResult.success)
    diagnostics.push(
      ...schemaDiagnostics(
        categoryResult.error.issues,
        'content/categories.json',
      ),
    );
  if (!tagResult.success)
    diagnostics.push(
      ...schemaDiagnostics(tagResult.error.issues, 'content/tags.json'),
    );
  if (!siteResult.success || !categoryResult.success || !tagResult.success)
    throw new ContentValidationError(freeze(diagnostics));
  if (input.now !== undefined && !DateTimeSchema.safeParse(input.now).success)
    throw new ContentValidationError(
      freeze([
        {
          severity: 'error',
          code: 'INVALID_CLOCK_CONTEXT',
          message: '比較未來發布日期必須提供有效且明確時區的現在時間。',
          resource: 'build-context',
          field: 'now',
        },
      ]),
    );
  const nowInstant =
    input.now === undefined ? undefined : Date.parse(input.now);
  const site = siteResult.data;
  const categories = categoryResult.data;
  const tags = tagResult.data;
  const fixedPages: FixedPage[] = [];
  const fixedIds = new Set<string>();
  for (const raw of input.fixedPages) {
    const parsed = FixedPageSchema.safeParse(raw);
    if (!parsed.success) {
      diagnostics.push(
        ...schemaDiagnostics(parsed.error.issues, 'site/src/fixed-pages.ts'),
      );
      continue;
    }
    if (fixedIds.has(parsed.data.id))
      diagnostics.push({
        severity: 'error',
        code: 'DUPLICATE_FIXED_PAGE_ID',
        message: '固定頁面的 id 不可重複。',
        resource: 'site/src/fixed-pages.ts',
      });
    fixedIds.add(parsed.data.id);
    fixedPages.push(parsed.data);
    const root = parsed.data.path.split('/')[1];
    if (
      (root !== undefined &&
        ['category', 'tag', 'assets', 'media', '_astro'].includes(root) &&
        parsed.data.path !== '/category/' &&
        parsed.data.path !== '/tag/') ||
      (parsed.data.path.startsWith('/articles/') &&
        parsed.data.path !== '/articles/')
    )
      diagnostics.push({
        severity: 'error',
        code: 'RESERVED_FIXED_PAGE_ROUTE',
        message: `固定頁面占用系統路由：${parsed.data.path}`,
        resource: 'site/src/fixed-pages.ts',
      });
  }
  for (const path of ['/', '/articles/'])
    if (!fixedPages.some((page) => page.path === path))
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_FIXED_PAGE',
        message: `缺少必要固定頁登錄：${path}`,
        resource: 'site/src/fixed-pages.ts',
      });
  const mediaResult =
    input.mediaManifest === undefined
      ? undefined
      : MediaManifestSchema.safeParse(input.mediaManifest);
  if (mediaResult !== undefined && !mediaResult.success)
    throw new ContentValidationError(
      freeze(schemaDiagnostics(mediaResult.error.issues, 'media-manifest')),
    );
  const manifest = mediaResult?.data;
  const categoryMap = new Map(
    categories.map((category) => [category.path, category]),
  );
  const tagMap = new Map(tags.map((tag) => [tag.slug, tag]));
  const published: PublishedArticle[] = [];
  const articleDiagnostics = new Map<string, Diagnostic[]>();
  const analyses = new Map<string, ReturnType<typeof analyzeHtml>>();
  const contentById = new Map<string, string>();
  const seenIds = new Set<string>();
  let publishedBytes = 0;
  if (input.articles.length > CONTENT_LIMITS.articleCount)
    diagnostics.push({
      severity: 'error',
      code: 'ARTICLE_CAPACITY_EXCEEDED',
      message: '文章件數超過 10,000 件安全上限。',
    });
  for (const raw of input.articles) {
    if (!ArticleIdSchema.safeParse(raw.articleId).success) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_ARTICLE_ID',
        message: '文章目錄識別不合法。',
        resource: 'content/articles',
      });
      continue;
    }
    if (seenIds.has(raw.articleId))
      diagnostics.push({
        severity: 'error',
        code: 'DUPLICATE_ARTICLE_ID',
        message: `文章識別重複：${raw.articleId}`,
        articleId: raw.articleId,
      });
    seenIds.add(raw.articleId);
    const parsed = ArticleMetaSchema.safeParse(raw.meta);
    if (!parsed.success) {
      diagnostics.push(
        ...schemaDiagnostics(
          parsed.error.issues,
          `content/articles/${raw.articleId}/meta.json`,
          raw.articleId,
        ),
      );
      continue;
    }
    if (parsed.data.status === 'draft') continue;
    const localDiagnostics: Diagnostic[] = [];
    const article: PublishedArticle = {
      articleId: raw.articleId,
      meta: parsed.data,
      contentHtml: raw.contentHtml,
    };
    published.push(article);
    if (!categoryMap.has(article.meta.category))
      appendArticleDiagnostic(
        localDiagnostics,
        article.articleId,
        'UNKNOWN_CATEGORY',
        '文章分類不存在。',
        'category',
      );
    for (const slug of article.meta.tags)
      if (!tagMap.has(slug))
        appendArticleDiagnostic(
          localDiagnostics,
          article.articleId,
          'UNKNOWN_TAG',
          `文章使用不存在的 Tag：${slug}`,
          'tags',
        );
    if (
      nowInstant !== undefined &&
      Date.parse(article.meta.publishedAt) > nowInstant
    )
      appendArticleDiagnostic(
        localDiagnostics,
        article.articleId,
        'FUTURE_PUBLICATION_DATE',
        '發布日期在未來；status=published 仍會公開。',
        'publishedAt',
        'warning',
      );
    const htmlResult = HtmlContentSchema.safeParse(article.contentHtml);
    if (!htmlResult.success)
      localDiagnostics.push(
        ...schemaDiagnostics(
          htmlResult.error.issues,
          `content/articles/${article.articleId}/content.html`,
          article.articleId,
        ),
      );
    publishedBytes += utf8ByteLength(article.contentHtml);
    const analysis = analyze(article.contentHtml, {
      articleId: article.articleId,
      mode: 'published',
    });
    analyses.set(article.articleId, analysis);
    if (manifest === undefined) localDiagnostics.push(...analysis.diagnostics);
    let outputHtml = article.contentHtml;
    if (manifest !== undefined) {
      const enhanced = enhance(article.contentHtml, manifest, {
        articleId: article.articleId,
        mode: 'published',
      });
      outputHtml = enhanced.contentHtml;
      localDiagnostics.push(...enhanced.diagnostics);
    }
    contentById.set(article.articleId, outputHtml);
    verifyMediaPaths(
      articleMedia(article.meta),
      manifest,
      localDiagnostics,
      article.articleId,
    );
    articleDiagnostics.set(article.articleId, localDiagnostics);
  }
  if (publishedBytes > CONTENT_LIMITS.publishedHtmlBytes)
    diagnostics.push({
      severity: 'error',
      code: 'PUBLISHED_CONTENT_CAPACITY_EXCEEDED',
      message: '已發布正文總量超過 256 MiB 安全上限。',
    });
  const sorted = sortArticles(published);
  const view = siteView(site);
  const articlePages: PublicArticleViewModel[] = [];
  const cards = new Map<string, ArticleCardViewModel>();
  const routeEntries: RouteEntry[] = [];
  const fixedSeo = new Map(
    fixedPages.map((page) => {
      const pageType = seoPageTypeForPath(page.path);
      return [
        page.path,
        resolveSeo({
          site,
          title: pageType === undefined ? page.id : SEO_PAGE_TITLES[pageType],
          path: page.path,
          ...(pageType === undefined ? {} : { pageType }),
          seo: page.seo,
        }),
      ] as const;
    }),
  );
  for (const page of fixedPages)
    routeEntries.push({
      kind: 'fixed',
      path: page.path,
      outputPath: pageOutputPath(page.path),
      index: fixedSeo.get(page.path)?.index ?? false,
    });
  for (const article of sorted) {
    const category = categoryMap.get(article.meta.category);
    if (category === undefined) continue;
    const url = articleUrl(article.meta.category, article.meta.slug);
    const breadcrumb = categoryBreadcrumb(article.meta.category, categories, {
      title: article.meta.title,
      url,
    });
    const seo = resolveSeo({
      site,
      title: article.meta.title,
      contentDescription: article.meta.excerpt,
      pageType: 'article',
      path: url,
      seo: article.meta.seo,
      kind: 'article',
      featuredImage: article.meta.featuredImage,
      breadcrumb,
      article: article.meta,
    });
    const featuredImage = imageView(
      article.meta.featuredImage,
      article.meta.featuredImageAlt,
      manifest,
    );
    const articleTags = article.meta.tags.flatMap((slug) => {
      const tag = tagMap.get(slug);
      return tag === undefined ? [] : [tagView(tag)];
    });
    articlePages.push({
      context: 'public',
      articleId: article.articleId,
      site: view,
      meta: article.meta,
      contentHtml: contentById.get(article.articleId) ?? article.contentHtml,
      description: resolveArticleDescription(article.meta, site),
      category: categoryView(category),
      tags: articleTags,
      toc: analyses.get(article.articleId)?.toc ?? [],
      breadcrumb,
      seo,
      url,
      featuredImage,
      diagnostics: articleDiagnostics.get(article.articleId) ?? [],
      publishable: true,
      relatedReading: {
        title: article.meta.relatedReading.title,
        articles: [],
      },
    });
    cards.set(article.articleId, {
      articleId: article.articleId,
      title: article.meta.title,
      url,
      description: resolveArticleDescription(article.meta, site),
      publishedAt: toUtcDateTime(article.meta.publishedAt),
      updatedAt: toUtcDateTime(article.meta.updatedAt),
      category: categoryView(category),
      tags: articleTags,
      featuredImage,
    });
    routeEntries.push({
      kind: 'article',
      path: url,
      outputPath: pageOutputPath(url),
      index: seo.index,
      articleId: article.articleId,
    });
  }
  const listPages: ListPageViewModel[] = [];
  for (let index = 0; index < articlePages.length; index++) {
    const page = articlePages[index];
    if (page === undefined) continue;
    const related: ArticleCardViewModel[] = [];
    for (const id of page.meta.relatedReading.articleIds) {
      if (id === page.articleId) {
        appendArticleDiagnostic(
          diagnostics,
          page.articleId,
          'RELATED_READING_SELF_REFERENCE',
          '延伸閱讀不可選擇文章本身。',
          'relatedReading.articleIds',
        );
        continue;
      }
      const card = cards.get(id);
      if (card === undefined) {
        appendArticleDiagnostic(
          diagnostics,
          page.articleId,
          'INVALID_RELATED_ARTICLE',
          `延伸閱讀必須指向已發布文章：${id}`,
          'relatedReading.articleIds',
        );
        continue;
      }
      related.push(card);
    }
    articlePages[index] = {
      ...page,
      relatedReading: {
        title: page.meta.relatedReading.title,
        articles: related,
      },
    };
  }
  const addListPages = (
    kind: 'category' | 'tag',
    key: string,
    title: string,
    description: string,
    seoOverride: Category['seo'],
    selection: readonly PublishedArticle[],
    breadcrumb: readonly BreadcrumbItem[],
  ) => {
    const pageSize =
      kind === 'category' ? site.pagination.category : site.pagination.tag;
    const urlFor = (page: number) =>
      kind === 'category' ? categoryUrl(key, page) : tagUrl(key, page);
    const pages = Math.max(1, Math.ceil(selection.length / pageSize));
    for (let page = 1; page <= pages; page += 1) {
      const url = urlFor(page);
      const seo = resolveSeo({
        site,
        title,
        description,
        pageType: kind,
        contentDescription: description,
        path: url,
        seo: seoOverride,
        page,
        forceNoindex: selection.length === 0,
        breadcrumb,
      });
      const selected = paginate(selection, page, pageSize);
      listPages.push({
        site: view,
        kind,
        key,
        title,
        description,
        url,
        articles: selected.items.flatMap((article) => {
          const card = cards.get(article.articleId);
          return card === undefined ? [] : [card];
        }),
        pagination: paginationViewModel(
          selection.length,
          page,
          pageSize,
          urlFor,
        ),
        breadcrumb,
        seo,
      });
      routeEntries.push({
        kind,
        path: url,
        outputPath: pageOutputPath(url),
        index: seo.index,
        taxonomyKey: key,
        page,
      });
    }
  };
  for (const category of categories)
    addListPages(
      'category',
      category.path,
      category.name,
      category.description,
      category.seo,
      categoryArticles(category.path, sorted),
      categoryBreadcrumb(category.path, categories),
    );
  for (const tag of tags)
    addListPages(
      'tag',
      tag.slug,
      tag.name,
      tag.description,
      tag.seo,
      tagArticles(tag.slug, sorted),
      [
        { name: '首頁', url: '/' },
        { name: tag.name, url: tagUrl(tag.slug) },
      ],
    );
  const firstArticles = paginate(sorted, 1, site.pagination.articles);
  listPages.push({
    site: view,
    kind: 'articles',
    key: 'articles',
    title: '文章總覽',
    description: site.siteDescription,
    url: '/articles/',
    articles: firstArticles.items.flatMap((article) => {
      const card = cards.get(article.articleId);
      return card === undefined ? [] : [card];
    }),
    pagination: paginationViewModel(
      sorted.length,
      1,
      site.pagination.articles,
      (page) => `/articles/${page === 1 ? '' : `?page=${page}`}`,
    ),
    breadcrumb: [
      { name: '首頁', url: '/' },
      { name: '文章總覽', url: '/articles/' },
    ],
    seo:
      fixedSeo.get('/articles/') ??
      resolveSeo({
        site,
        title: '文章總覽',
        path: '/articles/',
        pageType: 'articles',
      }),
  });
  for (const id of site.home.featuredArticleIds)
    if (!cards.has(id))
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_FEATURED_ARTICLE',
        message: `首頁精選必須指向已發布文章：${id}`,
        resource: 'content/site.json',
        field: 'home.featuredArticleIds',
      });
  const mediaRefs = new Set<string>();
  for (const ref of [
    site.favicon,
    ...siteIconMediaRefs(site),
    site.social.defaultImage,
    ...Object.values(site.pageSEO).flatMap((settings) =>
      settings.imageSource === 'custom' ? [settings.ogImage] : [],
    ),
    ...fixedPages.flatMap((page) => [
      ...page.mediaRefs,
      shareImageReference(page.seo),
    ]),
    ...categories.map((category) => shareImageReference(category.seo)),
    ...tags.map((tag) => shareImageReference(tag.seo)),
  ])
    if (ref !== null) mediaRefs.add(ref);
  for (const article of sorted) {
    for (const ref of [
      ...articleMedia(article.meta),
      ...(analyses.get(article.articleId)?.mediaRefs ?? []),
    ])
      mediaRefs.add(ref);
    for (const link of analyses.get(article.articleId)?.links ?? []) {
      const path = link.href.split(/[?#]/u)[0];
      if (path !== undefined && ManagedMediaPathSchema.safeParse(path).success)
        mediaRefs.add(path);
    }
    diagnostics.push(...(articleDiagnostics.get(article.articleId) ?? []));
  }
  const closure = resolveMediaClosure([...mediaRefs], manifest);
  verifyMediaPaths(closure, manifest, diagnostics);
  const routeManifest = createRouteManifest(routeEntries, [
    ...AUXILIARY_PATHS,
    ...(view.iconSet?.manifest === null || view.iconSet?.manifest === undefined
      ? []
      : [view.iconSet.manifest.href]),
    ...closure,
  ]);
  diagnostics.push(...validateRouteManifest(routeManifest));
  for (const item of site.navigation) {
    try {
      const path = siteRelativePath(item.href, site.siteUrl);
      if (
        path !== null &&
        !routeManifest.routes.some((route) => route.path === path)
      )
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_NAVIGATION',
          message: `導覽指向未登錄頁面：${path}`,
          resource: 'content/site.json',
          field: 'navigation',
        });
    } catch {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_NAVIGATION',
        message: '導覽 URL 使用無法解析的編碼。',
        resource: 'content/site.json',
        field: 'navigation',
      });
    }
  }
  const linkSources = sorted.map((article) => ({
    articleId: article.articleId,
    path: articleUrl(article.meta.category, article.meta.slug),
    ids: analyses.get(article.articleId)?.ids ?? [],
    links: analyses.get(article.articleId)?.links ?? [],
  }));
  const linkResult = validateSiteLinks(linkSources, routeManifest, {
    siteUrl: site.siteUrl,
    allowPending: true,
  });
  diagnostics.push(...linkResult.diagnostics);
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
    throw new ContentValidationError(freeze(diagnostics));
  const searchDocuments: SearchDocument[] = articlePages.map((page) => ({
    id: page.articleId,
    title: page.meta.title,
    url: page.url,
    slug: page.meta.slug,
    category: { path: page.category.path, name: page.category.name },
    tags: page.tags.map((tag) => ({ slug: tag.slug, name: tag.name })),
    description: page.description,
    publishedAt: toUtcDateTime(page.meta.publishedAt),
    updatedAt: toUtcDateTime(page.meta.updatedAt),
    featuredImage: page.featuredImage,
  }));
  return freeze({
    site,
    articles: sorted,
    articlePages,
    listPages,
    home: {
      site: view,
      featuredCaption: site.home.featuredCaption,
      featured: site.home.featuredArticleIds.flatMap((id) => {
        const card = cards.get(id);
        return card === undefined ? [] : [card];
      }),
      latest: sorted.slice(0, site.home.latestCount).flatMap((article) => {
        const card = cards.get(article.articleId);
        return card === undefined ? [] : [card];
      }),
      categories: buildCategoryTree(categories, sorted),
      seo:
        fixedSeo.get('/') ??
        resolveSeo({
          site,
          title: '首頁',
          pageType: 'home',
          path: '/',
        }),
    },
    searchIndex: { version: 1, articles: searchDocuments },
    routeManifest,
    diagnostics,
    mediaRefs: closure,
    mediaPending: manifest === undefined && closure.length > 0,
    pendingLinkChecks: linkResult.pending,
  });
}

export function previewArticle(
  input: Omit<SiteModelInput, 'articles'> & {
    readonly article: Article;
    readonly articles?: readonly Article[];
  },
): PreviewArticleViewModel {
  const analyze = input.htmlCache?.analyze.bind(input.htmlCache) ?? analyzeHtml;
  const enhance =
    input.htmlCache?.enhance.bind(input.htmlCache) ?? enhanceHtmlMedia;
  const site = SiteConfigSchema.parse(input.site);
  const categories = CategoriesSchema.parse(input.categories);
  const tags = TagsSchema.parse(input.tags);
  ArticleIdSchema.parse(input.article.articleId);
  const meta = ArticleMetaSchema.parse(input.article.meta);
  const diagnostics: Diagnostic[] = [];
  const candidate = PublishedArticleMetaSchema.safeParse({
    ...meta,
    status: 'published',
  });
  if (!candidate.success)
    diagnostics.push(
      ...schemaDiagnostics(
        candidate.error.issues,
        `content/articles/${input.article.articleId}/meta.json`,
        input.article.articleId,
      ),
    );
  const category = categories.find((item) => item.path === meta.category);
  if (category === undefined)
    appendArticleDiagnostic(
      diagnostics,
      input.article.articleId,
      'UNKNOWN_CATEGORY',
      '請選擇既有分類。',
      'category',
    );
  const selectedTags = meta.tags.flatMap((slug) => {
    const tag = tags.find((item) => item.slug === slug);
    if (tag === undefined)
      appendArticleDiagnostic(
        diagnostics,
        input.article.articleId,
        'UNKNOWN_TAG',
        `Tag 不存在：${slug}`,
        'tags',
      );
    return tag === undefined ? [] : [tagView(tag)];
  });
  const url =
    category !== undefined && SlugSchema.safeParse(meta.slug).success
      ? articleUrl(category.path, meta.slug)
      : null;
  const analysis = analyze(input.article.contentHtml, {
    articleId: input.article.articleId,
    mode: 'draft',
  });
  if (input.mediaManifest === undefined)
    diagnostics.push(...analysis.diagnostics);
  const htmlResult = HtmlContentSchema.safeParse(input.article.contentHtml);
  if (!htmlResult.success)
    diagnostics.push(
      ...schemaDiagnostics(
        htmlResult.error.issues,
        `content/articles/${input.article.articleId}/content.html`,
        input.article.articleId,
      ),
    );
  let contentHtml = input.article.contentHtml;
  if (input.mediaManifest !== undefined) {
    const enhanced = enhance(contentHtml, input.mediaManifest, {
      articleId: input.article.articleId,
      mode: 'draft',
    });
    contentHtml = enhanced.contentHtml;
    diagnostics.push(...enhanced.diagnostics);
  }
  verifyMediaPaths(
    [
      ...articleMedia(meta),
      ...analysis.mediaRefs,
      ...(site.pageSEO.article.imageSource === 'custom' &&
      site.pageSEO.article.ogImage !== null
        ? [site.pageSEO.article.ogImage]
        : []),
    ],
    input.mediaManifest,
    diagnostics,
    input.article.articleId,
  );
  let mediaPending =
    input.mediaManifest === undefined &&
    [
      ...articleMedia(meta),
      ...analysis.mediaRefs,
      site.favicon,
      site.social.defaultImage,
      site.pageSEO.article.imageSource === 'custom'
        ? site.pageSEO.article.ogImage
        : null,
    ].some((ref) => ref !== null);
  if (candidate.success) {
    try {
      const publicModel = buildSiteModel({
        ...input,
        articles: [
          ...(input.articles ?? []).filter(
            (article) => article.articleId !== input.article.articleId,
          ),
          { ...input.article, meta: candidate.data },
        ],
      });
      diagnostics.push(...publicModel.diagnostics);
      mediaPending = publicModel.mediaPending;
    } catch (error) {
      if (!(error instanceof ContentValidationError)) throw error;
      diagnostics.push(...error.diagnostics);
    }
  }
  if (mediaPending)
    appendArticleDiagnostic(
      diagnostics,
      input.article.articleId,
      'MEDIA_VALIDATION_PENDING',
      '媒體尚未提供完成的 manifest，發布檢查未通過。',
      undefined,
      'warning',
    );
  const relatedCards: ArticleCardViewModel[] = [];
  for (const id of meta.relatedReading.articleIds) {
    if (id === input.article.articleId) {
      appendArticleDiagnostic(
        diagnostics,
        input.article.articleId,
        'RELATED_READING_SELF_REFERENCE',
        '延伸閱讀不可選擇文章本身。',
        'relatedReading.articleIds',
      );
      continue;
    }
    const target = input.articles?.find((article) => article.articleId === id);
    const parsed = PublishedArticleMetaSchema.safeParse(target?.meta);
    const targetCategory = parsed.success
      ? categories.find((item) => item.path === parsed.data.category)
      : undefined;
    if (!parsed.success || targetCategory === undefined) {
      appendArticleDiagnostic(
        diagnostics,
        input.article.articleId,
        'INVALID_RELATED_ARTICLE',
        `延伸閱讀必須指向已發布文章：${id}`,
        'relatedReading.articleIds',
      );
      continue;
    }
    relatedCards.push({
      articleId: id,
      title: parsed.data.title,
      url: articleUrl(parsed.data.category, parsed.data.slug),
      description: resolveArticleDescription(parsed.data, site),
      publishedAt: toUtcDateTime(parsed.data.publishedAt),
      updatedAt: toUtcDateTime(parsed.data.updatedAt),
      category: categoryView(targetCategory),
      tags: parsed.data.tags.flatMap((slug) => {
        const tag = tags.find((item) => item.slug === slug);
        return tag === undefined ? [] : [tagView(tag)];
      }),
      featuredImage: imageView(
        parsed.data.featuredImage,
        parsed.data.featuredImageAlt,
        input.mediaManifest,
      ),
    });
  }
  const uniqueDiagnostics = diagnostics.filter(
    (diagnostic, index) =>
      diagnostics.findIndex(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(diagnostic),
      ) === index,
  );
  const breadcrumb = categoryBreadcrumb(category?.path ?? null, categories, {
    title: meta.title || '未命名草稿',
    url,
  });
  return freeze({
    context: 'preview',
    articleId: input.article.articleId,
    site: siteView(site),
    meta,
    contentHtml,
    description: resolveArticleDescription(meta, site),
    relatedReading: {
      title: meta.relatedReading.title,
      articles: relatedCards,
    },
    category: category === undefined ? null : categoryView(category),
    tags: selectedTags,
    toc: analysis.toc as readonly TocEntry[],
    breadcrumb,
    seo: resolveSeo({
      site,
      title: meta.title || '未命名草稿',
      contentDescription: meta.excerpt,
      pageType: 'article',
      path: url,
      seo: meta.seo,
      kind: 'article',
      featuredImage: meta.featuredImage,
      forceNoindex: true,
      breadcrumb,
      article: meta,
    }),
    featuredImage: imageView(
      meta.featuredImage,
      meta.featuredImageAlt,
      input.mediaManifest,
    ),
    url,
    diagnostics: uniqueDiagnostics,
    publishable:
      candidate.success &&
      !mediaPending &&
      !uniqueDiagnostics.some((diagnostic) => diagnostic.severity === 'error'),
  });
}
