import type { Diagnostic, RouteEntry, RouteManifest } from '../models/index.js';
import {
  CategoryPathSchema,
  PageSchema,
  RootPathSchema,
  SlugSchema,
} from '../schemas/common.js';

export const AUXILIARY_PATHS: readonly string[] = Object.freeze([
  '/rss.xml',
  '/search-index.json',
  '/robots.txt',
  '/sitemap-index.xml',
  '/sitemap-0.xml',
  '/404.html',
]);
export function siteRelativePath(href: string, siteUrl: string): string | null {
  const url = new URL(href, siteUrl);
  if (url.origin !== new URL(siteUrl).origin) return null;
  return decodeURI(url.pathname);
}
export function articleUrl(category: string, slug: string): string {
  return `/${CategoryPathSchema.parse(category)}/${SlugSchema.parse(slug)}/`;
}
export function categoryUrl(path: string, page = 1): string {
  CategoryPathSchema.parse(path);
  PageSchema.parse(page);
  return `/category/${path}/${page === 1 ? '' : `${page}/`}`;
}
export function tagUrl(slug: string, page = 1): string {
  SlugSchema.parse(slug);
  PageSchema.parse(page);
  return `/tag/${slug}/${page === 1 ? '' : `${page}/`}`;
}
export function pageOutputPath(path: string): string {
  RootPathSchema.parse(path);
  return path === '/' ? 'index.html' : `${path.slice(1)}index.html`;
}
export function validateRouteManifest(
  manifest: RouteManifest,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const paths = new Set<string>();
  const files = new Set<string>();
  for (const route of manifest.routes) {
    if (
      !RootPathSchema.safeParse(route.path).success ||
      route.outputPath !== pageOutputPath(route.path)
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_ROUTE',
        message: '頁面路由或輸出位置不符合統一 URL 規則。',
      });
      continue;
    }
    if (paths.has(route.path))
      diagnostics.push({
        severity: 'error',
        code: 'ROUTE_COLLISION',
        message: `公開 URL 重複：${route.path}`,
      });
    paths.add(route.path);
    if (files.has(route.outputPath))
      diagnostics.push({
        severity: 'error',
        code: 'OUTPUT_COLLISION',
        message: `輸出檔案重複：${route.outputPath}`,
      });
    files.add(route.outputPath);
  }
  for (const asset of manifest.assets) {
    if (
      !asset.startsWith('/') ||
      asset.startsWith('//') ||
      /[?#%\\\s]/u.test(asset) ||
      Array.from(asset).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      asset
        .slice(1)
        .split('/')
        .some((part) => part === '' || part === '.' || part === '..')
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_ASSET_ROUTE',
        message: '資源 URL 不合法。',
      });
      continue;
    }
    const file = asset.slice(1);
    if (paths.has(asset) || files.has(file))
      diagnostics.push({
        severity: 'error',
        code: 'OUTPUT_COLLISION',
        message: `輸出資源與頁面重複：${asset}`,
      });
    files.add(file);
  }
  for (const file of files) {
    const segments = file.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');
      if (files.has(ancestor))
        diagnostics.push({
          severity: 'error',
          code: 'OUTPUT_FILE_DIRECTORY_COLLISION',
          message: `檔案同時被要求作為目錄：${ancestor}`,
        });
    }
  }
  return diagnostics;
}
export function createRouteManifest(
  routes: readonly RouteEntry[],
  assets: readonly string[] = AUXILIARY_PATHS,
): RouteManifest {
  return Object.freeze({
    routes: Object.freeze(routes.map((route) => Object.freeze({ ...route }))),
    assets: Object.freeze([...new Set(assets)].sort()),
  });
}
