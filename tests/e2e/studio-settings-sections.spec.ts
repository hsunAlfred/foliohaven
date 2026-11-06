import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  PublishedArticleMetaSchema,
  SiteConfigSchema,
} from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';
import {
  chooseSettingsSection,
  settingsSections,
} from '../fixtures/studio/settings.js';

test.use({ viewport: { width: 1536, height: 1000 } });

type Environment = Awaited<ReturnType<typeof studioEnvironment>>;
function observePuts(page: Page) {
  const puts: { etag: string; body: unknown }[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === '/api/v1/site-settings'
    )
      puts.push({
        etag: request.headers()['if-match'] ?? '',
        body: request.postDataJSON() as unknown,
      });
  });
  return puts;
}
async function openSettings(page: Page, environment: Environment) {
  const loaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/v1/site-settings',
  );
  await page.goto(environment.url);
  const target = page.getByRole('button', { name: '全站設定', exact: true });
  if (!(await target.isVisible()))
    await page.getByRole('button', { name: '開啟導覽', exact: true }).click();
  await target.click();
  await expect(page.getByLabel('網站名稱', { exact: true })).toHaveValue(
    'HTTP測試網站',
  );
  const response = await loaded;
  expect(response.status()).toBe(200);
  const etag = (await response.headerValue('etag')) ?? '';
  expect(etag).toMatch(/^"[a-f0-9]{64}"$/u);
  return etag;
}
function summary(page: Page) {
  return page.getByRole('region', { name: /^設定有\d+項需要修正$/u });
}
function saveButton(page: Page) {
  return page.getByRole('button', { name: '保存全站設定', exact: true });
}
async function save(page: Page) {
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/v1/site-settings',
  );
  await saveButton(page).click();
  const response = await accepted;
  expect(response.status()).toBe(200);
  await expect(
    page.getByRole('status').filter({ hasText: /設定已保存/u }),
  ).toBeVisible();
  return SiteConfigSchema.parse(await response.json());
}
async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test('全站設定分區：鍵盤切換五區保留同一緩衝，最後一次真保存全部設定', async ({
  page,
}, testInfo) => {
  const environment = await studioEnvironment();
  try {
    const source = join(environment.root, 'content/site.json');
    const before = await readFile(source);
    const puts = observePuts(page);
    const initialEtag = await openSettings(page, environment);
    const url = page.url();
    const tabs = page.getByRole('tablist', {
      name: '全站設定區塊',
      exact: true,
    });
    await expect(tabs.getByRole('tab')).toHaveCount(5);
    await expect(page.locator('.settings-section-panel')).toHaveCount(5);
    await expect(page.locator('.settings-section-panel:visible')).toHaveCount(
      1,
    );
    await expect(
      page.getByLabel('設定區塊', { exact: true }),
    ).not.toBeVisible();
    for (const label of Object.values(settingsSections))
      await expect(
        tabs.getByRole('tab', { name: label, exact: true }),
      ).toHaveAccessibleName(label);

    const general = tabs.getByRole('tab', { name: '網站與作者', exact: true });
    const navigation = tabs.getByRole('tab', { name: '導覽', exact: true });
    const seo = tabs.getByRole('tab', { name: 'SEO 與社群分享', exact: true });
    const home = tabs.getByRole('tab', { name: '首頁與列表', exact: true });
    const rss = tabs.getByRole('tab', { name: 'RSS', exact: true });
    await page
      .getByLabel('網站名稱', { exact: true })
      .fill('跨區保存的網站名稱');
    await general.focus();
    await general.press('ArrowRight');
    await expect(navigation).toBeFocused();
    await expect(navigation).toHaveAttribute('aria-selected', 'true');
    await expect(navigation).toHaveAttribute('tabindex', '0');
    await expect(general).toHaveAttribute('tabindex', '-1');
    await page.getByRole('button', { name: '新增導覽', exact: true }).click();
    await page.getByLabel('導覽 1 名稱', { exact: true }).fill('跨區筆記');
    await page
      .getByLabel('導覽 1 連結', { exact: true })
      .fill('/category/notes/');
    await navigation.focus();
    await navigation.press('ArrowRight');
    await expect(seo).toBeFocused();
    await expect(seo).toHaveAttribute('aria-selected', 'true');
    await page
      .getByLabel('Default Meta Description', { exact: true })
      .fill('跨區保存的搜尋說明');
    await seo.focus();
    await seo.press('Home');
    await expect(general).toBeFocused();
    await expect(page.getByLabel('網站名稱', { exact: true })).toHaveValue(
      '跨區保存的網站名稱',
    );
    await general.press('End');
    await expect(rss).toBeFocused();
    await page
      .getByLabel('RSS 標題', { exact: true })
      .fill('跨區保存的訂閱標題');
    await rss.focus();
    await rss.press('ArrowLeft');
    await expect(home).toBeFocused();
    await page.getByLabel('分類每頁篇數', { exact: true }).fill('7');
    await expect(
      page.getByRole('tabpanel', { name: '首頁與列表', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.settings-section-panel:visible')).toHaveCount(
      1,
    );
    await expect(page).toHaveURL(url);
    expect(puts).toHaveLength(0);
    expect(await readFile(source)).toEqual(before);
    await expectNoOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath('desktop-home-section.png'),
      fullPage: true,
    });

    const saved = await save(page);
    expect(saved).toMatchObject({
      siteName: '跨區保存的網站名稱',
      navigation: [{ label: '跨區筆記', href: '/category/notes/' }],
      defaultSEO: { description: '跨區保存的搜尋說明' },
      pagination: { category: 7 },
      rss: { title: '跨區保存的訂閱標題' },
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.etag).toBe(initialEtag);
    expect(puts[0]?.body).toEqual(saved);
    expect(
      SiteConfigSchema.parse(JSON.parse(await readFile(source, 'utf8'))),
    ).toEqual(saved);
  } finally {
    await environment.close();
  }
});

test('全站設定分區：隱藏錯誤由摘要與拒存自動切區聚焦，動態導覽不丟其他內容', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const source = join(environment.root, 'content/site.json');
    const before = await readFile(source);
    const puts = observePuts(page);
    await openSettings(page, environment);
    await page
      .getByLabel('網站名稱', { exact: true })
      .fill('隱藏錯誤修正後保留的名稱');
    const url = page.getByLabel('網站網址', { exact: true });
    await url.fill('https://');
    await chooseSettingsSection(page, 'rss');
    await expect(url).not.toBeVisible();
    await saveButton(page).click();
    await expect(
      page.getByRole('tabpanel', { name: '網站與作者', exact: true }),
    ).toBeVisible();
    await expect(url).toBeFocused();
    expect(puts).toHaveLength(0);
    expect(await readFile(source)).toEqual(before);
    await url.fill('https://example.invalid/');
    await expect(summary(page)).toHaveCount(0);

    await chooseSettingsSection(page, 'navigation');
    await page.getByRole('button', { name: '新增導覽', exact: true }).click();
    const name = page.getByLabel('導覽 1 名稱', { exact: true });
    const link = page.getByLabel('導覽 1 連結', { exact: true });
    await link.fill('https://');
    const navigation = page.getByRole('tab', { name: '導覽', exact: true });
    await expect(navigation).toHaveAccessibleName('導覽');
    await expect(navigation).toHaveAccessibleDescription('2項需要修正');
    await chooseSettingsSection(page, 'seo');
    await summary(page)
      .getByRole('button', { name: /^導覽 1 名稱：/u })
      .click();
    await expect(
      page.getByRole('tabpanel', { name: '導覽', exact: true }),
    ).toBeVisible();
    await expect(name).toBeFocused();
    await name.fill('修正後的導覽');
    await chooseSettingsSection(page, 'home');
    await saveButton(page).click();
    await expect(
      page.getByRole('tabpanel', { name: '導覽', exact: true }),
    ).toBeVisible();
    await expect(link).toBeFocused();
    expect(puts).toHaveLength(0);
    expect(await readFile(source)).toEqual(before);
    await expect(name).toHaveValue('修正後的導覽');
    await expect(page.getByLabel('網站名稱', { exact: true })).toHaveValue(
      '隱藏錯誤修正後保留的名稱',
    );
    await link.fill('/category/notes/');
    await expect(summary(page)).toHaveCount(0);
    await chooseSettingsSection(page, 'rss');
    const saved = await save(page);
    expect(saved.siteName).toBe('隱藏錯誤修正後保留的名稱');
    expect(saved.navigation).toEqual([
      { label: '修正後的導覽', href: '/category/notes/' },
    ]);
    expect(puts).toHaveLength(1);
    expect(
      SiteConfigSchema.parse(JSON.parse(await readFile(source, 'utf8'))),
    ).toEqual(saved);
  } finally {
    await environment.close();
  }
});

