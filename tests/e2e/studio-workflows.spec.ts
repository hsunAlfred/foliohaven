import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import type { FileLease } from '../../server/dist/runtime/lease.js';
import {
  ArticleMetaSchema,
  CurrentArtifactSchema,
  JobSchema,
  PreviewResponseSchema,
  SiteConfigSchema,
  TaxonomySchema,
} from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';
import { chooseSettingsSection } from '../fixtures/studio/settings.js';

test.use({ viewport: { width: 1536, height: 1000 } });

async function closeDetail(page: Page) {
  const dialogs = page.locator('dialog[open]');
  while ((await dialogs.count()) > 0) {
    await dialogs.last().getByRole('button', { name: /^關閉/ }).first().click();
    await expect(dialogs).toHaveCount(0);
  }
}
async function navigate(page: Page, label: string) {
  await closeDetail(page);
  const target = page.getByRole('button', { name: label, exact: true });
  if (!(await target.isVisible()))
    await page.getByRole('button', { name: '開啟導覽', exact: true }).click();
  await target.click();
}
async function confirm(
  page: Page,
  action: () => Promise<unknown>,
  accept = true,
) {
  const dialog = page
    .waitForEvent('dialog')
    .then((value) => (accept ? value.accept() : value.dismiss()));
  await action();
  await dialog;
}
async function html(page: Page, value: string) {
  const editor = page.getByRole('textbox', { name: 'HTML 正文', exact: true });
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(value);
}
async function openOne(page: Page) {
  await page.locator('tr[data-article-id] .article-title-button').click();
}
async function readJson(
  root: string,
  path: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, path), 'utf8')) as Record<
    string,
    unknown
  >;
}

test('Studio衝突、未保存提醒、IDE唯讀、共用樣式與最新預覽', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(environment.url);
    await openOne(page);
    const original =
      '<h2 id="local">本機尚未保存</h2>\n<p>保留 &amp; 原文。</p>';
    await html(page, original);
    await confirm(page, () => navigate(page, '全站設定'), false);
    await expect(
      page.getByRole('textbox', { name: 'HTML 正文', exact: true }),
    ).toContainText('本機尚未保存');
    const disk = await readJson(
      environment.root,
      'content/articles/one/meta.json',
    );
    await writeFile(
      join(environment.root, 'content/articles/one/meta.json'),
      JSON.stringify({ ...disk, title: '外部編輯版本' }),
    );
    await page
      .getByRole('button', { name: '保存目前內容', exact: true })
      .click();
    const conflict = page.getByRole('region', { name: '版本衝突' });
    await expect(conflict).toBeVisible();
    await expect(
      conflict.getByRole('heading', { name: '開始編輯時' }),
    ).toBeVisible();
    await expect(
      conflict.getByRole('heading', { name: '尚未保存' }),
    ).toBeVisible();
    await expect(conflict.locator('pre').last()).toContainText('外部編輯版本');
    await expect(
      page.getByRole('textbox', { name: 'HTML 正文', exact: true }),
    ).toContainText('本機尚未保存');
    await confirm(page, () =>
      page.getByRole('button', { name: '保留我的內容繼續編輯' }).click(),
    );
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' && r.url().endsWith('/articles/one'),
    );
    await page
      .getByRole('button', { name: '保存目前內容', exact: true })
      .click();
    expect((await saved).status()).toBe(200);
    expect(
      await readFile(
        join(environment.root, 'content/articles/one/content.html'),
        'utf8',
      ),
    ).toBe(original);
    if ((await page.locator('.workspace-extra').getAttribute('open')) === null)
      await page.locator('.workspace-extra > summary').click();
    await page
      .getByRole('button', { name: '切換 IDE 模式', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: '保存目前內容', exact: true }),
    ).toBeDisabled();
    await expect(page.locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await page
      .getByRole('button', { name: '切換 Studio 模式', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: '保存目前內容', exact: true }),
    ).toBeEnabled();
    const editorIds: string[] = [];
    let requests = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/previews', async (route) => {
      editorIds.push(route.request().headers()['x-foliohaven-editor-id'] ?? '');
      const index = ++requests;
      const response = await route.fetch();
      if (index === 1) await gate;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await html(page, '<h2 id="old">較舊預覽</h2>');
    await expect.poll(() => requests).toBe(1);
    await html(
      page,
      '<h2 id="new">最新預覽</h2><script>window.__studioProbe=1</script>',
    );
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
    const frame = page.frameLocator('iframe[title="文章即時預覽"]');
    await expect(
      frame.getByRole('heading', { name: '最新預覽', exact: true }),
    ).toBeVisible();
    release?.();
    await expect(
      frame.getByRole('heading', { name: '最新預覽', exact: true }),
    ).toBeVisible();
    expect(new Set(editorIds).size).toBe(1);
    expect(editorIds[0]).toMatch(/^[\da-f-]{36}$/);
    const preview = page
      .frames()
      .find(
        (value) =>
          value.url().includes('/previews/') &&
          value.url().endsWith('/document'),
      );
    expect(preview).toBeTruthy();
    expect(
      await preview?.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--color-text')
          .trim(),
      ),
    ).toBe('#182a38');
    expect(
      await preview?.evaluate(() => Object.hasOwn(window, '__studioProbe')),
    ).toBe(false);
    await expect(page.locator('iframe')).toHaveAttribute('sandbox', '');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await environment.stopService();
    if ((await page.locator('.workspace-extra').getAttribute('open')) === null)
      await page.locator('.workspace-extra > summary').click();
    await page
      .getByRole('button', { name: '重新檢查工作區', exact: true })
      .click();
    await expect(
      page.getByText('連線異常 · 暫停寫入', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole('textbox', { name: 'HTML 正文', exact: true }),
    ).toContainText('最新預覽');
  } finally {
    await environment.close();
  }
});

