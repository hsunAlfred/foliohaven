import { privateResource } from '../../scripts/workspace-paths.mjs';
import { ensurePrivateDirectory } from '../../scripts/private-directory.mjs';
import { it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium, firefox, webkit } from '@playwright/test';
import { renderToString } from 'react-dom/server';
import ArticlesSearch from '../../site/src/components/ArticlesSearch.js';
import { uiModels } from '../fixtures/ui-models.js';

it('search hydrates the static first page and preserves URL, history, errors and no-JS behavior in three real browsers', async () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const parent = ensurePrivateDirectory(
    repository,
    privateResource(repository, 'environment-checks'),
  );
  const probe = await mkdtemp(join(parent, 'search-browser-'));
  const { model } = uiModels();
  const initial = model.listPages.find((page) => page.kind === 'articles');
  if (!initial) throw new Error('Search fixture lacks an initial article list');
  try {
    const component = join(
      repository,
      'site/src/components/ArticlesSearch.tsx',
    );
    await writeFile(
      join(probe, 'probe.tsx'),
      `import { hydrateRoot } from 'react-dom/client';
import ArticlesSearch from ${JSON.stringify(component)};
import '@foliohaven/ui/styles.css';
hydrateRoot(document.getElementById('root'), <ArticlesSearch model={${JSON.stringify(initial)}} />);`,
    );
    await writeFile(
      join(probe, 'index.html'),
      '<!doctype html><html><body><script type="module" src="/probe.tsx"></script></body></html>',
    );
    await build({
      configFile: false,
      root: probe,
      logLevel: 'error',
      oxc: { jsx: { runtime: 'automatic' } },
      build: {
        outDir: join(probe, 'output'),
        emptyOutDir: true,
        sourcemap: false,
        minify: false,
      },
    });
    const assets = await readdir(join(probe, 'output/assets'));
    const script = assets.find((path) => path.endsWith('.js'));
    const style = assets.find((path) => path.endsWith('.css'));
    if (!script || !style)
      throw new Error('Search browser bundle or stylesheet missing');
    const bundle = await readFile(join(probe, 'output/assets', script), 'utf8');
    const css = await readFile(join(probe, 'output/assets', style), 'utf8');
    expect(bundle).not.toMatch(
      /node:(?:fs|path|process|child_process)|__vite-browser-external|@(?:alfred-wiki|foliohaven)\/server|sharp\//u,
    );
    const html =
      '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Search fixture</title><style>' +
      css +
      '</style></head><body><div id="root">' +
      renderToString(<ArticlesSearch model={initial} />) +
      '</div><script type="module" src="/assets/search.js"></script></body></html>';
    for (const browserType of [chromium, firefox, webkit]) {
      const browser = await browserType.launch({ headless: true });
      try {
        const context = await browser.newContext({
          viewport: { width: 375, height: 900 },
        });
        try {
          let indexMode: 'ok' | 'unavailable' | 'unknown' = 'ok';
          let indexRequests = 0;
          await context.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === '/articles/')
              await route.fulfill({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: html,
              });
            else if (url.pathname === '/assets/search.js')
              await route.fulfill({
                status: 200,
                contentType: 'text/javascript',
                body: bundle,
              });
            else if (url.pathname === '/search-index.json') {
              indexRequests++;
              await new Promise((resolve) => setTimeout(resolve, 100));
              await route.fulfill({
                status: indexMode === 'unavailable' ? 503 : 200,
                contentType: 'application/json',
                body: JSON.stringify(
                  indexMode === 'unknown'
                    ? { ...model.searchIndex, version: 999 }
                    : model.searchIndex,
                ),
              });
            } else await route.abort();
          });
          const page = await context.newPage();
          const errors: string[] = [];
          const hydration: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('console', (message) => {
            if (
              /hydration|Minified React error #(418|423|425)/iu.test(
                message.text(),
              )
            )
              hydration.push(message.text());
          });
          const ready = () =>
            expect
              .poll(() =>
                page
                  .locator('[data-search-state]')
                  .getAttribute('data-search-state'),
              )
              .toBe('ready');
          await page.goto('http://search.test/articles/?page=2');
          await ready();
          expect(
            await page.locator('.article-card-title').allTextContents(),
          ).toEqual(['展示文章 3']);
          expect(await page.locator('.result-count').textContent()).toContain(
            '第 2 頁',
          );
          expect(indexRequests).toBe(1);
          expect(await page.locator('main').count()).toBe(1);
          expect(await page.locator('h1').count()).toBe(1);
          const historyLength = await page.evaluate(() => history.length);
          await page.getByRole('searchbox').fill(' ＥＸＡＭＰＬＥ  展示 ');
          expect(await page.evaluate(() => history.length)).toBe(historyLength);
          await page.getByRole('button', { name: '搜尋', exact: true }).click();
          await expect
            .poll(() => page.locator('.article-card-title').count())
            .toBe(2);
          expect(
            await page.evaluate(() =>
              new URL(location.href).searchParams.get('q'),
            ),
          ).toBe('example 展示');
          expect(
            await page.evaluate(() =>
              new URL(location.href).searchParams.has('page'),
            ),
          ).toBe(false);
          expect(await page.locator('main script').count()).toBe(0);
          expect(
            await page.locator('.article-card-title').first().textContent(),
          ).toContain('<script>不執行</script>');
          await page.getByRole('searchbox').fill('');
          await page.getByRole('button', { name: '搜尋', exact: true }).click();
          await expect
            .poll(() => page.url())
            .toBe('http://search.test/articles/');
          await page
            .getByRole('link', { name: '第 2 頁', exact: true })
            .click();
          await expect
            .poll(() => page.locator('.article-card-title').allTextContents())
            .toEqual(['展示文章 3']);
          await page.goBack();
          await expect
            .poll(() => page.locator('.article-card-title').count())
            .toBe(2);
          await page.goForward();
          await expect
            .poll(() => page.locator('.article-card-title').allTextContents())
            .toEqual(['展示文章 3']);
          for (const query of [
            '?page=0',
            '?page=99',
            '?page=1e2',
            '?page=1.5',
          ]) {
            await page.goto('http://search.test/articles/' + query);
            await ready();
            expect(await page.locator('.article-card').count()).toBe(0);
            expect(
              await page
                .getByRole('link', { name: '回第一頁', exact: true })
                .getAttribute('href'),
            ).toBe('/articles/');
          }
          await page.goto(
            'http://search.test/articles/?q=example&q=absent&page=1&page=2&ignored=x',
          );
          await ready();
          expect(await page.locator('.article-card').count()).toBe(2);
          await page.goto(
            'http://search.test/articles/?q=' +
              encodeURIComponent('字'.repeat(201)),
          );
          await ready();
          expect(await page.getByRole('alert').textContent()).toContain('200');
          expect(
            await page.getByRole('searchbox').getAttribute('aria-invalid'),
          ).toBe('true');
          expect(await page.locator('.article-card').count()).toBe(0);
          await page.goto(
            'http://search.test/articles/?q=' +
              encodeURIComponent('<img src=x onerror=alert(1)>'),
          );
          await ready();
          expect(await page.locator('img[onerror]').count()).toBe(0);
          expect(await page.locator('.article-card').count()).toBe(0);
          for (const mode of ['unavailable', 'unknown'] as const) {
            indexMode = mode;
            await page.goto('http://search.test/articles/?page=2');
            await expect
              .poll(() =>
                page
                  .locator('[data-search-state]')
                  .getAttribute('data-search-state'),
              )
              .toBe('failed');
            expect(await page.locator('.article-card').count()).toBe(2);
            expect(await page.locator('.result-count').textContent()).toContain(
              '預設第一頁',
            );
            indexMode = 'ok';
            await page
              .getByRole('button', { name: '重試', exact: true })
              .click();
            await ready();
            expect(
              await page.locator('.article-card-title').allTextContents(),
            ).toEqual(['展示文章 3']);
          }
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          expect(hydration).toEqual([]);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
        const noJs = await browser.newContext({ javaScriptEnabled: false });
        try {
          await noJs.route('**/*', (route) =>
            route.fulfill({
              status: 200,
              contentType: 'text/html',
              body: html,
            }),
          );
          const page = await noJs.newPage();
          await page.goto('http://search.test/articles/?page=2');
          expect(await page.locator('.article-card').count()).toBe(2);
          expect(await page.locator('noscript').textContent()).toContain(
            '預設第一頁',
          );
          expect(
            await page
              .locator('.article-card-title a')
              .first()
              .getAttribute('href'),
          ).toBe('/notes/ui-first/');
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
}, 120_000);
