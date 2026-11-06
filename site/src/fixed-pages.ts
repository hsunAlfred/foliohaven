import {
  FixedPageSchema,
  type FixedPage,
  type JsonValue,
  type SiteConfig,
  type RouteManifest,
  type MediaManifest,
  type SeoViewModel,
} from '@foliohaven/core';
import type { z } from 'zod';

/** 固定頁面需同時有 React 主體、Astro Entry 與這份明確登錄。 */
export const fixedPages: readonly FixedPage[] = [
  FixedPageSchema.parse({
    id: 'home',
    path: '/',
    entry: 'src/pages/index.astro',
    seo: {},
    mediaRefs: [],
  }),
  FixedPageSchema.parse({
    id: 'articles',
    path: '/articles/',
    entry: 'src/pages/articles/index.astro',
    seo: {},
    mediaRefs: [],
  }),
  FixedPageSchema.parse({
    id: 'category-index',
    path: '/category/',
    entry: 'src/pages/category/index.astro',
    seo: {},
    mediaRefs: [],
  }),
  FixedPageSchema.parse({
    id: 'tag-index',
    path: '/tag/',
    entry: 'src/pages/tag/index.astro',
    seo: {},
    mediaRefs: [],
  }),
];

/** 若新增content/pages/<pageId>.json，於此登錄該頁專用的strict Zod Schema。 */
export const pageSchemas: Readonly<Record<string, z.ZodType<JsonValue>>> = {};

/** 私有建置資料交換格式；不放正文、不輸出至公開網站。 */
export interface RenderContextIndex {
  readonly schemaVersion: 1;
  readonly status: 'valid';
  /** UUID validated by the private reader; absent only for legacy flat contexts. */
  readonly generation?: string;
  readonly site: SiteConfig;
  readonly routeManifest: RouteManifest;
  readonly mediaManifest: MediaManifest;
  readonly articles: readonly {
    readonly id: string;
    readonly url: string;
    readonly file: string;
    readonly title: string;
    readonly description: string;
    readonly publishedAt: string;
    readonly updatedAt: string;
  }[];
  readonly lists: readonly {
    readonly kind: 'category' | 'tag' | 'articles';
    readonly url: string;
    readonly file: string;
  }[];
  readonly fixedPages: readonly {
    readonly id: string;
    readonly path: string;
    readonly seo: SeoViewModel;
  }[];
  readonly pages: Readonly<Record<string, string>>;
}
