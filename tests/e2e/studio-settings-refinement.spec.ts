import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  JobSchema,
  MediaSourceResourceSchema,
  SiteConfigSchema,
} from '@foliohaven/core';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { studioEnvironment } from '../fixtures/studio/environment.js';
import {
  chooseSettingsSection,
  settingsSections,
} from '../fixtures/studio/settings.js';
import type { SettingsSection } from '../fixtures/studio/settings.js';

test.use({ viewport: { width: 1536, height: 1000 } });

async function uploadDefaultImage(page: Page) {
  const sharp = createRequire(join(process.cwd(), 'server/package.json'))(
    'sharp',
  ) as NativeImageFactory;
  const bytes = await sharp({
    create: { width: 120, height: 63, channels: 3, background: '#58725e' },
  })
    .png()
    .toBuffer();
  const created = await page.evaluate(
    async ({ data, key }) => {
      const form = new FormData();
      form.append(
        'file',
        new File([new Uint8Array(data)], 'default-social.png', {
          type: 'image/png',
        }),
      );
      form.append('displayName', '目前預設分享圖');
      const response = await fetch('/api/v1/media/sources', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: form,
      });
      return {
        status: response.status,
        data: (await response.json()) as unknown,
      };
    },
    { data: Array.from(bytes), key: randomUUID() },
  );
  expect(created.status).toBe(201);
  const source = MediaSourceResourceSchema.parse(created.data);
  const accepted = await page.evaluate(
    async ({ id, key }) => {
      const response = await fetch('/api/v1/media-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ sourceId: id, preset: 'article-image' }),
      });
      return {
        status: response.status,
        data: (await response.json()) as unknown,
      };
    },
    { id: source.id, key: randomUUID() },
  );
  expect(accepted.status).toBe(202);
  const job = JobSchema.parse(accepted.data);
  await expect
    .poll(
      async () => {
        const result = await page.request.get(
          `${new URL(page.url()).origin}/api/v1/jobs/${job.id}`,
        );
        return JobSchema.parse(await result.json()).status;
      },
      { timeout: 20_000 },
    )
    .toBe('succeeded');
  const resource = await page.request.get(
    `${new URL(page.url()).origin}/api/v1/media/sources/${source.id}`,
  );
  const processed = MediaSourceResourceSchema.parse(await resource.json());
  const image = processed.asset?.outputs.find((output) =>
    output.publicPath.endsWith('/image.webp'),
  );
  if (!image) throw new Error('Default image fixture has no processed image');
  return image.publicPath;
}