test('Studio從IDE切回後刷新分類、Tag與正式文章網址', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    const meta = ArticleMetaSchema.parse({
      ...(await readJson(environment.root, 'content/articles/one/meta.json')),
      status: 'published',
      publishedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await writeFile(
      join(environment.root, 'content/articles/one/meta.json'),
      JSON.stringify(meta),
    );
    await page.goto(environment.url);
    await openOne(page);
    const articleUrl = page.getByRole('link', {
      name: '正式網站網址',
      exact: true,
    });
    await expect(articleUrl).toHaveAttribute(
      'href',
      'https://example.invalid/notes/one/',
    );
    await expect(
      page.getByRole('link', { name: '成功建置預覽', exact: true }),
    ).toHaveCount(0);
    if ((await page.locator('.workspace-extra').getAttribute('open')) === null)
      await page.locator('.workspace-extra > summary').click();
    await page
      .getByRole('button', { name: '切換 IDE 模式', exact: true })
      .click();
    await expect(page.locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    const taxonomy = TaxonomySchema.parse({
      categories: JSON.parse(
        await readFile(
          join(environment.root, 'content/categories.json'),
          'utf8',
        ),
      ),
      tags: JSON.parse(
        await readFile(join(environment.root, 'content/tags.json'), 'utf8'),
      ),
    });
    await writeFile(
      join(environment.root, 'content/categories.json'),
      JSON.stringify(
        taxonomy.categories.map((item) =>
          item.path === 'notes' ? { ...item, name: 'IDE更新筆記' } : item,
        ),
      ),
    );
    await writeFile(
      join(environment.root, 'content/tags.json'),
      JSON.stringify(
        taxonomy.tags.map((item) =>
          item.slug === 'example' ? { ...item, name: 'IDE更新範例' } : item,
        ),
      ),
    );
    const site = SiteConfigSchema.parse(
      await readJson(environment.root, 'content/site.json'),
    );
    await writeFile(
      join(environment.root, 'content/site.json'),
      JSON.stringify({
        ...site,
        siteUrl: 'https://ide.example.invalid/',
        timeZone: 'UTC',
      }),
    );
    await page
      .getByRole('button', { name: '切換 Studio 模式', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: '保存目前內容', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByLabel('分類', { exact: true }).locator('option[value="notes"]'),
    ).toHaveText('IDE更新筆記');
    await expect(
      page
        .getByRole('list', { name: '文章已選 Tag', exact: true })
        .getByText('IDE更新範例', { exact: true }),
    ).toBeVisible();
    await expect(articleUrl).toHaveAttribute(
      'href',
      'https://ide.example.invalid/notes/one/',
    );
    await expect(articleUrl).toHaveAttribute('target', '_blank');
    const publicAddress = 'https://ide.example.invalid/notes/one/';
    await page.context().route(publicAddress, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><meta charset="utf-8"><title>更新後正式網址</title>',
      }),
    );
    const opened = page.waitForEvent('popup');
    await articleUrl.click();
    const target = await opened;
    try {
      await expect(target).toHaveURL(publicAddress);
      await expect(target).toHaveTitle('更新後正式網址');
    } finally {
      await target.close();
      await page.context().unroute(publicAddress);
    }
  } finally {
    await environment.close();
  }
});