test('全站設定分區手機：原生區塊選單保留錯誤數與跨區緩衝，320與390寬度可完成保存', async ({
  page,
}, testInfo) => {
  const environment = await studioEnvironment();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const source = join(environment.root, 'content/site.json');
    const before = await readFile(source);
    const puts = observePuts(page);
    await openSettings(page, environment);
    const select = page.getByLabel('設定區塊', { exact: true });
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('general');
    await expect(select.locator('option')).toHaveCount(5);
    await expect(
      page.getByRole('tablist', { name: '全站設定區塊', exact: true }),
    ).not.toBeVisible();
    await chooseSettingsSection(page, 'seo');
    await page
      .getByLabel('Default Meta Description', { exact: true })
      .fill('手機跨區保留的搜尋說明');
    await chooseSettingsSection(page, 'rss');
    await page.getByLabel('RSS 最多篇數', { exact: true }).fill('50');
    await chooseSettingsSection(page, 'general');
    await page
      .getByLabel('網站名稱', { exact: true })
      .fill('手機分區保存的名稱');
    const url = page.getByLabel('網站網址', { exact: true });
    await url.fill('https://');
    await expect(select.locator('option[value="general"]')).toHaveText(
      '網站與作者（1項需要修正）',
    );
    await chooseSettingsSection(page, 'rss');
    await saveButton(page).click();
    await expect(select).toHaveValue('general');
    await expect(url).toBeFocused();
    expect(puts).toHaveLength(0);
    expect(await readFile(source)).toEqual(before);
    await url.fill('https://example.invalid/');
    await expect(summary(page)).toHaveCount(0);
    await expect(select.locator('option[value="general"]')).toHaveText(
      '網站與作者',
    );
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await chooseSettingsSection(page, 'seo');
      await expect(
        page.getByLabel('Default Meta Description', { exact: true }),
      ).toHaveValue('手機跨區保留的搜尋說明');
      await chooseSettingsSection(page, 'rss');
      await expect(
        page.getByLabel('RSS 最多篇數', { exact: true }),
      ).toHaveValue('50');
      await expect(page.locator('.settings-section-panel')).toHaveCount(5);
      await expectNoOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`mobile-${width}-rss-section.png`),
        fullPage: true,
      });
    }
    const saved = await save(page);
    expect(saved).toMatchObject({
      siteName: '手機分區保存的名稱',
      defaultSEO: { description: '手機跨區保留的搜尋說明' },
      rss: { maxItems: 50 },
    });
    expect(puts).toHaveLength(1);
    expect(
      SiteConfigSchema.parse(JSON.parse(await readFile(source, 'utf8'))),
    ).toEqual(saved);
  } finally {
    await environment.close();
  }
});

