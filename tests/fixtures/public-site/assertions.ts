import { expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import {
  parseSearchQuery,
  searchPageViewModel,
  searchQueryUrl,
} from '@foliohaven/core';
import type {
  ArticleCardViewModel,
  CategoryTreeNode,
  SeoViewModel,
} from '@foliohaven/core';
import { prepareRenderContext } from '../../../server/src/build/render/context.js';
import type { PreparedRenderContext } from '../../../server/src/build/render/types.js';

export type PublicSiteExpected = Pick<
  PreparedRenderContext,
  'model' | 'manifest' | 'fixedPageSeos'
>;

/** 真來源經正式 Core/media 路徑產生期望；只寫自己的私有 context/cache。 */
export async function publicSiteExpected(repositoryRoot: string) {
  const directory = join(
    repositoryRoot,
    '.alfred/reports/public-site',
    randomUUID(),
  );
  try {
    const prepared = await prepareRenderContext({
      repositoryRoot,
      contextDirectory: join(directory, 'context'),
    });
    return {
      model: prepared.model,
      manifest: prepared.manifest,
      fixedPageSeos: prepared.fixedPageSeos,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function isPrivatePublicRequest(pathname: string): boolean {
  return /^\/(?:api|server|studio|content|\.alfred)(?:\/|$)|^\/media\/source(?:\/|$)/u.test(
    pathname,
  );
}
async function cards(page: Page, expected: readonly ArticleCardViewModel[]) {
  const titles = page.locator('main .article-card-title a');
  await expect(titles).toHaveText(expected.map((article) => article.title));
  expect(
    await titles.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('href')),
    ),
  ).toEqual(expected.map((article) => article.url));
}
async function seo(page: Page, expected: SeoViewModel) {
  await expect(page).toHaveTitle(expected.title);
  for (const [selector, value] of [
    ['meta[name="description"]', expected.description],
    ['meta[name="robots"]', expected.robots],
    ['meta[property="og:type"]', expected.openGraph.type],
    ['meta[property="og:title"]', expected.openGraph.title],
    ['meta[property="og:description"]', expected.openGraph.description],
    ['meta[property="og:site_name"]', expected.openGraph.siteName],
    ['meta[property="og:locale"]', expected.openGraph.locale],
    ['meta[property="og:url"]', expected.openGraph.url],
    ['meta[property="og:image"]', expected.openGraph.image],
    ['meta[name="twitter:card"]', expected.twitter.card],
    ['meta[name="twitter:title"]', expected.twitter.title],
    ['meta[name="twitter:description"]', expected.twitter.description],
    ['meta[name="twitter:image"]', expected.twitter.image],
    ['meta[name="twitter:site"]', expected.twitter.site],
  ] as const) {
    const node = page.locator(selector);
    if (value === null) await expect(node).toHaveCount(0);
    else await expect(node).toHaveAttribute('content', value);
  }
  const canonical = page.locator('link[rel="canonical"]');
  if (expected.canonical === null) await expect(canonical).toHaveCount(0);
  else await expect(canonical).toHaveAttribute('href', expected.canonical);
  const structured = page.locator('script[type="application/ld+json"]');
  if (expected.jsonLd.length === 0) await expect(structured).toHaveCount(0);
  else
    expect(JSON.parse(await structured.innerText()) as unknown).toEqual(
      expected.jsonLd,
    );
}
function categoryUrls(categories: readonly CategoryTreeNode[]): string[] {
  return categories.flatMap((category) => [
    category.url,
    ...categoryUrls(category.children),
  ]);
}
type HtmlNode = DefaultTreeAdapterMap['node'];
function htmlElements(html: string, tag: string) {
  const result: Record<string, string>[] = [];
  const visit = (node: HtmlNode) => {
    if ('tagName' in node && node.tagName === tag)
      result.push(
        Object.fromEntries(node.attrs.map(({ name, value }) => [name, value])),
      );
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(parseFragment(html));
  return result;
}

/** 與根 dist E2E、隔離六篇／空站回歸共用，不能偷讀 output 當期望。 */
export async function expectStaticPublicSite(
  browser: Browser,
  url: string,
  expected: PublicSiteExpected,
) {
  const { model } = expected;
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 375, height: 812 },
  });
  try {
    const page = await context.newPage();
    const privateRequests: string[] = [];
    page.on('request', (request) => {
      if (isPrivatePublicRequest(new URL(request.url()).pathname))
        privateRequests.push(request.url());
    });
    const visited = new Set<string>();
    const articlePaths = new Set(
      model.articlePages.map((article) => article.url),
    );
    const inspectedBundles = new Set<string>();
    const scripts = async (path: string) => {
      await expect(page.locator('astro-island')).toHaveCount(
        path === '/articles/' ? 1 : 0,
      );
      const modules = page.locator('script[src]');
      if (!articlePaths.has(path)) {
        await expect(modules).toHaveCount(0);
        return;
      }
      // 文章只載入目錄／程式碼增強模組；不放寬成允許任意 script。
      await expect(modules).toHaveCount(1);
      await expect(modules).toHaveAttribute('type', 'module');
      const src = await modules.getAttribute('src');
      expect(src).toMatch(/^\/assets\/[^/?#]+\.js$/u);
      if (!src || inspectedBundles.has(src)) return;
      const bundle = await context.request.get(new URL(src, url).href);
      expect(bundle.status()).toBe(200);
      expect(bundle.headers()['content-type']).toMatch(/(?:java|ecma)script/iu);
      const source = await bundle.text();
      for (const marker of [
        '[data-reading-toc]',
        '[data-article-body]',
        'code-toolbar',
        'readingScrollReady',
      ])
        expect(source).toContain(marker);
      expect(source).not.toMatch(
        /\bnode:|__vite-browser-external|@(?:alfred-wiki|foliohaven)\/server|(?:server|studio)\/src\/|\/api\/v1\/|sourceMappingURL/u,
      );
      inspectedBundles.add(src);
    };
    const visit = async (path: string, expectedSeo: SeoViewModel) => {
      const href = new URL(path, url).href;
      const status = (await page.goto(href))?.status();
      if (visited.has(href)) expect([200, 304]).toContain(status);
      else expect(status).toBe(200);
      await seo(page, expectedSeo);
      await scripts(path);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
      visited.add(href);
    };
    await visit('/', model.home.seo);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      model.site.siteName,
    );
    await cards(page, [...model.home.featured, ...model.home.latest]);
    expect(
      await page
        .locator('main .category-links a')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
    ).toEqual(categoryUrls(model.home.categories));
    await expect(page.locator('script[src]')).toHaveCount(0);
    if (model.articlePages.length === 0)
      await expect(
        page.getByText('目前還沒有已發布文章。', { exact: true }),
      ).toBeVisible();
    for (const kind of ['category', 'tag'] as const) {
      const firstPages = model.listPages.filter(
        (item) => item.kind === kind && item.pagination.page === 1,
      );
      const selected =
        firstPages.find((item) => item.pagination.nextUrl !== null) ??
        firstPages[0];
      if (selected) {
        await visit(selected.url, selected.seo);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          selected.title,
        );
        await cards(page, selected.articles);
        if (selected.pagination.nextUrl !== null) {
          const next = model.listPages.find(
            (item) => item.url === selected.pagination.nextUrl,
          );
          if (!next) throw new Error('Core pagination target missing');
          await page.getByRole('link', { name: '下一頁', exact: true }).click();
          await expect(page).toHaveURL(new URL(next.url, url).href);
          await seo(page, next.seo);
          await scripts(next.url);
          await cards(page, next.articles);
        } else {
          await expect(
            page.getByRole('navigation', { name: '文章分頁', exact: true }),
          ).toHaveCount(0);
          expect(selected.pagination.totalPages).toBe(1);
        }
      } else
        expect(
          model.routeManifest.routes.filter((route) => route.kind === kind),
        ).toEqual([]);
    }
    const representative = model.articlePages[0];
    if (representative) {
      await visit(representative.url, representative.seo);
      await expect(page.locator('main article h1')).toHaveText(
        representative.meta.title,
      );
      await expect(page.locator('main article h1')).toBeVisible();
      // 合法空白／註解／空元素可能為零高度，驗展示規則而不強制正文高度。
      const body = page.locator('.article-body');
      await expect(body).toBeAttached();
      await expect(body).not.toHaveCSS('display', 'none');
      await expect(body).not.toHaveCSS('visibility', /^(?:hidden|collapse)$/u);
      await expect(page.locator('.article-dates time').first()).toHaveAttribute(
        'datetime',
        representative.meta.publishedAt,
      );
    }
    const imageArticle = model.articlePages.find(
      (article) =>
        htmlElements(article.contentHtml, 'img').length > 0 ||
        article.featuredImage !== null,
    );
    if (imageArticle) {
      await visit(imageArticle.url, imageArticle.seo);
      const bodyImage = htmlElements(imageArticle.contentHtml, 'img')[0];
      const image = page
        .locator(
          bodyImage ? '.article-body img' : '.article-featured-image img',
        )
        .first();
      const src = bodyImage ? bodyImage.src : imageArticle.featuredImage?.src;
      if (!src) throw new Error('Core image source missing');
      await expect(image).toHaveAttribute('src', src);
      const srcset = bodyImage
        ? bodyImage.srcset
        : imageArticle.featuredImage?.srcset;
      if (srcset) await expect(image).toHaveAttribute('srcset', srcset);
      await image.scrollIntoViewIfNeeded();
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate(
            (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
          ),
        )
        .toBe(true);
    }
    const noindex = model.articlePages.find((article) => !article.seo.index);
    if (noindex) {
      await visit(noindex.url, noindex.seo);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        'content',
        'noindex,follow',
      );
    }
    const tableArticle = model.articlePages.find(
      (article) => htmlElements(article.contentHtml, 'caption').length > 0,
    );
    if (tableArticle) {
      await visit(tableArticle.url, tableArticle.seo);
      await expect(
        page.locator('.article-body table caption').first(),
      ).toBeVisible();
    }
    const videoArticle = model.articlePages.find(
      (article) => htmlElements(article.contentHtml, 'video').length > 0,
    );
    if (videoArticle) {
      await visit(videoArticle.url, videoArticle.seo);
      const attributes = htmlElements(videoArticle.contentHtml, 'video')[0];
      const source =
        attributes?.src ??
        htmlElements(videoArticle.contentHtml, 'source')
          .map((item) => item.src)
          .find((item) => item?.endsWith('/video.webm'));
      const output = expected.manifest.assets
        .flatMap((asset) => asset.outputs)
        .find((item) => item.publicPath === source);
      if (!source || !output)
        throw new Error('Core published video output missing');
      if (attributes?.poster)
        await expect(
          page.locator('.article-body video').first(),
        ).toHaveAttribute('poster', attributes.poster);
      const length = Math.min(32, output.byteSize);
      const part = await context.request.get(new URL(source, url).href, {
        headers: { Range: `bytes=0-${length - 1}` },
      });
      expect(part.status()).toBe(206);
      expect(part.headers()['content-range']).toBe(
        `bytes 0-${length - 1}/${output.byteSize}`,
      );
      expect((await part.body()).length).toBe(length);
    }
    const initial = model.listPages.find((item) => item.kind === 'articles');
    if (!initial) throw new Error('Core public articles page missing');
    await visit('/articles/', initial.seo);
    await cards(page, initial.articles);
    // Playwright 的文字匹配會忽略 NOSCRIPT 本身；檢查實際可見的子段落。
    const noScriptNotice = page.locator('noscript .search-notice');
    await expect(noScriptNotice).toBeVisible();
    await expect(noScriptNotice).toContainText('JavaScript');
    const searchIndex = await context.request.get(
      new URL('/search-index.json', url).href,
    );
    expect(searchIndex.status()).toBe(200);
    expect(await searchIndex.json()).toEqual(model.searchIndex);
    const independent = model.routeManifest.routes.filter(
      (route) =>
        route.kind === 'fixed' &&
        route.path !== '/' &&
        route.path !== '/articles/',
    );
    for (const route of independent) {
      const independentSeo = expected.fixedPageSeos[route.path];
      if (!independentSeo) throw new Error('Core fixed-page SEO missing');
      await visit(route.path, independentSeo);
    }
    const missing = `/public-check-missing-${randomUUID()}/`;
    expect(
      model.routeManifest.routes.some((route) => route.path === missing),
    ).toBe(false);
    expect((await page.goto(new URL(missing, url).href))?.status()).toBe(404);
    await scripts(missing);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(privateRequests).toEqual([]);
  } finally {
    await context.close();
  }
}