test('Studio分類設定、完整網站表單與分類遷移', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(environment.url);
    await navigate(page, '分類與 Tag');
    await page.getByRole('button', { name: '新增分類', exact: true }).click();
    const group = page.getByRole('dialog', { name: '新增分類', exact: true });
    await group.getByLabel('分類網址名稱', { exact: true }).fill('notes');
    await expect(
      group.getByLabel('分類網址名稱', { exact: true }),
    ).toBeEnabled();
    await group.getByLabel('分類網址名稱', { exact: true }).fill('guides');
    await confirm(
      page,
      () =>
        group
          .getByRole('button', { name: '關閉新增分類', exact: true })
          .click(),
      false,
    );
    await expect(group.getByLabel('分類網址名稱', { exact: true })).toHaveValue(
      'guides',
    );
    await group.getByLabel('分類名稱', { exact: true }).fill('指南');
    await group
      .getByLabel('分類描述', { exact: true })
      .fill('完整分類設定驗收');
    await group.getByLabel('SEO Title', { exact: true }).fill('指南分類');
    await group
      .getByLabel('Meta Description', { exact: true })
      .fill('指南分類的搜尋說明');
    await group.getByLabel('Indexing', { exact: true }).selectOption('false');
    await group.getByRole('button', { name: '保存分類', exact: true }).click();
    await expect(group).not.toBeVisible();
    await page.getByRole('tab', { name: /^Tag/ }).click();
    await page.getByRole('button', { name: '新增 Tag', exact: true }).click();
    const tag = page.getByRole('dialog', { name: '新增 Tag', exact: true });
    await tag.getByLabel('Tag 網址名稱', { exact: true }).fill('tutorial');
    await tag.getByLabel('Tag 名稱', { exact: true }).fill('教學');
    await tag.getByLabel('Tag 描述', { exact: true }).fill('教學資料');
    await tag.getByRole('button', { name: '保存 Tag', exact: true }).click();
    await expect(tag).not.toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: '已保存' }),
    ).toBeVisible();
    const categories = JSON.parse(
      await readFile(join(environment.root, 'content/categories.json'), 'utf8'),
    ) as { path: string; seo: { index: boolean } }[];
    expect(categories.find((value) => value.path === 'guides')?.seo.index).toBe(
      false,
    );
    await navigate(page, '全站設定');
    await page.getByLabel('網站名稱', { exact: true }).fill('Studio驗收網站');
    await page.getByLabel('網站描述', { exact: true }).fill('網站表單保存驗收');
    await page.getByLabel('作者名稱', { exact: true }).fill('Studio作者');
    await page
      .getByLabel('作者網址', { exact: true })
      .fill('https://example.invalid/author/');
    await chooseSettingsSection(page, 'navigation');
    await page.getByRole('button', { name: '新增導覽', exact: true }).click();
    await page.getByLabel('導覽 1 名稱', { exact: true }).fill('筆記');
    await page
      .getByLabel('導覽 1 連結', { exact: true })
      .fill('/category/notes/');
    await chooseSettingsSection(page, 'seo');
    await page
      .getByLabel('SEO Title Template', { exact: true })
      .fill('%s | Studio驗收網站');
    await page
      .getByLabel('Default Meta Description', { exact: true })
      .fill('全站SEO說明');
    await page.getByLabel('Twitter / X Site', { exact: true }).fill('@studio');
    await page
      .getByLabel('Google Search Console Verification', { exact: true })
      .fill('synthetic-verification');
    await chooseSettingsSection(page, 'home');
    await page.getByLabel('分類每頁篇數', { exact: true }).fill('3');
    await page.getByLabel('Tag 每頁篇數', { exact: true }).fill('4');
    await page.getByLabel('文章總覽每頁篇數', { exact: true }).fill('5');
    await page.getByLabel('首頁最新文章篇數', { exact: true }).fill('6');
    await chooseSettingsSection(page, 'rss');
    await page.getByLabel('RSS 標題', { exact: true }).fill('Studio RSS');
    await page.getByLabel('RSS 描述', { exact: true }).fill('RSS表單驗收');
    await page.getByLabel('RSS 最多篇數', { exact: true }).fill('30');
    await page
      .getByRole('button', { name: '保存全站設定', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: '已保存' }),
    ).toBeVisible();
    expect(await readJson(environment.root, 'content/site.json')).toMatchObject(
      {
        siteName: 'Studio驗收網站',
        pagination: { category: 3, tag: 4, articles: 5 },
        rss: { title: 'Studio RSS', maxItems: 30 },
        navigation: [{ href: '/category/notes/' }],
      },
    );
    await navigate(page, '分類與 Tag');
    // 未引用的分類可刪除；被草稿引用的分類必須明確拒絕。
    await page.getByRole('button', { name: '指南', exact: true }).click();
    await confirm(page, () =>
      page.getByRole('button', { name: '移除此分類', exact: true }).click(),
    );
    await expect(
      page.getByRole('dialog', { name: '編輯分類', exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: '已保存' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '筆記', exact: true }).click();
    await confirm(page, () =>
      page.getByRole('button', { name: '移除此分類', exact: true }).click(),
    );
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    expect(
      (
        JSON.parse(
          await readFile(
            join(environment.root, 'content/categories.json'),
            'utf8',
          ),
        ) as { path: string }[]
      ).some((value) => value.path === 'notes'),
    ).toBe(true);
    await confirm(page, () =>
      page.getByRole('button', { name: '關閉編輯分類', exact: true }).click(),
    );
    await page.getByText('修改分類或 Tag 網址', { exact: true }).click();
    await page
      .getByLabel('要變更的項目', { exact: true })
      .selectOption('notes');
    await page.getByLabel('新的網址名稱', { exact: true }).fill('journal');
    await page
      .getByRole('button', { name: '查看變更影響', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: '確認網址變更' }),
    ).toBeVisible();
    await expect(
      page.getByText('將更新文章 1 篇、分類 1 筆、導覽連結 1 筆。', {
        exact: true,
      }),
    ).toBeVisible();
    await confirm(page, () =>
      page.getByRole('button', { name: '確認變更網址', exact: true }).click(),
    );
    await expect(
      page.getByRole('heading', { name: '工作詳細資料' }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('definition')
        .filter({ hasText: '分類／Tag 網址調整 · 成功' }),
    ).toBeVisible({ timeout: 15000 });
    expect(
      await readJson(environment.root, 'content/articles/one/meta.json'),
    ).toMatchObject({ category: 'journal' });
    expect(await readJson(environment.root, 'content/site.json')).toMatchObject(
      { navigation: [{ href: '/category/journal/' }] },
    );
  } finally {
    await environment.close();
  }
});

