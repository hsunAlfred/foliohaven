import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ArticleOptionsSchema,
  PublishedArticleMetaSchema,
  SiteConfigSchema,
} from '@foliohaven/core';
import type { ArticleOptions } from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';
import { chooseSettingsSection } from '../fixtures/studio/settings.js';

test.use({ viewport: { width: 1536, height: 1000 } });

type Environment = Awaited<ReturnType<typeof studioEnvironment>>;
const id = (number: number) => `published-${String(number).padStart(2, '0')}`;
const title = (number: number) =>
  `主題文章 ${String(number).padStart(2, '0')}${number === 25 ? ' needle' : ''}`;

async function prepare(environment: Environment, selected: string[]) {
  const articlePath = join(environment.root, 'content/articles/one/meta.json');
  const draft = JSON.parse(await readFile(articlePath, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(
    articlePath,
    JSON.stringify({ ...draft, title: '未發布的精選草稿' }),
  );
  for (let number = 1; number <= 25; number += 1) {
    const articleId = id(number);
    const directory = join(environment.root, 'content/articles', articleId);
    const date = `2026-01-${String(number).padStart(2, '0')}T00:00:00.000Z`;
    const meta = PublishedArticleMetaSchema.parse({
      ...draft,
      status: 'published',
      title: title(number),
      slug: articleId,
      publishedAt: date,
      updatedAt: date,
    });
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'meta.json'), JSON.stringify(meta));
    await writeFile(
      join(directory, 'content.html'),
      `<h2 id="intro">開始</h2><p>只供隔離測試的正文 ${articleId}。</p>`,
    );
  }
  const sitePath = join(environment.root, 'content/site.json');
  const site = SiteConfigSchema.parse(
    JSON.parse(await readFile(sitePath, 'utf8')),
  );
  await writeFile(
    sitePath,
    JSON.stringify({
      ...site,
      home: { ...site.home, featuredArticleIds: selected },
    }),
  );
  return { sitePath, before: await readFile(sitePath, 'utf8') };
}

function observe(page: Page) {
  const options: string[] = [];
  const fullArticles: string[] = [];
  const mutations: string[] = [];
  const bodies: Promise<ArticleOptions>[] = [];
  page.on('response', (response) => {
    if (response.request().method() !== 'GET' || response.status() !== 200)
      return;
    const url = new URL(response.url());
    if (url.pathname === '/api/v1/article-options') {
      options.push(response.url());
      bodies.push(
        response
          .json()
          .then((body: unknown) => ArticleOptionsSchema.parse(body)),
      );
    }
    if (url.pathname.startsWith('/api/v1/articles'))
      fullArticles.push(response.url());
  });
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      new URL(request.url()).pathname === '/api/v1/site-settings'
    )
      mutations.push(request.method());
  });
  return { options, fullArticles, mutations, bodies };
}

async function open(page: Page, environment: Environment) {
  await page.goto(`${environment.url}/#/settings`);
  await expect(page.getByLabel('網站名稱', { exact: true })).toBeEnabled();
  await page.getByLabel('網站名稱', { exact: true }).fill('未保存的設定緩衝');
  await chooseSettingsSection(page, 'home');
  await expect(page.getByLabel('選擇精選文章', { exact: true })).toBeEnabled();
}

function rows(page: Page) {
  return page.locator('.featured-article-list > li');
}

