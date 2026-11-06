import type { z } from 'zod';
import type {
  ArticleMetaSchema,
  PublishedArticleMetaSchema,
  CategorySchema,
  TagSchema,
  SiteConfigSchema,
  SeoOverrideSchema,
  FixedPageSchema,
} from '../schemas/content.js';
import type {
  MediaSourceSchema,
  MediaManifestSchema,
} from '../schemas/media.js';
import type { JobSchema, DiagnosticSchema } from '../schemas/api.js';
import type * as api from '../schemas/api.js';
import type * as content from '../schemas/content.js';
import type * as media from '../schemas/media.js';

export type ArticleMeta = z.infer<typeof ArticleMetaSchema>;
export type PublishedArticleMeta = z.infer<typeof PublishedArticleMetaSchema>;
export type DraftArticleMeta = Extract<ArticleMeta, { status: 'draft' }>;
export type Category = z.infer<typeof CategorySchema>;
export type Tag = z.infer<typeof TagSchema>;
export type SiteConfig = z.infer<typeof SiteConfigSchema>;
export type SeoOverride = z.infer<typeof SeoOverrideSchema>;
export type SeoPageType = z.infer<typeof content.SeoPageTypeSchema>;
export type PageSeoSettings = z.infer<typeof content.PageSeoSettingsSchema>;
export type PageSeoDefaults = z.infer<typeof content.PageSeoDefaultsSchema>;
export type SeoSource =
  'override' | 'pageType' | 'global' | 'content' | 'none' | 'forced';
export type SeoSourceLayer = 'override' | 'pageType' | 'global' | 'forced';
export type FixedPage = z.infer<typeof FixedPageSchema>;
export type MediaSource = z.infer<typeof MediaSourceSchema>;
export type MediaManifest = z.infer<typeof MediaManifestSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export type ArticleWrite = z.infer<typeof content.ArticleWriteSchema>;
export type ArticleResource = z.infer<typeof api.ArticleResourceSchema>;
export type ApiError = z.infer<typeof api.ApiErrorSchema>;
export type ApiIssue = z.infer<typeof api.ApiIssueSchema>;
export type SafeError = z.infer<typeof api.SafeErrorSchema>;
export type Workspace = z.infer<typeof api.WorkspaceSchema>;
export type ArticleListQuery = z.infer<typeof api.ArticleListQuerySchema>;
export type ArticleOptionsQuery = z.infer<typeof api.ArticleOptionsQuerySchema>;
export type ArticleOption = z.infer<typeof api.ArticleOptionSchema>;
export type ArticleOptions = z.infer<typeof api.ArticleOptionsSchema>;
export type MediaListQuery = z.infer<typeof api.MediaListQuerySchema>;
export type JobListQuery = z.infer<typeof api.JobListQuerySchema>;
export type PublicationUpdate = z.infer<typeof api.PublicationUpdateSchema>;
export type PreviewRequest = z.infer<typeof api.PreviewRequestSchema>;
export type PreviewResponse = z.infer<typeof api.PreviewResponseSchema>;
export type TaxonomyMigrationRequest = z.infer<
  typeof api.TaxonomyMigrationRequestSchema
>;
export type TaxonomyMigrationPlan = z.infer<
  typeof api.TaxonomyMigrationPlanSchema
>;
export type MediaJobRequest = z.infer<typeof api.MediaJobRequestSchema>;
export type BuildJobRequest = z.infer<typeof api.BuildJobRequestSchema>;
export type JobRetryInput = z.infer<typeof api.JobRetryInputSchema>;
export type BuildResult = z.infer<typeof api.BuildResultSchema>;
export type CurrentArtifact = z.infer<typeof api.CurrentArtifactSchema>;
export type MediaResult = z.infer<typeof api.MediaResultSchema>;
export type TaxonomyResult = z.infer<typeof api.TaxonomyResultSchema>;
export type Operation = z.infer<typeof api.OperationSchema>;
export type RecoveryChoice = z.infer<typeof api.RecoveryChoiceSchema>;
export type RecoveryResolution = z.infer<typeof api.RecoveryResolutionSchema>;
export type RecoveryDetail = z.infer<typeof api.RecoveryDetailSchema>;
export type MediaOutput = z.infer<typeof media.MediaOutputSchema>;
export type MediaAsset = z.infer<typeof media.MediaAssetSchema>;
export type MediaSourceUpdate = z.infer<typeof media.MediaSourceUpdateSchema>;
export type MediaSourceResource = z.infer<
  typeof media.MediaSourceResourceSchema
