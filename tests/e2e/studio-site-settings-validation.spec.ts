import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SiteConfigSchema } from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';
import { chooseSettingsSection } from '../fixtures/studio/settings.js';
import type { SettingsSection } from '../fixtures/studio/settings.js';

test.use({ viewport: { width: 1536, height: 1000 } });

type Environment = Awaited<ReturnType<typeof studioEnvironment>>;
interface PutAttempt {
  readonly etag: string;
  readonly body: unknown;
}

function siteResponse(page: Page, method: 'GET' | 'PUT') {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname === '/api/v1/site-settings',
  );
}
function observePuts(page: Page) {
  const attempts: PutAttempt[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === '/api/v1/site-settings'
    )
      attempts.push({
        etag: request.headers()['if-match'] ?? '',
        body: request.postDataJSON() as unknown,
      });
  });
  return attempts;
}
function observePageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}
function summary(page: Page) {
  return page.getByRole('region', { name: /^設定有\d+項需要修正$/u });
}
function saveButton(page: Page) {
  return page.getByRole('button', { name: '保存全站設定', exact: true });
}
function savedNotice(page: Page) {
  return page.getByRole('status').filter({ hasText: /設定已保存/u });
}
async function openSettings(page: Page, environment: Environment) {
  const loaded = siteResponse(page, 'GET');
  await page.goto(environment.url);
  await page.getByRole('button', { name: '全站設定', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '全站設定', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('網站名稱', { exact: true })).toHaveValue(
    'HTTP測試網站',
  );
  const response = await loaded;
  expect(response.status()).toBe(200);
  const etag = (await response.headerValue('etag')) ?? '';
  expect(etag).toMatch(/^"[a-f0-9]{64}"$/u);
  return etag;
}
async function settleInput(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function focusIssue(page: Page, label: string, control: Locator) {
  const prefix = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  await summary(page)
    .getByRole('button', { name: new RegExp(`^${prefix}：`, 'u') })
    .first()
    .click();
  await expect(control).toBeFocused();
}
async function save(page: Page) {
  const accepted = siteResponse(page, 'PUT');
  await saveButton(page).click();
  const response = await accepted;
  expect(response.status()).toBe(200);
  const value = SiteConfigSchema.parse(await response.json());
  await expect(savedNotice(page)).toBeVisible();
  return value;
}
async function confirm(
  page: Page,
  action: () => Promise<unknown>,
  accept: boolean,
) {
  const decision = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await action();
  await decision;
}

test('全站設定網址：空白、不完整、壞網址、子路徑與query不崩潰，拒存保留緩衝並可聚焦修正', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const sitePath = join(environment.root, 'content/site.json');
    const before = await readFile(sitePath);
    const errors = observePageErrors(page);
    const attempts = observePuts(page);
    const initialEtag = await openSettings(page, environment);
    const name = page.getByLabel('網站名稱', { exact: true });
    const url = page.getByLabel('網站網址', { exact: true });
    await name.fill('網址檢查期間保留的網站名稱');
    for (const invalid of [
      '',
      'https://',
      'https:///',
      '不是網址',
      'https://example.invalid/blog/',
      'https://example.invalid/?q=1',
      'https://example.invalid/#section',
    ]) {
      await test.step(`網站網址 ${JSON.stringify(invalid)}`, async () => {
        await url.fill(invalid);
        await expect(url).toHaveValue(invalid);
        await expect(url).toHaveAttribute('aria-invalid', 'true');
        await expect(summary(page)).toBeVisible();
        await focusIssue(page, '網站網址', url);
        await saveButton(page).click();
        await expect(url).toBeFocused();
        await settleInput(page);
        await expect(name).toHaveValue('網址檢查期間保留的網站名稱');
        await expect(
          page.getByRole('heading', { name: '全站設定', exact: true }),
        ).toBeVisible();
        expect(attempts).toHaveLength(0);
        expect(await readFile(sitePath)).toEqual(before);
        expect(errors).toEqual([]);
      });
    }
    await url.fill('https://settings.invalid/');
    await expect(url).not.toHaveAttribute('aria-invalid', 'true');
    await expect(summary(page)).toHaveCount(0);
    const saved = await save(page);
    expect(saved.siteName).toBe('網址檢查期間保留的網站名稱');
    expect(saved.siteUrl).toBe('https://settings.invalid/');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.etag).toBe(initialEtag);
    expect(
      SiteConfigSchema.parse(JSON.parse(await readFile(sitePath, 'utf8'))),
    ).toEqual(saved);
    expect(errors).toEqual([]);
  } finally {
    await environment.close();
  }
});