test('Studio真圖片上傳、處理、引用與引用保護', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    const require = createRequire(join(process.cwd(), 'server/package.json'));
    const sharp = require('sharp') as NativeImageFactory;
    const bytes = await sharp({
      create: { width: 90, height: 60, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    await page.goto(environment.url);
    await navigate(page, '媒體庫');
    await page.getByRole('button', { name: '上傳媒體', exact: true }).click();
    await page.getByLabel('選擇媒體檔案', { exact: true }).setInputFiles({
      name: 'studio-image.png',
      mimeType: 'image/png',
      buffer: bytes,
    });
    await page
      .getByLabel('上傳顯示名稱（選填）', { exact: true })
      .fill('Studio圖片');
    await page
      .getByRole('dialog', { name: '上傳媒體', exact: true })
      .getByRole('button', { name: '上傳媒體', exact: true })
      .click();
    await expect(page.getByLabel('媒體顯示名稱', { exact: true })).toHaveValue(
      'Studio圖片',
    );
    await page.getByRole('button', { name: '處理媒體', exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: '媒體處理進度', exact: true })
        .getByText('處理完成', { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await page
      .getByRole('button', { name: '關閉媒體設定與引用', exact: true })
      .click();
    await page.getByRole('button', { name: 'Studio圖片', exact: true }).click();
    await page
      .getByLabel('此次圖片引用的 Alt', { exact: true })
      .fill('測試 "引用"');
    const markup = await page
      .getByLabel('可複製媒體 HTML', { exact: true })
      .inputValue();
    expect(markup).toContain('alt="測試 &quot;引用&quot;"');
    expect(markup).toContain('width="90"');
    expect(markup).toContain('srcset=');
    await expect(page.getByRole('img', { name: '媒體處理預覽' })).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole('img', { name: '媒體處理預覽' })
          .evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    const sourceId = markup.match(/\/media\/([^/]+)\//)?.[1];
    expect(sourceId).toBeTruthy();
    await writeFile(
      join(environment.root, 'content/articles/one/content.html'),
      `<h2 id="image">圖片引用</h2>${markup}`,
    );
    await page.locator('.media-danger > summary').click();
    await confirm(page, () =>
      page.getByRole('button', { name: '刪除媒體', exact: true }).click(),
    );
    await expect(
      page.getByRole('alert').filter({ hasText: 'MEDIA_IN_USE' }),
    ).toBeVisible();
    await writeFile(
      join(environment.root, 'content/articles/one/content.html'),
      '<h2 id="image">已移除圖片引用</h2>',
    );
    await confirm(page, () =>
      page.getByRole('button', { name: '刪除媒體', exact: true }).click(),
    );
    await expect(
      page.getByRole('button', { name: 'Studio圖片', exact: true }),
    ).toHaveCount(0);
  } finally {
    await environment.close();
  }
});

test('Studio Build成功、失敗保留舊dist、取消及安全重試', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(environment.url);
    await navigate(page, '網站更新與工作');
    await closeDetail(page);
    await page.getByRole('button', { name: '更新網站', exact: true }).click();
    const detail = page.getByRole('dialog', {
      name: '工作詳細資料',
      exact: true,
    });
    await expect(
      detail.getByRole('definition').filter({ hasText: '網站更新 · 成功' }),
    ).toBeVisible({ timeout: 15000 });
    const previous = await readFile(
      join(environment.root, 'dist/index.html'),
      'utf8',
    );
    environment.setBuildMode('failure');
    await closeDetail(page);
    await page.getByRole('button', { name: '更新網站', exact: true }).click();
    await expect(
      detail.getByRole('definition').filter({ hasText: '網站更新 · 失敗' }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText('這次更新未完成，網站仍保留上次成功的版本。', {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await readFile(join(environment.root, 'dist/index.html'), 'utf8'),
    ).toBe(previous);
    environment.setBuildMode('success');
    const retryAccepted = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/build-jobs') &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: '以最新保存的內容重試', exact: true })
      .click();
    const retryResponse = await retryAccepted;
    expect(retryResponse.status()).toBe(202);
    const retryJob = JobSchema.parse(await retryResponse.json());
    await expect(page).toHaveURL(new RegExp(`/jobs/${retryJob.id}$`));
    await expect(
      detail.getByRole('definition').filter({ hasText: '網站更新 · 成功' }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page
        .getByRole('region', { name: '網站狀態' })
        .getByText(/1 個頁面、1 個檔案/),
    ).toBeVisible();
    environment.setBuildMode('wait');
    await closeDetail(page);
    await page.getByRole('button', { name: '更新網站', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '取消此工作', exact: true }),
    ).toBeVisible();
    await confirm(page, () =>
      page.getByRole('button', { name: '取消此工作', exact: true }).click(),
    );
    await expect(
      detail.getByRole('definition').filter({ hasText: '網站更新 · 已取消' }),
    ).toBeVisible({ timeout: 15000 });
    expect(
      await readFile(join(environment.root, 'dist/index.html'), 'utf8'),
    ).toBe(previous);
  } finally {
    await environment.close();
  }
});

test('Studio重試先守住查詢與父Build請求，回應遺失只沿原key重送', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let releaseLookup: (() => void) | undefined;
  let releasePost: (() => void) | undefined;
  try {
    environment.setBuildMode('failure');
    await page.goto(environment.url);
    await navigate(page, '網站更新與工作');
    await closeDetail(page);
    await page.getByRole('button', { name: '更新網站', exact: true }).click();
    await expect(
      page.getByRole('definition').filter({ hasText: '網站更新 · 失敗' }),
    ).toBeVisible();
    environment.setBuildMode('success');
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let lookupCount = 0;
    const keys: string[] = [];
    const bodies: string[] = [];
    const acceptedIds: string[] = [];
    await page.route('**/api/v1/jobs/*/retry-input', async (route) => {
      lookupCount++;
      await lookupGate;
      await route.continue().catch(() => undefined);
    });
    await page.route('**/api/v1/build-jobs', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      bodies.push(route.request().postData() ?? '');
      const response = await route.fetch();
      acceptedIds.push(JobSchema.parse(await response.json()).id);
      if (keys.length === 1) {
        await postGate;
        await route
          .fulfill({
            status: 202,
            headers: {
              'content-type': 'application/json',
              location: response.headers()['location'] ?? '',
            },
            body: '{"truncated":',
          })
          .catch(() => undefined);
      } else await route.fulfill({ response }).catch(() => undefined);
    });
    const retry = page.getByRole('button', {
      name: '以最新保存的內容重試',
      exact: true,
    });
    await retry.evaluate((element: HTMLButtonElement) => {
      for (let index = 0; index < 8; index++) element.click();
    });
    await expect.poll(() => lookupCount).toBeGreaterThan(0);
    await expect(retry, '等待retry-input時便須同步禁止重入').toBeDisabled();
    expect(lookupCount).toBe(1);
    releaseLookup?.();
    await expect.poll(() => acceptedIds.length).toBe(1);
    await expect(
      retry,
      '父Build請求尚未回應，子重試按鈕必須一起停用',
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '更新網站', exact: true }),
    ).toBeDisabled();
    releasePost?.();
    const resend = page.getByRole('button', {
      name: '重試這次操作',
      exact: true,
    });
    await expect(resend).toBeVisible();
    await expect(retry, '未知提交結果時不能建立新key的重試').toBeDisabled();
    await confirm(
      page,
      () => page.getByRole('button', { name: '結束重試', exact: true }).click(),
      false,
    );
    await expect(resend).toBeVisible();
    await resend.evaluate((element: HTMLButtonElement) => {
      for (let index = 0; index < 8; index++) element.click();
    });
    await expect.poll(() => acceptedIds.length).toBe(2);
    await expect(
      page.getByRole('definition').filter({ hasText: '網站更新 · 成功' }),
    ).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(acceptedIds[1]).toBe(acceptedIds[0]);
    const collection = await page.request.get(
      `${environment.url}/api/v1/jobs?type=build&pageSize=100`,
    );
    expect(collection.status()).toBe(200);
    expect(((await collection.json()) as { total: number }).total).toBe(2);
  } finally {
    releaseLookup?.();
    releasePost?.();
    await environment.close();
  }
});

test('Studio媒體重試在查詢及未知提交期間守門並保留同key', async ({ page }) => {
  const environment = await studioEnvironment();
  const leases: FileLease[] = [];
  let releaseLookup: (() => void) | undefined;
  let releasePost: (() => void) | undefined;
  try {
    const require = createRequire(join(process.cwd(), 'server/package.json'));
    const sharp = require('sharp') as NativeImageFactory;
    const bytes = await sharp({
      create: { width: 40, height: 24, channels: 3, background: '#294d70' },
    })
      .png()
      .toBuffer();
    await page.goto(environment.url);
    await navigate(page, '媒體庫');
    await page.getByRole('button', { name: '上傳媒體', exact: true }).click();
    await page.getByLabel('選擇媒體檔案', { exact: true }).setInputFiles({
      name: 'retry-image.png',
      mimeType: 'image/png',
      buffer: bytes,
    });
    await page
      .getByRole('dialog', { name: '上傳媒體', exact: true })
      .getByRole('button', { name: '上傳媒體', exact: true })
      .click();
    await expect(
      page.getByLabel('媒體顯示名稱', { exact: true }),
    ).toBeVisible();
    const { acquireMediaSlot } =
      await import('../../server/dist/media/index.js');
    leases.push(await acquireMediaSlot(environment.root, 'image', 10_000));
    leases.push(await acquireMediaSlot(environment.root, 'image', 10_000));
    await page.getByRole('button', { name: '處理媒體', exact: true }).click();
    await page.getByRole('button', { name: '查看工作', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '取消此工作', exact: true }),
    ).toBeVisible();
    await confirm(page, () =>
      page.getByRole('button', { name: '取消此工作', exact: true }).click(),
    );
    await expect(
      page.getByRole('definition').filter({ hasText: '媒體處理 · 已取消' }),
    ).toBeVisible();
    for (const lease of leases) await lease.release();
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let lookupCount = 0;
    const keys: string[] = [];
    const bodies: string[] = [];
    const acceptedIds: string[] = [];
    await page.route('**/api/v1/jobs/*/retry-input', async (route) => {
      lookupCount++;
      await lookupGate;
      await route.continue().catch(() => undefined);
    });
    await page.route('**/api/v1/media-jobs', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      bodies.push(route.request().postData() ?? '');
      const response = await route.fetch();
      acceptedIds.push(JobSchema.parse(await response.json()).id);
      if (keys.length === 1) {
        await postGate;
        await route
          .fulfill({
            status: 202,
            contentType: 'application/json',
            body: '{"truncated":',
          })
          .catch(() => undefined);
      } else await route.fulfill({ response }).catch(() => undefined);
    });
    const retry = page.getByRole('button', {
      name: '以最新保存的內容重試',
      exact: true,
    });
    await retry.evaluate((element: HTMLButtonElement) => {
      for (let index = 0; index < 8; index++) element.click();
    });
    await expect.poll(() => lookupCount).toBe(1);
    await expect(retry).toBeDisabled();
    releaseLookup?.();
    await expect.poll(() => acceptedIds.length).toBe(1);
    await expect(retry).toBeDisabled();
    releasePost?.();
    const resend = page.getByRole('button', {
      name: '重試這次操作',
      exact: true,
    });
    await expect(resend).toBeVisible();
    await expect(retry).toBeDisabled();
    await resend.evaluate((element: HTMLButtonElement) => {
      for (let index = 0; index < 8; index++) element.click();
    });
    await expect.poll(() => acceptedIds.length).toBe(2);
    await expect(
      page.getByRole('definition').filter({ hasText: '媒體處理 · 成功' }),
    ).toBeVisible({ timeout: 20_000 });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(acceptedIds[1]).toBe(acceptedIds[0]);
    const collection = await page.request.get(
      `${environment.url}/api/v1/jobs?type=media&pageSize=100`,
    );
    expect(collection.status()).toBe(200);
    expect(((await collection.json()) as { total: number }).total).toBe(2);
  } finally {
    releaseLookup?.();
    releasePost?.();
    for (const lease of leases) await lease.release();
    await environment.close();
  }
});