test('分類SEO直接顯示真實繼承值，保存不把預設展開成覆寫；全站分區保留欄位與可讀性', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(environment.url);
    const image = await uploadDefaultImage(page);
    const sitePath = join(environment.root, 'content/site.json');
    const original = SiteConfigSchema.parse(
      JSON.parse(await readFile(sitePath, 'utf8')),
    );
    await writeFile(
      sitePath,
      JSON.stringify({
        ...original,
        siteName: '設定驗收網站',
        defaultSEO: {
          titleTemplate: '{title} · {siteName}',
          description: '網站目前的預設說明',
          index: false,
        },
        social: { ...original.social, defaultImage: image },
      }),
    );
    await page.goto(`${environment.url}/#/taxonomy`);
    await page.reload();
    await page.getByRole('button', { name: '筆記', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '編輯分類', exact: true });
    await expect(
      dialog.getByText('預設：筆記 · 設定驗收網站', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText('預設：筆記資料', { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel('Indexing', { exact: true })).toHaveValue(
      'inherit',
    );
    await expect(
      dialog.getByLabel('Indexing', { exact: true }).locator('option:checked'),
    ).toHaveText('使用全站預設值 · 不允許索引');
    await expect(dialog.getByLabel('OG Image', { exact: true })).toContainText(
      '目前預設分享圖',
    );
    await dialog.getByLabel('分類描述', { exact: true }).fill('新的分類說明');
    await expect(
      dialog.getByText('預設：新的分類說明', { exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: '保存分類', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const categories = JSON.parse(
      await readFile(join(environment.root, 'content/categories.json'), 'utf8'),
    ) as { path: string; description: string; seo: Record<string, unknown> }[];
    expect(categories.find((item) => item.path === 'notes')).toMatchObject({
      description: '新的分類說明',
      seo: { title: null, description: null, index: null, ogImage: null },
    });
    await page.setViewportSize({ width: 1536, height: 1000 });
    await page.getByRole('button', { name: '全站設定', exact: true }).click();
    await expect(page.locator('.settings-section-panel')).toHaveCount(5);
    for (const section of Object.keys(settingsSections) as SettingsSection[]) {
      const panel = await chooseSettingsSection(page, section);
      const card = panel.locator('.settings-panel');
      const heading = card.getByRole('heading', {
        name: settingsSections[section],
        exact: true,
      });
      await expect(heading).toBeVisible();
      const cardBox = await card.boundingBox();
      const headingBox = await heading.boundingBox();
      if (!cardBox || !headingBox)
        throw new Error('Visible setting section has no layout box');
      expect(headingBox.y).toBeGreaterThan(cardBox.y + 8);
    }
    await chooseSettingsSection(page, 'general');
    await page.getByLabel('網站名稱', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('作者名稱', { exact: true })).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('設定區塊', { exact: true })).toBeVisible();
    await chooseSettingsSection(page, 'general');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await environment.close();
  }
});

test('網址引導顯示新舊連結、先查看影響才確認，直接入口保留真遷移行為', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const categoriesPath = join(environment.root, 'content/categories.json');
    const before = await readFile(categoriesPath);
    await page.goto(`${environment.url}/#/taxonomy`);
    await page.getByRole('button', { name: '筆記', exact: true }).click();
    await page
      .getByRole('dialog', { name: '編輯分類', exact: true })
      .getByRole('button', { name: '修改網址', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', { name: '編輯分類', exact: true }),
    ).not.toBeVisible();
    const guide = page.getByRole('region', {
      name: '修改分類或 Tag 網址',
      exact: true,
    });
    await expect(guide.getByLabel('要變更的項目', { exact: true })).toHaveValue(
      'notes',
    );
    const next = guide.getByLabel('新的網址名稱', { exact: true });
    await expect(next).toBeFocused();
    await next.fill('journal');
    await expect(
      guide.getByText('https://example.invalid/category/notes/', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      guide.getByText('https://example.invalid/category/journal/', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(guide.getByText(/原網址不會自動轉址/u)).toBeVisible();
    await guide
      .getByRole('button', { name: '查看變更影響', exact: true })
      .click();
    await expect(
      guide.getByRole('heading', { name: '確認網址變更', exact: true }),
    ).toBeVisible();
    expect(await readFile(categoriesPath)).toEqual(before);
    const jobsBefore = await page.request.get(
      `${environment.url}/api/v1/jobs?type=taxonomy&page=1&pageSize=20`,
    );
    expect(((await jobsBefore.json()) as { total: number }).total).toBe(0);
    const rejected = page
      .waitForEvent('dialog')
      .then((dialog) => dialog.dismiss());
    await guide
      .getByRole('button', { name: '確認變更網址', exact: true })
      .click();
    await rejected;
    expect(await readFile(categoriesPath)).toEqual(before);
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/v1/taxonomy-migrations') &&
        (response.request().postDataJSON() as { confirmed?: boolean })
          .confirmed === true,
    );
    const confirmed = page
      .waitForEvent('dialog')
      .then((dialog) => dialog.accept());
    await guide
      .getByRole('button', { name: '確認變更網址', exact: true })
      .click();
    await confirmed;
    const response = await accepted;
    expect(response.status()).toBe(202);
    const job = JobSchema.parse(await response.json());
    await expect
      .poll(
        async () =>
          JobSchema.parse(
            await (
              await page.request.get(
                `${new URL(page.url()).origin}/api/v1/jobs/${job.id}`,
              )
            ).json(),
          ).status,
        { timeout: 20_000 },
      )
      .toBe('succeeded');
    expect(JSON.parse(await readFile(categoriesPath, 'utf8'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'journal', name: '筆記' }),
      ]),
    );
    expect(
      JSON.parse(
        await readFile(
          join(environment.root, 'content/articles/one/meta.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ category: 'journal' });
  } finally {
    await environment.close();
  }
});

test('全站預設讀取失敗時不捏造空值或索引預設', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    await page.route('**/api/v1/site-settings', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'SITE_DEFAULTS_UNAVAILABLE',
            message: '隔離測試暫時無法讀取全站設定。',
            retryable: true,
            issues: [],
            requestId: '11111111-1111-4111-8111-111111111111',
          },
        }),
      });
    });
    await page.goto(`${environment.url}/#/taxonomy`);
    await page.getByRole('button', { name: '筆記', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '編輯分類', exact: true });
    await expect(
      dialog.getByText('目前無法讀取全站預設值，請至「全站設定」確認。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog.getByLabel('Indexing', { exact: true }).locator('option:checked'),
    ).toHaveText('使用全站預設值 · 目前無法確認預設值');
    await expect(dialog.locator('.image-select')).toContainText(
      '目前無法確認預設圖片',
    );
    await expect(dialog.locator('.image-select')).not.toContainText(
      '未設定圖片',
    );
  } finally {
    await environment.close();
  }
});