const validationFields: readonly {
  label: string;
  invalid: readonly string[];
  valid: string;
  section: SettingsSection;
}[] = [
  {
    label: '作者網址',
    invalid: ['https://'],
    valid: 'https://author.invalid/',
    section: 'general',
  },
  {
    label: '語言',
    invalid: ['zh_Hant'],
    valid: 'zh-Hant',
    section: 'general',
  },
  {
    label: '顯示時區',
    invalid: ['Mars/Olympus'],
    valid: 'Asia/Taipei',
    section: 'general',
  },
  {
    label: 'Twitter / X Site',
    invalid: ['without_at'],
    valid: '@valid_blog',
    section: 'seo',
  },
  {
    label: 'SEO Title Template',
    invalid: ['{unsupported}'],
    valid: '{title} · {siteName}',
    section: 'seo',
  },
  {
    label: '分類每頁篇數',
    invalid: ['', '0', '101', '1.5'],
    valid: '2',
    section: 'home',
  },
  {
    label: 'Tag 每頁篇數',
    invalid: ['', '0', '101', '1.5'],
    valid: '3',
    section: 'home',
  },
  {
    label: '文章總覽每頁篇數',
    invalid: ['', '0', '101', '1.5'],
    valid: '4',
    section: 'home',
  },
  {
    label: '首頁最新文章篇數',
    invalid: ['', '0', '21', '1.5'],
    valid: '5',
    section: 'home',
  },
  {
    label: 'RSS 最多篇數',
    invalid: ['', '0', '10001', '1.5'],
    valid: '100',
    section: 'rss',
  },
];

const validSettings = {
  siteName: '所有欄位修正後仍保留的名稱',
  author: { url: 'https://author.invalid/' },
  language: 'zh-Hant',
  timeZone: 'Asia/Taipei',
  social: { twitterSite: '@valid_blog' },
  defaultSEO: { titleTemplate: '{title} · {siteName}' },
  pagination: { category: 2, tag: 3, articles: 4 },
  home: { latestCount: 5 },
  rss: { maxItems: 100 },
};

async function fillValidSettings(page: Page) {
  await page
    .getByLabel('網站名稱', { exact: true })
    .fill(validSettings.siteName);
  let section: SettingsSection = 'general';
  for (const field of validationFields) {
    if (field.section !== section) {
      await chooseSettingsSection(page, field.section);
      section = field.section;
    }
    const control = page.getByLabel(field.label, { exact: true });
    await control.fill(field.valid);
    await expect(control).not.toHaveAttribute('aria-invalid', 'true');
  }
  await expect(summary(page)).toHaveCount(0);
}