export async function expectSearchPublicSite(
  page: Page,
  url: string,
  expected: PublicSiteExpected,
) {
  const initial = expected.model.listPages.find(
    (item) => item.kind === 'articles',
  );
  if (!initial) throw new Error('Core public articles page missing');
  const documents = expected.model.searchIndex.articles;
  const errors: string[] = [],
    privateRequests: string[] = [];
  let indexRequests = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (isPrivatePublicRequest(pathname)) privateRequests.push(request.url());
    if (pathname === '/search-index.json') indexRequests++;
  });
  const check = async (path: string) => {
    const result = searchPageViewModel(
      initial,
      documents,
      parseSearchQuery(new URL(path, url).search),
    );
    await expect(page.locator('[data-search-state]')).toHaveAttribute(
      'data-search-state',
      'ready',
    );
    await cards(page, result.model.articles);
    await seo(page, initial.seo);
    if (result.validPage)
      await expect(page.getByRole('status')).toContainText(
        `共 ${result.model.pagination.totalItems} 篇文章，第 ${result.model.pagination.page} 頁。`,
      );
    else {
      await expect(page.getByRole('status')).toContainText(
        '頁碼無效或超出範圍。',
      );
      await expect(
        page.getByRole('link', { name: '回第一頁', exact: true }),
      ).toHaveAttribute('href', result.firstPageUrl);
    }
    return result;
  };
  let previous = '/articles/?page=2';
  await page.goto(new URL(previous, url).href);
  const direct = await check(previous);
  if (!direct.validPage) {
    await page.getByRole('link', { name: '回第一頁', exact: true }).click();
    previous = direct.firstPageUrl;
    await expect(page).toHaveURL(new URL(previous, url).href);
    await check(previous);
  }
  const query = documents[0]?.slug ?? 'empty-site-search';
  await page.getByRole('searchbox', { name: '關鍵字' }).fill(query);
  await expect(page).toHaveURL(new URL(previous, url).href);
  await page.getByRole('button', { name: '搜尋', exact: true }).click();
  const searched = searchQueryUrl(query);
  await expect(page).toHaveURL(new URL(searched, url).href);
  await check(searched);
  await page.goBack();
  await expect(page).toHaveURL(new URL(previous, url).href);
  await check(previous);
  await page.goForward();
  await expect(page).toHaveURL(new URL(searched, url).href);
  await check(searched);
  expect(indexRequests).toBe(1);
  expect(errors).toEqual([]);
  expect(privateRequests).toEqual([]);
}