test('全站設定分區API422：RSS保存後由摘要定位隱藏導覽錯誤，原緩衝與ETag保留並可真保存', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let rejectedOnce = false;
  try {
    const source = join(environment.root, 'content/site.json');
    const before = await readFile(source);
    const original = SiteConfigSchema.parse(JSON.parse(before.toString()));
    const puts = observePuts(page);
    const initialEtag = await openSettings(page, environment);
    await page
      .getByLabel('網站名稱', { exact: true })
      .fill('跨區422保留的網站名稱');
    await chooseSettingsSection(page, 'navigation');
    await page.getByRole('button', { name: '新增導覽', exact: true }).click();
    await page
      .getByLabel('導覽 1 名稱', { exact: true })
      .fill('跨區422筆記導覽');
    const link = page.getByLabel('導覽 1 連結', { exact: true });
    await link.fill('/category/notes/');
    await chooseSettingsSection(page, 'seo');
    await page
      .getByLabel('Default Meta Description', { exact: true })
      .fill('跨區422保留的搜尋摘要');
    await chooseSettingsSection(page, 'rss');
    await page
      .getByLabel('RSS 標題', { exact: true })
      .fill('跨區422保留的訂閱名稱');
    await expect(summary(page)).toHaveCount(0);
    await page.route('**/api/v1/site-settings', async (route) => {
      if (route.request().method() !== 'PUT' || rejectedOnce) {
        await route.continue();
        return;
      }
      rejectedOnce = true;
      await route.fulfill({
        status: 422,
        json: ApiErrorSchema.parse({
          error: {
            code: 'NAVIGATION_LINK_REJECTED',
            message: '隔離驗收：請重新確認導覽連結。',
            retryable: false,
            issues: [
              {
                path: ['navigation', 0, 'href'],
                code: 'custom',
                message: '請重新確認這個導覽連結。',
              },
            ],
            requestId: '11111111-1111-4111-8111-111111111111',
          },
        }),
      });
    });
    const rejected = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/v1/site-settings',
    );
    await saveButton(page).click();
    const response = await rejected;
    expect(response.status()).toBe(422);
    expect(
      ApiErrorSchema.parse(await response.json()).error.issues[0]?.path,
    ).toEqual(['navigation', 0, 'href']);
    await expect(
      page.getByRole('tabpanel', { name: 'RSS', exact: true }),
    ).toBeVisible();
    await expect(link).not.toBeVisible();
    await expect(summary(page)).toBeVisible();
    const navigation = page.getByRole('tab', { name: '導覽', exact: true });
    await expect(navigation.getByText('1', { exact: true })).toBeVisible();
    await expect(navigation).toHaveAccessibleName('導覽');
    await expect(navigation).toHaveAccessibleDescription('1項需要修正');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.etag).toBe(initialEtag);
    expect(SiteConfigSchema.safeParse(puts[0]?.body).success).toBe(true);
    expect(await readFile(source)).toEqual(before);
    const unchanged = await page.request.get(
      `${environment.url}/api/v1/site-settings`,
    );
    expect(unchanged.status()).toBe(200);
    expect(unchanged.headers()['etag']).toBe(initialEtag);
    expect(SiteConfigSchema.parse(await unchanged.json())).toEqual(original);

    await summary(page)
      .getByRole('button', { name: /^導覽 1 連結：/u })
      .click();
    await expect(
      page.getByRole('tabpanel', { name: '導覽', exact: true }),
    ).toBeVisible();
    await expect(link).toBeFocused();
    await expect(link).toHaveValue('/category/notes/');
    await expect(page.getByLabel('網站名稱', { exact: true })).toHaveValue(
      '跨區422保留的網站名稱',
    );
    await expect(
      page.getByLabel('Default Meta Description', { exact: true }),
    ).toHaveValue('跨區422保留的搜尋摘要');
    await expect(page.getByLabel('RSS 標題', { exact: true })).toHaveValue(
      '跨區422保留的訂閱名稱',
    );
    await link.fill('/');
    await expect(summary(page)).toHaveCount(0);
    await expect(navigation).toHaveAccessibleDescription('');
    await chooseSettingsSection(page, 'rss');
    const saved = await save(page);
    expect(saved).toMatchObject({
      siteName: '跨區422保留的網站名稱',
      defaultSEO: { description: '跨區422保留的搜尋摘要' },
      rss: { title: '跨區422保留的訂閱名稱' },
      navigation: [{ label: '跨區422筆記導覽', href: '/' }],
    });
    expect(puts).toHaveLength(2);
    expect(puts.map((put) => put.etag)).toEqual([initialEtag, initialEtag]);
    expect(
      SiteConfigSchema.parse(JSON.parse(await readFile(source, 'utf8'))),
    ).toEqual(saved);
  } finally {
    await page.unroute('**/api/v1/site-settings');
    await environment.close();
  }
});