for (const group of [
  { section: 'general', label: '網站與作者' },
  { section: 'seo', label: 'SEO 與社群分享' },
  { section: 'home', label: '首頁與列表' },
  { section: 'rss', label: 'RSS' },
] as const) {
  test(`全站設定欄位：${group.label}即時驗證，摘要定位且拒存不丟其他輸入`, async ({
    page,
  }) => {
    const environment = await studioEnvironment();
    try {
      const sitePath = join(environment.root, 'content/site.json');
      const before = await readFile(sitePath);
      const errors = observePageErrors(page);
      const attempts = observePuts(page);
      const initialEtag = await openSettings(page, environment);
      const name = page.getByLabel('網站名稱', { exact: true });
      await fillValidSettings(page);
      await chooseSettingsSection(page, group.section);
      for (const field of validationFields.filter(
        (field) => field.section === group.section,
      )) {
        const control = page.getByLabel(field.label, { exact: true });
        for (const invalid of field.invalid) {
          await test.step(`${field.label} ${JSON.stringify(invalid)}`, async () => {
            await control.fill(invalid);
            await expect(control).toHaveAttribute('aria-invalid', 'true');
            await expect(summary(page)).toBeVisible();
            await focusIssue(page, field.label, control);
            await saveButton(page).click();
            await expect(control).toBeFocused();
            await settleInput(page);
            expect(attempts).toHaveLength(0);
            expect(await readFile(sitePath)).toEqual(before);
            await expect(name).toHaveValue(validSettings.siteName);
            expect(errors).toEqual([]);
            await control.fill(field.valid);
            await expect(control).not.toHaveAttribute('aria-invalid', 'true');
            await expect(summary(page)).toHaveCount(0);
          });
        }
      }
      expect(attempts).toHaveLength(0);
      expect(await readFile(sitePath)).toEqual(before);
      expect(errors).toEqual([]);
      const saved = await save(page);
      expect(saved).toMatchObject(validSettings);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.etag).toBe(initialEtag);
      expect(SiteConfigSchema.parse(attempts[0]?.body)).toEqual(saved);
      expect(
        SiteConfigSchema.parse(JSON.parse(await readFile(sitePath, 'utf8'))),
      ).toEqual(saved);
      expect(errors).toEqual([]);
    } finally {
      await environment.close();
    }
  });
}

test('全站設定欄位：跨區塊緩衝與聯合錯誤保留，全部修正後以原ETag一次保存', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const sitePath = join(environment.root, 'content/site.json');
    const before = await readFile(sitePath);
    const errors = observePageErrors(page);
    const attempts = observePuts(page);
    const initialEtag = await openSettings(page, environment);
    const name = page.getByLabel('網站名稱', { exact: true });
    await fillValidSettings(page);
    await chooseSettingsSection(page, 'general');
    const author = page.getByLabel('作者網址', { exact: true });
    const language = page.getByLabel('語言', { exact: true });
    await author.fill('https://');
    await language.fill('zh_Hant');
    await expect(
      page.getByRole('region', { name: '設定有2項需要修正', exact: true }),
    ).toBeVisible();
    await focusIssue(page, '作者網址', author);
    await focusIssue(page, '語言', language);
    await saveButton(page).click();
    await settleInput(page);
    expect(attempts).toHaveLength(0);
    expect(await readFile(sitePath)).toEqual(before);
    await expect(name).toHaveValue(validSettings.siteName);
    expect(errors).toEqual([]);
    await author.fill('https://author.invalid/');
    await language.fill('zh-Hant');
    await expect(summary(page)).toHaveCount(0);
    const saved = await save(page);
    expect(saved).toMatchObject(validSettings);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.etag).toBe(initialEtag);
    expect(SiteConfigSchema.parse(attempts[0]?.body)).toEqual(saved);
    expect(
      SiteConfigSchema.parse(JSON.parse(await readFile(sitePath, 'utf8'))),
    ).toEqual(saved);
    expect(errors).toEqual([]);
  } finally {
    await environment.close();
  }
});

