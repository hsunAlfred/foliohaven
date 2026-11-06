import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, firefox, webkit } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ArticlePage,
  ArticlesPage,
  CategoryPage,
  HomePage,
  SiteFooter,
  SiteHeader,
} from '@foliohaven/ui';
import type { ReactNode } from 'react';
import { uiModels } from '../fixtures/ui-models.js';

it('shared UI renders complete HTML at 375px/desktop with keyboard navigation and a browser-safe public bundle', async () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const parent = join(repository, '.alfred/environment-checks');
  await mkdir(parent, { recursive: true });
  const probe = await mkdtemp(join(parent, 'ui-browser-'));
  const { model } = uiModels();
  const article = model.articlePages[0];
  const category = model.listPages.find(
    (page) =>
      page.kind === 'category' &&
      page.key === 'notes' &&
      page.pagination.page === 1,
  );
  const categoryTwo = model.listPages.find(
    (page) =>
      page.kind === 'category' &&
      page.key === 'notes' &&
      page.pagination.page === 2,
  );
  const articles = model.listPages.find((page) => page.kind === 'articles');
  if (
    article === undefined ||
    category === undefined ||
    categoryTwo === undefined ||
    articles === undefined
  )
    throw new Error('UI瀏覽器測試缺少必要模型。');
  const site = model.home.site;
  const renderDocument = (body: ReactNode, path: string) =>
    '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UI isolation fixture</title></head><body>' +
    renderToStaticMarkup(
      <>
        <SiteHeader site={site} currentPath={path} />
        {body}
        <SiteFooter site={site} />
      </>,
    ) +
    '</body></html>';
  const documents = new Map([
    ['/', renderDocument(<HomePage model={model.home} />, '/')],
    [
      article.url,
      renderDocument(<ArticlePage article={article} />, article.url),
    ],
    [
      '/category/notes/',
      renderDocument(<CategoryPage model={category} />, '/category/notes/'),
    ],
    [
      '/category/notes/2/',
      renderDocument(
        <CategoryPage model={categoryTwo} />,
        '/category/notes/2/',
      ),
    ],
    [
      '/articles/',
      renderDocument(<ArticlesPage model={articles} />, '/articles/'),
    ],
  ]);
  try {
    const entry = join(probe, 'probe.ts');
    await writeFile(
      entry,
      `import * as ui from '@foliohaven/ui';\nimport '@foliohaven/ui/styles.css';\ndocument.body.dataset.uiExports = Object.keys(ui).join(',');\n`,
    );
    await writeFile(
      join(probe, 'index.html'),
      '<!doctype html><html><body><script type="module" src="/probe.ts"></script></body></html>',
    );
    await build({
      configFile: false,
      root: probe,
      logLevel: 'error',
      build: {
        outDir: join(probe, 'output'),
        emptyOutDir: true,
        minify: false,
        sourcemap: false,
      },
    });
    const outputs = await readdir(join(probe, 'output/assets'));
    const script = outputs.find((file) => /\.(?:mjs|js)$/u.test(file));
    const style = outputs.find((file) => file.endsWith('.css'));
    if (script === undefined || style === undefined)
      throw new Error('公開UI入口或CSS未生成可用瀏覽器產物。');
    const bundle = await readFile(join(probe, 'output/assets', script), 'utf8');
    const css = await readFile(join(probe, 'output/assets', style), 'utf8');
    expect(bundle).not.toMatch(
      /node:(?:fs|path|process|child_process)|__vite-browser-external|@(?:alfred-wiki|foliohaven)\/server|sharp\/|\.node["']/u,
    );
    expect(css).toContain('focus-visible');
    expect(css).not.toContain('https://');
    // 三個真實瀏覽器，每個均驗375px/desktop與停用JS的靜態分頁。
    for (const browserType of [chromium, firefox, webkit]) {
      const browser = await browserType.launch({ headless: true });
      try {
        for (const width of [375, 1280]) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            javaScriptEnabled: true,
          });
          try {
            await context.route('**/*', async (route) => {
              const path = new URL(route.request().url()).pathname;
              const html = documents.get(path);
              if (html !== undefined)
                await route.fulfill({
                  status: 200,
                  contentType: 'text/html; charset=utf-8',
                  body: html.replace('</head>', `<style>${css}</style></head>`),
                });
              else await route.abort();
            });
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on('pageerror', (error) => pageErrors.push(error.message));
            await page.goto(`http://ui.test${article.url}`);
            expect(await page.locator('main').count()).toBe(1);
            expect(await page.locator('h1').count()).toBe(1);
            expect(await page.locator('.article-body').textContent()).toContain(
              'RAW_HTML_SENTINEL',
            );
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
              ),
            ).toBe(true);
            await page.keyboard.press('Tab');
            await expect
              .poll(() =>
                page
                  .locator('.skip-link')
                  .evaluate(
                    (element) =>
                      element === element.ownerDocument.activeElement,
                  ),
              )
              .toBe(true);
            const focus = await page
              .locator('.skip-link')
              .evaluate((element) => ({
                outline: getComputedStyle(element).outlineStyle,
                width: getComputedStyle(element).outlineWidth,
                top: element.getBoundingClientRect().top,
              }));
            expect(focus.outline).toBe('solid');
            expect(focus.width).toBe('3px');
            expect(focus.top).toBeGreaterThanOrEqual(0);
            await page.keyboard.press('Enter');
            await expect
              .poll(() =>
                page
                  .locator('main')
                  .evaluate(
                    (element) =>
                      element === element.ownerDocument.activeElement,
                  ),
              )
              .toBe(true);
            await page.locator('.table-of-contents a').first().click();
            expect(decodeURIComponent(new URL(page.url()).hash)).toBe('#章節');
            await page.addScriptTag({ type: 'module', content: bundle });
            await expect
              .poll(
                async () =>
                  (await page
                    .locator('body')
                    .getAttribute('data-ui-exports')) ?? '',
              )
              .toContain('ArticlePage');
            expect(pageErrors).toEqual([]);
            for (const path of ['/', '/category/notes/', '/articles/']) {
              await page.goto(`http://ui.test${path}`);
              expect(await page.locator('main').count()).toBe(1);
              expect(await page.locator('h1').count()).toBe(1);
              expect(
                await page.evaluate(
                  () =>
                    document.documentElement.scrollWidth <= window.innerWidth,
                ),
              ).toBe(true);
            }
          } finally {
            await context.close();
          }
        }
        const noJs = await browser.newContext({
          viewport: { width: 375, height: 900 },
          javaScriptEnabled: false,
        });
        try {
          await noJs.route('**/*', async (route) => {
            const html = documents.get(new URL(route.request().url()).pathname);
            if (html === undefined) await route.abort();
            else
              await route.fulfill({
                contentType: 'text/html; charset=utf-8',
                body: html.replace('</head>', `<style>${css}</style></head>`),
              });
          });
          const page = await noJs.newPage();
          await page.goto('http://ui.test/category/notes/');
          expect(await page.locator('.article-card').count()).toBe(2);
          await page.getByRole('link', { name: '下一頁', exact: true }).click();
          expect(new URL(page.url()).pathname).toBe('/category/notes/2/');
          expect(await page.locator('.article-card').count()).toBe(1);
          await page.goto('http://ui.test/articles/');
          expect(await page.locator('noscript').textContent()).toContain(
            '目前顯示預設第一頁文章',
          );
          expect(await page.locator('.article-card').count()).toBe(2);
        } finally {
          await noJs.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
});