test('Studio還原舊產物後以真dist來源判斷同步，不誤用最新成功工作', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(environment.url);
    await navigate(page, '網站更新與工作');
    const build = async () => {
      const accepted = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith('/api/v1/build-jobs'),
      );
      await closeDetail(page);
      await page.getByRole('button', { name: '更新網站', exact: true }).click();
      const response = await accepted;
      expect(response.status()).toBe(202);
      const queued = JobSchema.parse(await response.json());
      await expect(
        page.getByRole('definition').filter({ hasText: '網站更新 · 成功' }),
      ).toBeVisible();
      const detail = await page.request.get(
        `${environment.url}/api/v1/jobs/${queued.id}`,
      );
      const completed = JobSchema.parse(await detail.json());
      if (completed.type !== 'build' || !completed.result)
        throw new Error('缺少真Build結果');
      return { ...completed, result: completed.result };
    };
    const first = await build();
    await navigate(page, '文章');
    await openOne(page);
    await page.getByLabel('文章標題', { exact: true }).fill('第二份產物的來源');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith('/api/v1/articles/one'),
    );
    await page
      .getByRole('button', { name: '保存目前內容', exact: true })
      .click();
    expect((await saved).status()).toBe(200);
    await navigate(page, '網站更新與工作');
    const second = await build();
    expect(second.result.snapshotRevision).not.toBe(
      first.result.snapshotRevision,
    );
    await navigate(page, '衝突與復原');
    await page
      .locator(`tr[data-recovery-id="${second.id}"]`)
      .getByRole('button', { name: '網站版本 · 可還原', exact: true })
      .click();
    await page
      .getByLabel('復原選擇', { exact: true })
      .selectOption('restore-backup');
    const restored = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/api/v1/recoveries/${second.id}/resolution`),
    );
    await confirm(page, () =>
      page
        .getByRole('button', { name: '確認套用復原決策', exact: true })
        .click(),
    );
    expect((await restored).status()).toBe(200);
    const actual = await page.request.get(
      `${environment.url}/api/v1/artifacts/current`,
    );
    expect(actual.status()).toBe(200);
    expect(
      CurrentArtifactSchema.parse(await actual.json()).current?.build?.jobId,
    ).toBe(first.id);
    await navigate(page, '網站更新與工作');
    const installed = page.getByRole('region', { name: '網站狀態' });
    await installed.getByText('查看更新紀錄', { exact: true }).click();
    await expect(installed).toContainText(first.result.snapshotRevision);
    await expect(installed).toContainText(first.id);
    await expect(installed).toContainText('有已保存的變更尚未套用到網站');
    await expect(installed).not.toContainText('網站已更新至目前保存的內容。');
    await page.getByText('最近成功更新', { exact: true }).click();
    const history = page.getByRole('region', { name: '網站更新歷史' });
    await expect(history).toContainText(second.id);
    await expect(history).toContainText(second.result.snapshotRevision);
  } finally {
    await environment.close();
  }
});

test('Studio公開產物缺少、未知來源、讀取失敗與復原狀態均不誤稱同步', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(environment.url);
    await navigate(page, '網站更新與工作');
    const installed = page.getByRole('region', { name: '網站狀態' });
    await expect(installed).toContainText('網站尚未建立');
    await mkdir(join(environment.root, 'dist'), { recursive: true });
    await writeFile(
      join(environment.root, 'dist/index.html'),
      '<p>外部未追蹤產物</p>',
    );
    await expect(installed).toContainText(
      '網站已存在，但更新紀錄不完整。請重新更新網站。',
    );
    await expect(installed).not.toContainText('網站已更新至目前保存的內容。');
    await closeDetail(page);
    await page.getByRole('button', { name: '更新網站', exact: true }).click();
    await expect(
      page.getByRole('definition').filter({ hasText: '網站更新 · 成功' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(installed).toContainText('網站已更新至目前保存的內容。');
    await page.route('**/api/v1/artifacts/current', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'ARTIFACT_READ_UNAVAILABLE',
            message: '隔離測試拒絕這次產物狀態讀取。',
            retryable: false,
            issues: [],
            requestId: '11111111-1111-4111-8111-111111111111',
          },
        }),
      });
    });
    await expect(installed).toContainText('暫時無法確認網站狀態，請重新檢查。');
    await expect(installed).not.toContainText('網站已更新至目前保存的內容。');
    await page.unroute('**/api/v1/artifacts/current');
    await expect(installed).toContainText('網站已更新至目前保存的內容。');
    await writeFile(
      join(environment.root, 'dist/index.html'),
      '<p>受追蹤產物遭外部修改</p>',
    );
    const actualRecovery = async () => {
      const response = await page.request.get(
        `${environment.url}/api/v1/artifacts/current`,
      );
      expect(response.status()).toBe(200);
      return CurrentArtifactSchema.parse(await response.json()).recoveryState;
    };
    await expect.poll(actualRecovery).toBe('recovery-required');
    await expect(installed).toContainText('網站需要先完成復原');
    await expect(installed).not.toContainText('網站已更新至目前保存的內容。');
  } finally {
    await environment.close();
  }
});

test('Studio影片取消上傳沿同key重送、Poster變更與真實引用', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const { runControlledProcess } =
      await import('../../server/dist/runtime/process.js');
    const { buildProcessEnvironment } =
      await import('../../server/dist/runtime/environment.js');
    const path = join(environment.root, 'studio-fixture.mp4');
    await runControlledProcess({
      command: 'ffmpeg',
      args: [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=96x64:r=10:d=1',
        '-an',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-y',
        path,
      ],
      cwd: environment.root,
      env: buildProcessEnvironment(),
      timeoutMs: 15000,
    });
    await page.goto(environment.url);
    await navigate(page, '媒體庫');
    const keys: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/media/sources', async (route) => {
      if (route.request().method() === 'POST') {
        keys.push(route.request().headers()['idempotency-key'] ?? '');
        if (keys.length === 1) await gate;
      }
      await route.continue().catch(() => undefined);
    });
    await page.getByRole('button', { name: '上傳媒體', exact: true }).click();
    await page.getByLabel('選擇媒體檔案', { exact: true }).setInputFiles(path);
    await page
      .getByLabel('上傳顯示名稱（選填）', { exact: true })
      .fill('Studio影片');
    await page.getByLabel('Poster 秒數（選填）', { exact: true }).fill('0.2');
    await page
      .getByRole('dialog', { name: '上傳媒體', exact: true })
      .getByRole('button', { name: '上傳媒體', exact: true })
      .click();
    await expect.poll(() => keys.length).toBe(1);
    await page.getByRole('button', { name: '取消上傳', exact: true }).click();
    release?.();
    await expect(
      page.getByRole('button', { name: '重試上傳', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '重試上傳', exact: true }).click();
    await expect(page.getByLabel('媒體顯示名稱', { exact: true })).toHaveValue(
      'Studio影片',
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    await page.getByRole('button', { name: '處理媒體', exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: '媒體處理進度', exact: true })
        .getByText('處理完成', { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await page
      .getByRole('button', { name: '關閉媒體設定與引用', exact: true })
      .click();
    await page.getByRole('button', { name: 'Studio影片', exact: true }).click();
    await expect(page.getByLabel('Poster 秒數', { exact: true })).toHaveValue(
      '0.2',
    );
    const markup = await page
      .getByLabel('可複製媒體 HTML', { exact: true })
      .inputValue();
    expect(markup).toContain('<video controls');
    expect(markup).toContain('/video.webm');
    expect(markup).toContain('/poster.webp');
    const video = page.locator('video');
    await expect(video).toHaveAttribute('controls', '');
    await expect
      .poll(() =>
        video.evaluate((element) => (element as HTMLVideoElement).readyState),
      )
      .toBeGreaterThanOrEqual(1);
    const source = markup.match(/\/media\/([^/]+)\//)?.[1];
    expect(source).toBeTruthy();
    const media = await page.request.get(
      `${environment.url}/api/v1/media/files/${source ?? ''}/video.webm`,
      { headers: { Range: 'bytes=0-127' } },
    );
    expect(media.status()).toBe(206);
    expect(media.headers()['content-range']).toMatch(/^bytes 0-127\//);
    await page.getByLabel('Poster 秒數', { exact: true }).fill('');
    await page
      .getByRole('button', { name: '保存媒體設定', exact: true })
      .click();
    await expect(
      page.getByLabel('可複製媒體 HTML', { exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: '處理媒體', exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: '媒體處理進度', exact: true })
        .getByText('處理完成', { exact: true }),
    ).toBeVisible({ timeout: 20000 });
  } finally {
    await environment.close();
  }
});

test('Studio建立回應遺失保留原內容與同key重送，不重複新增', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(environment.url);
    await page.getByRole('button', { name: '新增文章', exact: true }).click();
    await page.getByLabel('文章標題', { exact: true }).fill('回應遺失草稿');
    await html(page, '<h2 id="saved">只建立一次</h2>');
    const keys: string[] = [];
    const bodies: string[] = [];
    let lostId: string | undefined;
    await page.route('**/api/v1/articles', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      bodies.push(route.request().postData() ?? '');
      const response = await route.fetch();
      if (keys.length === 1) {
        const resource = (await response.json()) as { id: string };
        lostId = resource.id;
        await route.fulfill({
          status: 201,
          headers: {
            'content-type': 'application/json',
            location: response.headers()['location'] ?? '',
          },
          body: '{"truncated":',
        });
      } else await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '建立草稿', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '重試這次操作', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('文章標題', { exact: true })).toBeDisabled();
    await page
      .getByRole('button', { name: '重試這次操作', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: '編輯文章：回應遺失草稿' }),
    ).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(
      await readFile(
        join(
          environment.root,
          'content/articles',
          lostId ?? '',
          'content.html',
        ),
        'utf8',
      ),
    ).toBe('<h2 id="saved">只建立一次</h2>');
    await page.getByRole('button', { name: '返回清單', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '回應遺失草稿', exact: true }),
    ).toHaveCount(1);
  } finally {
    await environment.close();
  }
});

test('Studio正式422正文診斷保留原始文章路徑並聚焦目前CodeMirror', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(environment.url);
    await openOne(page);
    await html(page, '<h2 id="valid">章節</h2>\n<h1>正文不能有H1</h1>');
    await page.locator('.editor-dates > summary').click();
    await page
      .getByRole('button', { name: '填入目前時間', exact: true })
      .click();
    const request = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith('/api/v1/articles/one'),
    );
    await confirm(page, () =>
      page.getByRole('button', { name: '發布目前內容', exact: true }).click(),
    );
    expect((await request).status()).toBe(422);
    const diagnostic = page
      .getByRole('alert')
      .getByRole('button', { name: /articles\.one\.contentHtml/ })
      .first();
    await expect(diagnostic).toBeVisible();
    await expect(diagnostic).toContainText(/第\s*2\s*行/u);
    await diagnostic.click();
    await expect(
      page.getByRole('textbox', { name: 'HTML 正文', exact: true }),
    ).toBeFocused();
    expect(
      (await readJson(environment.root, 'content/articles/one/meta.json'))[
        'status'
      ],
    ).toBe('draft');
    expect(
      await readFile(
        join(environment.root, 'content/articles/one/content.html'),
        'utf8',
      ),
    ).not.toContain('正文不能有H1');
  } finally {
    await environment.close();
  }
});

test('Studio他篇正文診斷顯示來源且不誤定位目前文章', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    const original = await readJson(
      environment.root,
      'content/articles/one/meta.json',
    );
    await mkdir(join(environment.root, 'content/articles/other'), {
      recursive: true,
    });
    await writeFile(
      join(environment.root, 'content/articles/other/meta.json'),
      JSON.stringify({
        ...original,
        status: 'published',
        title: '其他文章',
        slug: 'other',
        category: 'tools',
        publishedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await writeFile(
      join(environment.root, 'content/articles/other/content.html'),
      '<h2 id="other">其他文章</h2>\n<h1>只有他篇有H1錯誤</h1>',
    );
    await page.goto(environment.url);
    await page
      .locator('tr[data-article-id="one"]')
      .getByRole('button', { name: '文章', exact: true })
      .click();
    const preview = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/v1/previews') &&
        (
          response.request().postDataJSON() as {
            meta: { publishedAt: string | null };
          }
        ).meta.publishedAt !== null,
    );
    await page.locator('.editor-dates > summary').click();
    await page
      .getByRole('button', { name: '填入目前時間', exact: true })
      .click();
    const result = PreviewResponseSchema.parse(await (await preview).json());
    const other = result.diagnostics.find(
      (item) =>
        item.articleId === 'other' &&
        item.line !== undefined &&
        item.code.startsWith('HTML_'),
    );
    expect(other, '真Core全站預覽必須有其他文章的正文錯誤').toBeTruthy();
    if (!other) throw new Error('缺少其他文章診斷');
    const row = page
      .locator('.diagnostics>li')
      .filter({ hasText: other.code })
      .first();
    await expect(row).toBeVisible();
    const locate = row.getByRole('button', { name: '定位正文', exact: true });
    if ((await locate.count()) > 0) {
      await locate.click();
      await expect(
        page.getByRole('textbox', { name: 'HTML 正文', exact: true }),
        '其他文章診斷不得聚焦目前CodeMirror',
      ).not.toBeFocused();
    }
    await expect(locate).toHaveCount(0);
    await expect(row).toContainText('other');
    if (other.resource) await expect(row).toContainText(other.resource);
    await html(page, '<h2 id="one">目前章節</h2>\n<h1>目前正文也有H1錯誤</h1>');
    const own = page
      .locator('.diagnostics>li')
      .filter({ hasText: other.code })
      .filter({ hasText: '文章：one' })
      .first();
    await expect(
      own.getByRole('button', { name: '定位正文', exact: true }),
    ).toBeVisible();
    await own.getByRole('button', { name: '定位正文', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: 'HTML 正文', exact: true }),
    ).toBeFocused();
  } finally {
    await environment.close();
  }
});