test('全站設定保存失敗：HTTP422可聚焦且修改即清舊問題，503保留緩衝與ETag不假成功', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let failure: 422 | 503 | null = 422;
  try {
    const sitePath = join(environment.root, 'content/site.json');
    const before = await readFile(sitePath);
    const errors = observePageErrors(page);
    const attempts = observePuts(page);
    const initialEtag = await openSettings(page, environment);
    await page.route('**/api/v1/site-settings', async (route) => {
      if (route.request().method() !== 'PUT' || failure === null) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: failure,
        json: {
          error: {
            code:
              failure === 422
                ? 'SITE_SETTINGS_REJECTED'
                : 'SITE_SAVE_UNAVAILABLE',
            message:
              failure === 422
                ? '隔離驗收：網站名稱尚未通過檢查。'
                : '隔離驗收：目前無法保存，編輯內容仍保留。',
            retryable: failure === 503,
            issues:
              failure === 422
                ? [
                    {
                      path: ['siteName'],
                      code: 'custom',
                      message: '請重新確認網站名稱。',
                    },
                  ]
                : [],
            requestId: '11111111-1111-4111-8111-111111111111',
          },
        },
      });
    });
    const name = page.getByLabel('網站名稱', { exact: true });
    const author = page.getByLabel('作者名稱', { exact: true });
    await name.fill('422失敗後仍保留的名稱');
    await author.fill('保存失敗後仍保留的作者');
    const rejected = siteResponse(page, 'PUT');
    await saveButton(page).click();
    expect((await rejected).status()).toBe(422);
    await expect(summary(page)).toBeVisible();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await focusIssue(page, '網站名稱', name);
    await expect(name).toHaveValue('422失敗後仍保留的名稱');
    await expect(author).toHaveValue('保存失敗後仍保留的作者');
    await expect(savedNotice(page)).toHaveCount(0);
    expect(await readFile(sitePath)).toEqual(before);

    await name.fill('已重新確認並保留的名稱');
    await expect(summary(page)).toHaveCount(0);
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByText('請重新確認網站名稱。', { exact: true }),
    ).toHaveCount(0);
    failure = 503;
    const unavailable = siteResponse(page, 'PUT');
    await saveButton(page).click();
    expect((await unavailable).status()).toBe(503);
    await expect(
      page.getByText('隔離驗收：目前無法保存，編輯內容仍保留。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(name).toHaveValue('已重新確認並保留的名稱');
    await expect(author).toHaveValue('保存失敗後仍保留的作者');
    await expect(saveButton(page)).toBeEnabled();
    await expect(savedNotice(page)).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.etag)).toEqual([
      initialEtag,
      initialEtag,
    ]);
    expect(await readFile(sitePath)).toEqual(before);

    failure = null;
    const saved = await save(page);
    expect(saved.siteName).toBe('已重新確認並保留的名稱');
    expect(saved.author.name).toBe('保存失敗後仍保留的作者');
    expect(attempts).toHaveLength(3);
    expect(attempts[2]?.etag).toBe(initialEtag);
    expect(
      SiteConfigSchema.parse(JSON.parse(await readFile(sitePath, 'utf8'))),
    ).toEqual(saved);
    expect(errors).toEqual([]);
  } finally {
    await page.unroute('**/api/v1/site-settings');
    await environment.close();
  }
});

