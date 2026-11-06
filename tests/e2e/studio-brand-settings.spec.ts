import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  JobSchema,
  MediaSourceResourceSchema,
  SiteConfigSchema,
} from '@foliohaven/core';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { studioEnvironment } from '../fixtures/studio/environment.js';
import { chooseSettingsSection } from '../fixtures/studio/settings.js';

test.use({ viewport: { width: 1536, height: 1000 } });

type Environment = Awaited<ReturnType<typeof studioEnvironment>>;
async function seedFavicon(page: Page, environment: Environment) {
  const sharp = createRequire(join(process.cwd(), 'server/package.json'))(
    'sharp',
  ) as NativeImageFactory;
  const bytes = await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: '#796784',
    },
  })
    .png()
    .toBuffer();
  const created = await page.request.post(
    `${environment.url}/api/v1/media/sources`,
    {
      headers: { Origin: environment.url, 'Idempotency-Key': randomUUID() },
      multipart: {
        file: { name: 'brand-icon.png', mimeType: 'image/png', buffer: bytes },
        displayName: '網站圖示測試來源',
      },
    },
  );
  expect(created.status()).toBe(201);
  const source = MediaSourceResourceSchema.parse(await created.json());
  const accepted = await page.request.post(
    `${environment.url}/api/v1/media-jobs`,
    {
      headers: { Origin: environment.url, 'Idempotency-Key': randomUUID() },
      data: { sourceId: source.id, preset: 'article-image' },
    },
  );
  expect(accepted.status()).toBe(202);
  const job = JobSchema.parse(await accepted.json());
  await expect
    .poll(
      async () =>
        JobSchema.parse(
          await (
            await page.request.get(`${environment.url}/api/v1/jobs/${job.id}`)
          ).json(),
        ).status,
      { timeout: 30000 },
    )
    .toBe('succeeded');
  const processed = await page.request.get(
    `${environment.url}/api/v1/media/sources/${source.id}`,
  );
  expect(processed.status()).toBe(200);
  const ready = MediaSourceResourceSchema.parse(await processed.json());
  const favicon = ready.asset?.outputs.find((output) =>
    output.publicPath.endsWith('/favicon.png'),
  );
  expect(favicon).toMatchObject({
    width: 32,
    height: 32,
    mimeType: 'image/png',
  });
  if (!favicon) throw new Error('Processed image has no real PNG favicon');
  const image = await page.request.get(
    `${environment.url}${favicon.publicPath.replace('/media/', '/api/v1/media/files/')}`,
  );
  expect(image.status()).toBe(200);
  expect(image.headers()['content-type']).toMatch(/^image\/png(?:;|$)/u);
  return { sourceId: source.id, path: favicon.publicPath };
}

async function saveSettings(page: Page) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/v1/site-settings',
  );
  await page.getByRole('button', { name: '保存全站設定', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  await expect(
    page.getByText('設定與已保存版本一致', { exact: true }),
  ).toBeVisible();
  return SiteConfigSchema.parse(await response.json());
}

test('網站品牌設定：真選PNG32圖示與精選小字保存重讀，favicon引用阻止刪除，兩欄可清空', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const articlePath = join(
      environment.root,
      'content/articles/one/content.html',
    );
    const originalBody = await readFile(articlePath);
    const favicon = await seedFavicon(page, environment);
    await page.goto(`${environment.url}/#/settings`);
    const general = await chooseSettingsSection(page, 'general');
    const icon = general.getByRole('combobox', {
      name: '主圖（Favicon）',
      exact: true,
    });
    await expect(icon).toBeEnabled();
    await icon.click();
    const picker = page.getByRole('dialog', {
      name: '選擇主圖（Favicon）',
      exact: true,
    });
    await picker
      .getByRole('button', { name: '網站圖示測試來源', exact: true })
      .click();
    const png = picker.getByRole('radio', { name: /^32 × 32.*PNG/u });
    await expect(png).toBeChecked();
    await png.check();
    expect(await png.inputValue()).toBe(favicon.path);
    await picker
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();
    await expect(icon).toContainText('網站圖示測試來源');
    await expect(icon).toContainText('32 × 32');
    await chooseSettingsSection(page, 'home');
    const caption = page.getByLabel('精選文章小字', { exact: true });
    await expect(caption).toHaveValue('精選文章');
    await caption.fill('技術觀察與實作');
    const first = await saveSettings(page);
    expect(first.favicon).toBe(favicon.path);
    expect(first.home.featuredCaption).toBe('技術觀察與實作');
    expect(first.social.defaultImage).toBeNull();
    const source = await page.request.get(
      `${environment.url}/api/v1/media/sources/${favicon.sourceId}`,
    );
    expect(source.status()).toBe(200);
    const etag = source.headers()['etag'] ?? '';
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/u);
    const rejected = await page.request.delete(
      `${environment.url}/api/v1/media/sources/${favicon.sourceId}`,
      { headers: { Origin: environment.url, 'If-Match': etag } },
    );
    expect(rejected.status()).toBe(409);
    expect(ApiErrorSchema.parse(await rejected.json()).error.code).toBe(
      'MEDIA_IN_USE',
    );
    expect(
      (
        await page.request.get(
          `${environment.url}/api/v1/media/sources/${favicon.sourceId}`,
        )
      ).status(),
    ).toBe(200);
    await page.reload();
    await expect(
      page.getByRole('combobox', { name: '主圖（Favicon）', exact: true }),
    ).toContainText('32 × 32');
    await chooseSettingsSection(page, 'home');
    await expect(caption).toHaveValue('技術觀察與實作');
    await caption.fill('');
    await chooseSettingsSection(page, 'general');
    await icon.click();
    await page
      .getByRole('dialog', { name: '選擇主圖（Favicon）', exact: true })
      .locator('.image-picker__default')
      .click();
    const cleared = await saveSettings(page);
    expect(cleared.favicon).toBeNull();
    expect(cleared.home.featuredCaption).toBe('');
    await page.reload();
    await expect(icon).toContainText('使用瀏覽器預設圖示');
    await expect(icon).not.toContainText('網站圖示測試來源');
    await chooseSettingsSection(page, 'home');
    await expect(caption).toHaveValue('');
    const disk = SiteConfigSchema.parse(
      JSON.parse(
        await readFile(join(environment.root, 'content/site.json'), 'utf8'),
      ),
    );
    expect(disk.favicon).toBeNull();
    expect(disk.home.featuredCaption).toBe('');
    expect(await readFile(articlePath)).toEqual(originalBody);
  } finally {
    await environment.close();
  }
});
