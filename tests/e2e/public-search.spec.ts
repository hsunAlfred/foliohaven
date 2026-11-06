import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createStaticPreview } from '@foliohaven/server';
import { parseSearchQuery, searchPageViewModel } from '@foliohaven/core';
import { publicSiteExpected } from '../fixtures/public-site/assertions.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
let preview: ReturnType<typeof createStaticPreview>;
let expected: Awaited<ReturnType<typeof publicSiteExpected>>;
let base: string;
test.beforeAll(async () => {
  expected = await publicSiteExpected(repositoryRoot);
  preview = createStaticPreview({ repositoryRoot });
  base = (await preview.listen({ port: 0 })).url;
});
test.afterAll(async () => {
  await preview?.close();
  await expected?.cleanup();
});

test('ordinary public search combines keyword, category and Tag and restores URL controls', async ({
  page,
}) => {
  const model = expected.model.listPages.find(
    (item) => item.kind === 'articles',
  );
  const document = expected.model.searchIndex.articles.find(
    (item) => item.tags.length > 0,
  );
  if (!model || !document || !document.tags[0])
    throw new Error(
      'The neutral release examples require one tagged published article.',
    );
  await page.goto(new URL('/articles/', base).href);
  await expect(page.locator('[data-search-state]')).toHaveAttribute(
    'data-search-state',
    'ready',
  );
  await page.getByText('分類與 Tag 篩選', { exact: true }).click();
  await page
    .locator(
      `input[name="category"][value=${JSON.stringify(document.category.path)}]`,
    )
    .check();
  await page
    .locator(
      `input[name="tag"][value=${JSON.stringify(document.tags[0].slug)}]`,
    )
    .check();
  await page.getByRole('searchbox', { name: '關鍵字' }).fill(document.title);
  await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('category'))
    .toBe(document.category.path);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('tag'))
    .toBe(document.tags[0].slug);
  const selectedUrl = page.url();
  const result = searchPageViewModel(
    model,
    expected.model.searchIndex.articles,
    parseSearchQuery(new URL(selectedUrl).search),
  );
  await expect(page.locator('main .article-card-title a')).toHaveText(
    result.model.articles.map((item) => item.title),
  );
  await page.getByRole('link', { name: '清除搜尋與篩選' }).click();
  await expect(page).toHaveURL(new URL('/articles/', base).href);
  await page.goBack();
  await expect(page).toHaveURL(selectedUrl);
  await expect(
    page.locator(
      `input[name="category"][value=${JSON.stringify(document.category.path)}]`,
    ),
  ).toBeChecked();
  await expect(
    page.locator(
      `input[name="tag"][value=${JSON.stringify(document.tags[0].slug)}]`,
    ),
  ).toBeChecked();
  await expect(page.locator('main .article-card-title a')).toHaveText(
    result.model.articles.map((item) => item.title),
  );
});

test('article code enhancement copies the original text and keeps a keyboard scroll target', async ({
  page,
}) => {
  const article = expected.model.articlePages.find((item) =>
    /<pre[\s>]/u.test(item.contentHtml),
  );
  if (!article) throw new Error('The neutral examples require a code block.');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (
            window as typeof window & { copiedArticleText?: string }
          ).copiedArticleText = text;
        },
      },
    });
  });
  await page.goto(new URL(article.url, base).href);
  const block = page.locator('.code-block').first();
  await expect(block).toBeVisible();
  const original = await block.locator('pre code').textContent();
  await expect(block.locator('pre')).toHaveAttribute('tabindex', '0');
  await block.getByRole('button', { name: /複製 .* 程式碼/u }).click();
  await expect(block.getByRole('status')).toHaveText('程式碼已複製');
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { copiedArticleText?: string })
          .copiedArticleText,
    ),
  ).toBe(original);
});

test('the article reading module enhances real SSR outline links without hydration', async ({
  page,
}) => {
  const article = expected.model.articlePages.find(
    (item) => item.toc.length >= 3,
  );
  if (!article)
    throw new Error('The neutral examples require an article outline.');
  await page.goto(new URL(article.url, base).href);
  await expect(page.locator('astro-island')).toHaveCount(0);
  const links = page.locator('[data-reading-toc-link]');
  const link = links.last();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  if (!href) throw new Error('The SSR outline link requires a fragment.');
  const destination = new URL(href, new URL(article.url, base));
  await link.click();
  await expect(page).toHaveURL(destination.href);
  await expect(
    page.locator(
      `[id=${JSON.stringify(decodeURIComponent(destination.hash.slice(1)))}]`,
    ),
  ).toBeInViewport();
  await expect(link).toHaveAttribute('aria-current', 'location');
});