test('全站設定412：無效網址仍保留本機內容，明確採用才重設並使用最新ETag保存', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const sitePath = join(environment.root, 'content/site.json');
    const errors = observePageErrors(page);
    const attempts = observePuts(page);
    const initialEtag = await openSettings(page, environment);
    const name = page.getByLabel('網站名稱', { exact: true });
    const url = page.getByLabel('網站網址', { exact: true });
    const conflict = page.getByRole('region', {
      name: '版本衝突',
      exact: true,
    });
    await name.fill('412期間保留的本機網站名稱');
    const original = SiteConfigSchema.parse(
      JSON.parse(await readFile(sitePath, 'utf8')),
    );
    await writeFile(
      sitePath,
      JSON.stringify({ ...original, siteName: '第一份外部網站名稱' }),
    );
    const firstExternal = await readFile(sitePath);
    const firstRejected = siteResponse(page, 'PUT');
    const firstReloaded = siteResponse(page, 'GET');
    await saveButton(page).click();
    expect((await firstRejected).status()).toBe(412);
    const firstCurrent = await firstReloaded;
    expect(firstCurrent.status()).toBe(200);
    const firstEtag = (await firstCurrent.headerValue('etag')) ?? '';
    expect(firstEtag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(firstEtag).not.toBe(initialEtag);
    expect(SiteConfigSchema.parse(await firstCurrent.json()).siteName).toBe(
      '第一份外部網站名稱',
    );
    expect(attempts[0]?.etag).toBe(initialEtag);
    await expect(conflict).toBeVisible();
    await url.fill('https://');
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    await saveButton(page).click();
    await expect(url).toBeFocused();
    expect(attempts).toHaveLength(1);
    await confirm(
      page,
      () =>
        conflict
          .getByRole('button', { name: '保留我的內容繼續編輯', exact: true })
          .click(),
      true,
    );
    await expect(conflict).toHaveCount(0);
    await expect(name).toHaveValue('412期間保留的本機網站名稱');
    await expect(url).toHaveValue('https://');
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    await expect(summary(page)).toBeVisible();
    await saveButton(page).click();
    await expect(url).toBeFocused();
    await settleInput(page);
    expect(attempts).toHaveLength(1);
    expect(await readFile(sitePath)).toEqual(firstExternal);

    await url.fill('https://local.invalid/');
    await expect(summary(page)).toHaveCount(0);
    await writeFile(
      sitePath,
      JSON.stringify({
        ...original,
        siteName: '第二份外部網站名稱',
        siteUrl: 'https://external.invalid/',
      }),
    );
    const secondExternal = await readFile(sitePath);
    const secondRejected = siteResponse(page, 'PUT');
    const secondReloaded = siteResponse(page, 'GET');
    await saveButton(page).click();
    expect((await secondRejected).status()).toBe(412);
    const secondCurrent = await secondReloaded;
    expect(secondCurrent.status()).toBe(200);
    const secondEtag = (await secondCurrent.headerValue('etag')) ?? '';
    expect(secondEtag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(secondEtag).not.toBe(firstEtag);
    expect(SiteConfigSchema.parse(await secondCurrent.json()).siteUrl).toBe(
      'https://external.invalid/',
    );
    expect(attempts[1]?.etag).toBe(firstEtag);
    expect(attempts[1]?.body).toMatchObject({
      siteName: '412期間保留的本機網站名稱',
      siteUrl: 'https://local.invalid/',
    });
    await expect(conflict).toBeVisible();
    await url.fill('https://');
    await expect(summary(page)).toBeVisible();
    const adopt = () =>
      conflict
        .getByRole('button', { name: '採用已保存版本', exact: true })
        .click();
    await confirm(page, adopt, false);
    await expect(name).toHaveValue('412期間保留的本機網站名稱');
    await expect(url).toHaveValue('https://');
    await expect(summary(page)).toBeVisible();
    expect(await readFile(sitePath)).toEqual(secondExternal);
    await confirm(page, adopt, true);
    await expect(conflict).toHaveCount(0);
    await expect(name).toHaveValue('第二份外部網站名稱');
    await expect(url).toHaveValue('https://external.invalid/');
    await expect(url).not.toHaveAttribute('aria-invalid', 'true');
    await expect(summary(page)).toHaveCount(0);
    await settleInput(page);
    expect(attempts).toHaveLength(2);
    expect(await readFile(sitePath)).toEqual(secondExternal);

    const saved = await save(page);
    expect(saved.siteName).toBe('第二份外部網站名稱');
    expect(saved.siteUrl).toBe('https://external.invalid/');
    expect(attempts).toHaveLength(3);
    expect(attempts[2]?.etag).toBe(secondEtag);
    expect(
      SiteConfigSchema.parse(JSON.parse(await readFile(sitePath, 'utf8'))),
    ).toEqual(saved);
    expect(errors).toEqual([]);
  } finally {
    await environment.close();
  }
});