test('全站設定初載只讀取一份設定，SEO不預抓首頁文章，開過的分區保留搜尋與緩衝', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const source = join(environment.root, 'content/site.json');
    const original = SiteConfigSchema.parse(
      JSON.parse(await readFile(source, 'utf8')),
    );
    const articlePath = join(
      environment.root,
      'content/articles/one/meta.json',
    );
    const article = PublishedArticleMetaSchema.parse({
      ...JSON.parse(await readFile(articlePath, 'utf8')),
      status: 'published',
      publishedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await writeFile(articlePath, JSON.stringify(article));
    await writeFile(
      source,
      JSON.stringify({
        ...original,
        home: { ...original.home, featuredArticleIds: ['one'] },
      }),
    );
    const before = await readFile(source);
    const siteReads: string[] = [];
    const articleReads: string[] = [];
    const optionReads: string[] = [];
    const puts = observePuts(page);
    page.on('response', (response) => {
      if (response.request().method() !== 'GET' || response.status() !== 200)
        return;
      const url = new URL(response.url());
      if (url.pathname === '/api/v1/site-settings')
        siteReads.push(response.url());
      if (url.pathname.startsWith('/api/v1/articles'))
        articleReads.push(response.url());
      if (url.pathname === '/api/v1/article-options')
        optionReads.push(response.url());
    });
    await page.goto(`${environment.url}/#/settings`);
    await expect(page.getByLabel('網站名稱', { exact: true })).toBeEnabled();
    await chooseSettingsSection(page, 'seo');
    await page.waitForLoadState('networkidle');
    expect(siteReads).toHaveLength(1);
    expect(articleReads).toEqual([]);
    expect(optionReads).toEqual([]);
    await expect(page.locator('.settings-section-panel')).toHaveCount(5);
    await expect(page.locator('.featured-articles')).toHaveCount(0);
    await expect(page.getByLabel('RSS 標題', { exact: true })).toHaveCount(0);
    await page
      .getByLabel('Default Meta Description', { exact: true })
      .fill('跨分區保留的SEO描述');
    await chooseSettingsSection(page, 'home');
    await expect(page.locator('.featured-article-name strong')).toHaveText(
      '文章',
    );
    await expect(
      page.getByLabel('選擇精選文章', { exact: true }),
    ).toBeEnabled();
    await page.waitForLoadState('networkidle');
    expect(articleReads).toEqual([]);
    expect(optionReads).toHaveLength(1);
    const optionsUrl = new URL(optionReads[0] ?? environment.url);
    expect(optionsUrl.searchParams.get('status')).toBe('published');
    expect(optionsUrl.searchParams.get('selected')).toBe('one');
    const loadedOptions = optionReads.length;
    await page
      .getByLabel('搜尋已發布文章', { exact: true })
      .fill('不應因切區而消失的搜尋文字');
    await page.getByLabel('文章總覽每頁篇數', { exact: true }).fill('7');
    await chooseSettingsSection(page, 'seo');
    await expect(
      page.getByLabel('Default Meta Description', { exact: true }),
    ).toHaveValue('跨分區保留的SEO描述');
    await expect(page.locator('.featured-articles')).toHaveCount(1);
    await chooseSettingsSection(page, 'home');
    await expect(
      page.getByLabel('搜尋已發布文章', { exact: true }),
    ).toHaveValue('不應因切區而消失的搜尋文字');
    await expect(
      page.getByLabel('文章總覽每頁篇數', { exact: true }),
    ).toHaveValue('7');
    await page.waitForLoadState('networkidle');
    expect(articleReads).toEqual([]);
    expect(optionReads).toHaveLength(loadedOptions);
    expect(siteReads).toHaveLength(1);
    expect(puts).toEqual([]);
    expect(await readFile(source)).toEqual(before);
  } finally {
    await environment.close();
  }
});