>;
export type Taxonomy = z.infer<typeof content.TaxonomySchema>;
export type SearchIndex = z.infer<typeof api.SearchIndexSchema>;
export type DeepReadonly<T> = T extends readonly (infer V)[]
  ? readonly DeepReadonly<V>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export interface Article {
  readonly articleId: string;
  readonly meta: ArticleMeta;
  readonly contentHtml: string;
}
export interface TocEntry {
  readonly id: string;
  readonly text: string;
  readonly level: 2 | 3 | 4 | 5 | 6;
}
export interface BreadcrumbItem {
  readonly name: string;
  readonly url: string | null;
}
export interface CategoryViewModel {
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
}
export interface CategoryTreeNode extends CategoryViewModel {
  readonly children: readonly CategoryTreeNode[];
  readonly articleCount: number;
}
export interface TagViewModel {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
}
export interface ImageViewModel {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly srcset: string | null;
  readonly sizes: string | null;
}
export interface SeoViewModel {
  readonly title: string;
  readonly description: string;
  readonly sources: {
    readonly title: SeoSource;
    readonly description: SeoSource;
    readonly index: SeoSource;
    readonly image: SeoSource;
  };
  readonly sourceLayers: {
    readonly title: SeoSourceLayer;
    readonly description: SeoSourceLayer;
    readonly index: SeoSourceLayer;
    readonly image: SeoSourceLayer;
  };
  readonly canonical: string | null;
  readonly index: boolean;
  readonly robots: 'index,follow' | 'noindex,follow';
  readonly openGraph: {
    readonly type: 'website' | 'article';
    readonly title: string;
    readonly description: string;
    readonly url: string | null;
    readonly siteName: string;
    readonly locale: string;
    readonly image: string | null;
  };
  readonly twitter: {
    readonly card: 'summary' | 'summary_large_image';
    readonly title: string;
    readonly description: string;
    readonly image: string | null;
    readonly site: string | null;
  };
  readonly jsonLd: readonly JsonObject[];
  readonly googleSiteVerification: string | null;
  readonly rssUrl: string;
}
export interface SiteIconLink {
  readonly href: string;
  readonly type: string;
  readonly sizes?: string;
}
export interface WebAppManifestViewModel {
  readonly id: '/';
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly start_url: '/';
  readonly scope: '/';
  readonly display: 'standalone' | 'minimal-ui' | 'browser';
  readonly theme_color: string;
  readonly background_color: string;
  readonly icons: readonly {
    readonly src: string;
    readonly sizes: string;
    readonly type: 'image/png';
    readonly purpose: 'any';
  }[];
}
export interface SiteIconSetViewModel {
  readonly icons: readonly SiteIconLink[];
  readonly appleTouchIcon: string | null;
  readonly maskIcon: { readonly href: string; readonly color: string } | null;
  readonly manifest: {
    readonly href: '/site.webmanifest';
    readonly data: WebAppManifestViewModel;
  } | null;
  readonly themeLight: string | null;
  readonly themeDark: string | null;
}
export interface SiteViewModel {
  readonly siteName: string;
  readonly siteDescription: string;
  readonly favicon: string | null;
  readonly iconSet?: SiteIconSetViewModel;
  readonly siteUrl: string;
  readonly language: string;
  readonly timeZone: string;
  readonly author: Readonly<SiteConfig['author']>;
  readonly navigation: readonly Readonly<SiteConfig['navigation'][number]>[];
  readonly rssUrl: string;
}
export interface ArticleCardViewModel {
  readonly articleId: string;
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly category: CategoryViewModel;
  readonly tags: readonly TagViewModel[];
  readonly featuredImage: ImageViewModel | null;
}
interface ArticleViewModelCommon {
  readonly articleId: string;
  readonly site: SiteViewModel;
  readonly contentHtml: string;
  /** Display summary, independent from an explicit SEO description. */
  readonly description: string;
  readonly category: CategoryViewModel | null;
  readonly tags: readonly TagViewModel[];
  readonly toc: readonly TocEntry[];
  readonly breadcrumb: readonly BreadcrumbItem[];
  readonly seo: SeoViewModel;
  readonly featuredImage: ImageViewModel | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly publishable: boolean;
  readonly relatedReading?: {
    readonly title: string;
    readonly articles: readonly ArticleCardViewModel[];
  };
}
export interface PublicArticleViewModel extends ArticleViewModelCommon {
  readonly context: 'public';
  readonly meta: DeepReadonly<PublishedArticleMeta>;
  readonly url: string;
  readonly category: CategoryViewModel;
  readonly publishable: true;
}
export interface PreviewArticleViewModel extends ArticleViewModelCommon {
  readonly context: 'preview';
  readonly meta: DeepReadonly<ArticleMeta>;
  readonly url: string | null;
}
export type ArticleViewModel = PublicArticleViewModel | PreviewArticleViewModel;
export interface PaginationLink {
  readonly page: number;
  readonly url: string;
  readonly current: boolean;
}
export interface PaginationViewModel {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly links: readonly PaginationLink[];
  readonly previousUrl: string | null;
  readonly nextUrl: string | null;
}
export interface ListPageViewModel {
  readonly site: SiteViewModel;
  readonly kind: 'category' | 'tag' | 'articles';
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly articles: readonly ArticleCardViewModel[];
  readonly pagination: PaginationViewModel;
  readonly breadcrumb: readonly BreadcrumbItem[];
  readonly seo: SeoViewModel;
}
export interface HomeViewModel {
  readonly site: SiteViewModel;
  readonly featuredCaption: string;
  readonly featured: readonly ArticleCardViewModel[];
  readonly latest: readonly ArticleCardViewModel[];
  readonly categories: readonly CategoryTreeNode[];
  readonly seo: SeoViewModel;
}
export interface SearchDocument {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly slug: string;
  readonly category: { readonly path: string; readonly name: string };
  readonly tags: readonly { readonly slug: string; readonly name: string }[];
  readonly description: string;
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly featuredImage: ImageViewModel | null;
}
export interface RouteEntry {
  readonly kind: 'fixed' | 'article' | 'category' | 'tag';
  readonly path: string;
  readonly outputPath: string;
  readonly index: boolean;
  readonly articleId?: string;
  readonly taxonomyKey?: string;
  readonly page?: number;
}
export interface RouteManifest {
  readonly routes: readonly RouteEntry[];
  readonly assets: readonly string[];
}