test('全站設定動態導覽：新增欄位即時提示與定位，修正後真保存且保留其他輸入', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const sitePath = join(environment.root, 'content/site.json');
    const before = await readFile(sitePath);
    const original = SiteConfigSchema.parse(JSON.parse(before.toString()));
    const errors = observePageErrors(page);
    const attempts = observePuts(page);
    const initialEtag = await openSettings(page, environment);
    const description = page.getByLabel('網站描述', { exact: true });
    await description.fill('動態導覽與必填欄位修正期間仍保留的網站描述');

    for (const field of [
      { label: '網站名稱', valid: '動態導覽驗收網站' },
      { label: '作者名稱', valid: '動態導覽驗收作者' },
      { label: 'RSS 標題', valid: '動態導覽驗收訂閱' },
    ]) {
      await chooseSettingsSection(
        page,
        field.label === 'RSS 標題' ? 'rss' : 'general',
      );
      const control = page.getByLabel(field.label, { exact: true });
      await control.fill('');
      await expect(control).toHaveAttribute('aria-invalid', 'true');
      await expect(summary(page)).toBeVisible();
      await focusIssue(page, field.label, control);
      await saveButton(page).click();
      await expect(control).toBeFocused();
      await settleInput(page);
      expect(attempts).toHaveLength(0);
      expect(await readFile(sitePath)).toEqual(before);
      await expect(description).toHaveValue(
        '動態導覽與必填欄位修正期間仍保留的網站描述',
      );
      await control.fill(field.valid);
      await expect(control).not.toHaveAttribute('aria-invalid', 'true');
      await expect(summary(page)).toHaveCount(0);
    }

    await chooseSettingsSection(page, 'navigation');
    await page.getByRole('button', { name: '新增導覽', exact: true }).click();
    const number = original.navigation.length + 1;
    const nameLabel = `導覽 ${number} 名稱`;
    const linkLabel = `導覽 ${number} 連結`;
    const name = page.getByLabel(nameLabel, { exact: true });
    const link = page.getByLabel(linkLabel, { exact: true });
    await expect(name).toHaveValue('');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(summary(page)).toBeVisible();
    await focusIssue(page, nameLabel, name);
    await saveButton(page).click();
    await expect(name).toBeFocused();
    await settleInput(page);
    expect(attempts).toHaveLength(0);
    expect(await readFile(sitePath)).toEqual(before);
    await name.fill('閱讀筆記');
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await expect(summary(page)).toHaveCount(0);

    await link.fill('https://');
    await expect(link).toHaveAttribute('aria-invalid', 'true');
    await expect(summary(page)).toBeVisible();
    await focusIssue(page, linkLabel, link);
    await saveButton(page).click();
    await expect(link).toBeFocused();
    await settleInput(page);
    expect(attempts).toHaveLength(0);
    expect(await readFile(sitePath)).toEqual(before);
    await expect(name).toHaveValue('閱讀筆記');
    await expect(description).toHaveValue(
      '動態導覽與必填欄位修正期間仍保留的網站描述',
    );
    await expect(page.getByLabel('網站名稱', { exact: true })).toHaveValue(
      '動態導覽驗收網站',
    );
    await expect(page.getByLabel('作者名稱', { exact: true })).toHaveValue(
      '動態導覽驗收作者',
    );
    await expect(page.getByLabel('RSS 標題', { exact: true })).toHaveValue(
      '動態導覽驗收訂閱',
    );
    await link.fill('/category/notes/');
    await expect(link).not.toHaveAttribute('aria-invalid', 'true');
    await expect(summary(page)).toHaveCount(0);

    const saved = await save(page);
    expect(saved).toMatchObject({
      siteName: '動態導覽驗收網站',
      siteDescription: '動態導覽與必填欄位修正期間仍保留的網站描述',
      author: { name: '動態導覽驗收作者' },
      rss: { title: '動態導覽驗收訂閱' },
    });
    expect(saved.navigation).toEqual([
      ...original.navigation,
      { label: '閱讀筆記', href: '/category/notes/' },
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.etag).toBe(initialEtag);
    expect(
      SiteConfigSchema.parse(JSON.parse(await readFile(sitePath, 'utf8'))),
    ).toEqual(saved);
    expect(errors).toEqual([]);
  } finally {
    await environment.close();
  }
});