test('首頁精選一次讀取輕量選項，分頁搜尋與增刪重排不清空名稱或自動保存', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let releaseSearch = () => {};
  const searchHeld = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  let searchCaptured = false;
  try {
    const source = await prepare(environment, [id(1), id(3), id(5)]);
    const reads = observe(page);
    await open(page, environment);
    const featured = page.locator('.featured-articles');
    const names = rows(page).locator('.featured-article-name strong');
    await expect(names).toHaveText([title(1), title(3), title(5)]);
    await page.waitForLoadState('networkidle');
    expect(reads.options).toHaveLength(1);
    expect(reads.fullArticles).toEqual([]);
    const initial = await reads.bodies[0];
    expect(initial?.total).toBe(25);
    expect(initial?.items.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => id(25 - index)),
    );
    expect(initial?.selected.map((item) => item.id)).toEqual([
      id(1),
      id(3),
      id(5),
    ]);
    for (const option of [
      ...(initial?.items ?? []),
      ...(initial?.selected ?? []),
    ])
      expect(Object.keys(option).sort()).toEqual(['id', 'status', 'title']);
    await page
      .getByLabel('精選文章小字', { exact: true })
      .fill('未保存的精選小字');

    const beforeMove = reads.options.length;
    await rows(page)
      .first()
      .getByRole('button', { name: `將精選 ${title(1)} 往下移`, exact: true })
      .click();
    await expect(names).toHaveText([title(3), title(1), title(5)]);
    await page.waitForLoadState('networkidle');
    expect(reads.options).toHaveLength(beforeMove);

    await featured.getByRole('button', { name: '下一頁', exact: true }).click();
    await expect(
      featured.getByRole('navigation', { name: '分頁', exact: true }),
    ).toContainText('第 2／2 頁，共 25 筆');
    const select = page.getByLabel('選擇精選文章', { exact: true });
    await expect(select.locator('option').nth(1)).toHaveAttribute(
      'value',
      id(5),
    );
    await expect(names).toHaveText([title(3), title(1), title(5)]);

    await page.route('**/api/v1/article-options**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('q') === 'NEEDLE') {
        searchCaptured = true;
        await searchHeld;
      }
      await route.continue();
    });
    await page.getByLabel('搜尋已發布文章', { exact: true }).fill('NEEDLE');
    await featured.getByRole('button', { name: '搜尋', exact: true }).click();
    await expect.poll(() => searchCaptured).toBe(true);
    await expect(names).toHaveText([title(3), title(1), title(5)]);
    await expect(featured).not.toContainText('讀取文章名稱中…');
    releaseSearch();
    await expect(select).toBeEnabled();
    await expect(select.locator('option')).toHaveCount(2);
    await expect(select.locator('option').nth(1)).toHaveAttribute(
      'value',
      id(25),
    );
    await expect(names).toHaveText([title(3), title(1), title(5)]);
    const searchUrl = new URL(reads.options.at(-1) ?? environment.url);
    expect(searchUrl.searchParams.get('q')).toBe('NEEDLE');
    expect(searchUrl.searchParams.get('page')).toBe('1');
    expect(searchUrl.searchParams.get('sort')).toBe('published-desc');
    expect(searchUrl.searchParams.get('status')).toBe('published');

    const beforeAdd = reads.options.length;
    await select.selectOption(id(25));
    await featured
      .getByRole('button', { name: '加入精選', exact: true })
      .click();
    await expect(names).toHaveText([title(3), title(1), title(5), title(25)]);
    await expect(select).toBeEnabled();
    await page.waitForLoadState('networkidle');
    expect(reads.options).toHaveLength(beforeAdd + 1);
    const beforeRemove = reads.options.length;
    await rows(page)
      .nth(1)
      .getByRole('button', { name: `移除精選 ${title(1)}`, exact: true })
      .click();
    await expect(names).toHaveText([title(3), title(5), title(25)]);
    await expect(select).toBeEnabled();
    await page.waitForLoadState('networkidle');
    expect(reads.options).toHaveLength(beforeRemove + 1);
    const beforeLastMove = reads.options.length;
    await rows(page)
      .last()
      .getByRole('button', { name: `將精選 ${title(25)} 往上移`, exact: true })
      .click();
    await expect(names).toHaveText([title(3), title(25), title(5)]);
    await page.waitForLoadState('networkidle');
    expect(reads.options).toHaveLength(beforeLastMove);
    await Promise.all(reads.bodies);
    expect(reads.fullArticles).toEqual([]);
    expect(reads.mutations).toEqual([]);
    await expect(page.getByLabel('精選文章小字', { exact: true })).toHaveValue(
      '未保存的精選小字',
    );
    await chooseSettingsSection(page, 'general');
    await expect(page.getByLabel('網站名稱', { exact: true })).toHaveValue(
      '未保存的設定緩衝',
    );
    expect(await readFile(source.sitePath, 'utf8')).toBe(source.before);
  } finally {
    releaseSearch();
    await page.unrouteAll({ behavior: 'wait' });
    await environment.close();
  }
});

test('首頁精選保留草稿與失效識別，不在搜尋結果的已選名稱仍可讀取', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const source = await prepare(environment, [
      id(1),
      'one',
      'missing-article',
    ]);
    const reads = observe(page);
    await open(page, environment);
    const featured = page.locator('.featured-articles');
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(0).locator('strong')).toHaveText(title(1));
    await expect(rows(page).nth(1).locator('strong')).toHaveText(
      '未發布的精選草稿',
    );
    await expect(rows(page).nth(1).getByRole('alert')).toContainText('草稿');
    await expect(rows(page).nth(2).getByRole('alert')).toContainText('保留');
    await page.waitForLoadState('networkidle');
    expect(reads.options).toHaveLength(1);
    const response = await reads.bodies[0];
    expect(response?.selected).toEqual([
      { id: 'one', title: '未發布的精選草稿', status: 'draft' },
      { id: id(1), title: title(1), status: 'published' },
    ]);
    const selectedIds = new URL(
      reads.options[0] ?? environment.url,
    ).searchParams
      .get('selected')
      ?.split(',');
    expect(selectedIds).toEqual(['missing-article', 'one', id(1)]);
    const select = page.getByLabel('選擇精選文章', { exact: true });
    await expect(select.locator('option[value="one"]')).toHaveCount(0);
    await expect(select.locator('option[value="missing-article"]')).toHaveCount(
      0,
    );
    await page.getByLabel('搜尋已發布文章', { exact: true }).fill('needle');
    await featured.getByRole('button', { name: '搜尋', exact: true }).click();
    await expect(select).toBeEnabled();
    await expect(select.locator('option')).toHaveCount(2);
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(0).locator('strong')).toHaveText(title(1));
    await expect(rows(page).nth(1).getByRole('alert')).toContainText('草稿');
    await expect(rows(page).nth(2).getByRole('alert')).toContainText('保留');
    await Promise.all(reads.bodies);
    expect(reads.fullArticles).toEqual([]);
    expect(reads.mutations).toEqual([]);
    expect(await readFile(source.sitePath, 'utf8')).toBe(source.before);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await environment.close();
  }
});