test('共用設定讀取失敗可重試，不顯示假預設；驗證可首次開啟RSS並聚焦且保留其他緩衝', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let rejectRead = true;
  const puts = observePuts(page);
  try {
    const source = join(environment.root, 'content/site.json');
    const before = await readFile(source);
    await page.route('**/api/v1/site-settings', async (route) => {
      const method = route.request().method();
      if (method === 'GET' && rejectRead) {
        await route.fulfill({
          status: 400,
          json: ApiErrorSchema.parse({
            error: {
              code: 'SITE_SETTINGS_UNAVAILABLE',
              message: '隔離驗收：全站設定讀取失敗。',
              retryable: false,
              issues: [],
              requestId: '11111111-1111-4111-8111-111111111111',
            },
          }),
        });
      } else if (method === 'PUT') {
        await route.fulfill({
          status: 422,
          json: ApiErrorSchema.parse({
            error: {
              code: 'RSS_SETTING_REJECTED',
              message: '隔離驗收：請重新確認RSS設定。',
              retryable: false,
              issues: [
                {
                  path: ['rss', 'maxItems'],
                  code: 'custom',
                  message: '請重新確認訂閱篇數。',
                },
              ],
              requestId: '11111111-1111-4111-8111-111111111111',
            },
          }),
        });
      } else await route.continue();
    });
    await page.goto(`${environment.url}/#/settings`);
    await expect(page.getByRole('alert')).toContainText(
      '隔離驗收：全站設定讀取失敗。',
    );
    await expect(page.getByLabel('網站名稱', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '保存全站設定', exact: true }),
    ).toHaveCount(0);
    rejectRead = false;
    const reloaded = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/site-settings' &&
        response.status() === 200,
    );
    await page
      .getByRole('button', { name: '重新讀取資料', exact: true })
      .click();
    expect((await reloaded).status()).toBe(200);
    const name = page.getByLabel('網站名稱', { exact: true });
    await expect(name).toHaveValue('HTTP測試網站');
    await expect(name).toBeEnabled();
    await name.fill('首次錯誤聚焦後仍保留的網站名稱');
    await expect(page.getByLabel('RSS 最多篇數', { exact: true })).toHaveCount(
      0,
    );
    const rejected = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/v1/site-settings',
    );
    await saveButton(page).click();
    expect((await rejected).status()).toBe(422);
    await summary(page)
      .getByRole('button', { name: /^RSS 最多篇數：/u })
      .click();
    await expect(
      page.getByRole('tabpanel', { name: 'RSS', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel('RSS 最多篇數', { exact: true }),
    ).toBeFocused();
    await expect(
      page.getByLabel('RSS 最多篇數', { exact: true }),
    ).toHaveAttribute('aria-invalid', 'true');
    await chooseSettingsSection(page, 'general');
    await expect(name).toHaveValue('首次錯誤聚焦後仍保留的網站名稱');
    expect(puts).toHaveLength(1);
    expect(await readFile(source)).toEqual(before);
  } finally {
    await page.unroute('**/api/v1/site-settings');
    await environment.close();
  }
});
