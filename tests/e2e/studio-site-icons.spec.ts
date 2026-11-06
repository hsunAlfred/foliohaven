import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { MediaSourceResourceSchema, SiteConfigSchema } from '@foliohaven/core';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { studioEnvironment } from '../fixtures/studio/environment.js';
import { chooseSettingsSection } from '../fixtures/studio/settings.js';

test.use({ viewport: { width: 1536, height: 1000 } });

async function saveSettings(page: Page) {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/v1/site-settings',
    { timeout: 30000 },
  );
  await page.getByRole('button', { name: '保存全站設定', exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  await expect(
    page.getByText('設定與已保存版本一致', { exact: true }),
  ).toBeVisible();
  return SiteConfigSchema.parse(await response.json());
}

test('網站圖示：SVG 專用選單與生成、各欄保存重讀、HEX 驗證及停用保留設定', async ({
  page,
}, testInfo) => {
  const environment = await studioEnvironment();
  try {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><circle cx="256" cy="256" r="192" fill="#404040"/></svg>',
    );
    const sharp = createRequire(join(process.cwd(), 'server/package.json'))(
      'sharp',
    ) as NativeImageFactory;
    const png = await sharp({
      create: { width: 32, height: 32, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    let sourceId = '';
    for (const file of [
      {
        name: 'mask-source.svg',
        mimeType: 'image/svg+xml',
        bytes: svg,
        title: 'Mask source SVG',
      },
      {
        name: 'mask-raster.png',
        mimeType: 'image/png',
        bytes: png,
        title: 'Mask raster PNG',
      },
    ]) {
      const response = await page.request.post(
        `${environment.url}/api/v1/media/sources`,
        {
          headers: { Origin: environment.url, 'Idempotency-Key': randomUUID() },
          multipart: {
            file: {
              name: file.name,
              mimeType: file.mimeType,
              buffer: file.bytes,
            },
            displayName: file.title,
          },
        },
      );
      expect(response.status()).toBe(201);
      if (file.mimeType === 'image/svg+xml')
        sourceId = MediaSourceResourceSchema.parse(await response.json()).id;
    }
    expect(sourceId).not.toBe('');
    await page.goto(`${environment.url}/#/settings`);
    let general = await chooseSettingsSection(page, 'general');
    let icons = general.getByRole('group', {
      name: '網站圖示',
      exact: true,
    });
    await expect(
      icons.getByLabel('產生多尺寸圖示', { exact: true }),
    ).not.toBeChecked();
    await expect(
      icons.getByLabel('淺色模式瀏覽器色彩', { exact: true }),
    ).toBeDisabled();
    await icons.getByLabel('產生多尺寸圖示', { exact: true }).check();
    await expect(
      icons.getByLabel('淺色模式瀏覽器色彩', { exact: true }),
    ).toHaveValue('#ffffff');
    await expect(
      icons.getByLabel('深色模式瀏覽器色彩', { exact: true }),
    ).toHaveValue('#262626');
    await expect(icons.getByLabel('App 名稱', { exact: true })).toHaveValue('');
    await expect(icons.getByLabel('App 短名稱', { exact: true })).toHaveValue(
      '',
    );

    const requested = page.waitForRequest(
      (request) =>
        request.method() === 'GET' &&
        new URL(request.url()).pathname === '/api/v1/media/sources' &&
        new URL(request.url()).searchParams.get('format') === 'svg',
    );
    await icons
      .getByRole('combobox', { name: 'Safari pinned tab 圖示', exact: true })
      .click();
    expect(new URL((await requested).url()).searchParams.get('format')).toBe(
      'svg',
    );
    const picker = page.getByRole('dialog', {
      name: '選擇Safari pinned tab 圖示',
      exact: true,
    });
    await expect(
      picker.getByRole('button', { name: 'Mask source SVG', exact: true }),
    ).toBeVisible();
    await expect(
      picker.getByRole('button', { name: 'Mask raster PNG', exact: true }),
    ).toHaveCount(0);
    await picker
      .getByRole('button', { name: '上傳新媒體', exact: true })
      .click();
    const upload = page.getByRole('dialog', { name: '上傳媒體', exact: true });
    await expect(
      upload.getByLabel('選擇媒體檔案', { exact: true }),
    ).toHaveAttribute('accept', '.svg');
    await upload
      .getByRole('button', { name: '關閉上傳媒體', exact: true })
      .click();
    await picker
      .getByRole('button', { name: 'Mask source SVG', exact: true })
      .click();
    const preparation = page.getByRole('dialog', {
      name: '處理與選擇圖片',
      exact: true,
    });
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/media-jobs',
    );
    await preparation
      .getByRole('button', { name: '處理媒體', exact: true })
      .click();
    const jobResponse = await accepted;
    expect(jobResponse.status()).toBe(202);
    expect(jobResponse.request().postDataJSON()).toMatchObject({
      sourceId,
      preset: 'site-icons',
    });
    await expect(
      preparation
        .getByRole('region', { name: '媒體處理進度', exact: true })
        .getByText('處理完成', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(preparation.getByRole('radio')).toHaveCount(1);
    await expect(preparation.getByRole('radio')).toBeChecked();
    await expect(preparation.getByRole('radio')).toHaveValue(
      `/media/${sourceId}/mask-icon.svg`,
    );
    await expect
      .poll(() =>
        preparation
          .locator('.image-picker__large-preview img')
          .evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
      )
      .toBe(true);
    await preparation
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();

    await general
      .getByRole('combobox', { name: '主圖（Favicon）', exact: true })
      .click();
    const faviconPicker = page.getByRole('dialog', {
      name: '選擇主圖（Favicon）',
      exact: true,
    });
    await faviconPicker
      .getByRole('button', { name: 'Mask source SVG', exact: true })
      .click();
    await expect(
      faviconPicker.locator('input[type="radio"][value$="/image.svg"]'),
    ).toBeChecked();
    await faviconPicker
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();

    await icons.getByLabel('Apple Touch 圖示', { exact: true }).uncheck();
    await icons.getByLabel('Safari 圖示色彩', { exact: true }).fill('#736084');
    await icons
      .getByLabel('淺色模式瀏覽器色彩', { exact: true })
      .fill('#d7d0c6');
    await icons
      .getByLabel('深色模式瀏覽器色彩', { exact: true })
      .fill('#2c343f');
    await expect(
      icons.getByLabel('深色模式瀏覽器色彩色票', { exact: true }),
    ).toHaveValue('#2c343f');
    await icons.getByLabel('App 名稱', { exact: true }).fill('Example App');
    await icons.getByLabel('App 短名稱', { exact: true }).fill('Example');
    await icons
      .getByLabel('App 顯示模式', { exact: true })
      .selectOption('minimal-ui');
    await icons.getByLabel('啟動畫面背景色', { exact: true }).fill('#e3dbd0');
    const saved = await saveSettings(page);
    expect(saved.icons).toEqual({
      enabled: true,
      appleTouch: false,
      manifest: true,
      maskIcon: `/media/${sourceId}/mask-icon.svg`,
      maskColor: '#736084',
      themeLight: '#d7d0c6',
      themeDark: '#2c343f',
      backgroundColor: '#e3dbd0',
      appName: 'Example App',
      shortName: 'Example',
      display: 'minimal-ui',
    });
    await page.screenshot({
      path: testInfo.outputPath('complete-icons-desktop.png'),
      fullPage: true,
    });
    await page.reload();
    general = await chooseSettingsSection(page, 'general');
    icons = general.getByRole('group', {
      name: '網站圖示',
      exact: true,
    });
    await expect(
      icons.getByLabel('產生多尺寸圖示', { exact: true }),
    ).toBeChecked();
    await expect(icons.getByLabel('App 名稱', { exact: true })).toHaveValue(
      'Example App',
    );
    await expect(icons.getByLabel('App 顯示模式', { exact: true })).toHaveValue(
      'minimal-ui',
    );
    await icons
      .getByLabel('深色模式瀏覽器色彩', { exact: true })
      .fill('#badhex');
    await expect(
      icons.getByLabel('深色模式瀏覽器色彩', { exact: true }),
    ).toHaveAttribute('aria-invalid', 'true');
    await expect(
      icons.getByText('深色模式瀏覽器色彩需使用六位 HEX 色碼，例如 #262626。', {
        exact: true,
      }),
    ).toBeVisible();
    await icons
      .getByLabel('深色模式瀏覽器色彩', { exact: true })
      .fill('#2c343f');
    await icons.getByLabel('Web App Manifest', { exact: true }).uncheck();
    await expect(icons.getByLabel('App 名稱', { exact: true })).toBeDisabled();
    const withoutManifest = await saveSettings(page);
    expect(withoutManifest.icons).toEqual({ ...saved.icons, manifest: false });
    await icons.getByLabel('產生多尺寸圖示', { exact: true }).uncheck();
    const disabled = await saveSettings(page);
    expect(disabled.icons).toEqual({
      ...withoutManifest.icons,
      enabled: false,
    });
    await page.reload();
    general = await chooseSettingsSection(page, 'general');
    icons = general.getByRole('group', {
      name: '網站圖示',
      exact: true,
    });
    await expect(
      icons.getByLabel('產生多尺寸圖示', { exact: true }),
    ).not.toBeChecked();
    await expect(icons.getByLabel('App 名稱', { exact: true })).toBeDisabled();
    await expect(icons.getByLabel('App 名稱', { exact: true })).toHaveValue(
      'Example App',
    );
    await expect(
      icons.getByLabel('深色模式瀏覽器色彩', { exact: true }),
    ).toHaveValue('#2c343f');
    await page.setViewportSize({ width: 375, height: 812 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(375);
    await page.screenshot({
      path: testInfo.outputPath('complete-icons-mobile.png'),
      fullPage: true,
    });
  } finally {
    await environment.close();
  }
});

test('普通 SVG 選為主圖後產生多尺寸圖示：保存前自動準備，改色與停用不重做', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(`${environment.url}/#/settings`);
    const general = await chooseSettingsSection(page, 'general');
    await general
      .getByRole('combobox', { name: '主圖（Favicon）', exact: true })
      .click();
    const picker = page.getByRole('dialog', {
      name: '選擇主圖（Favicon）',
      exact: true,
    });
    await picker
      .getByRole('button', { name: '上傳新媒體', exact: true })
      .click();
    const upload = page.getByRole('dialog', { name: '上傳媒體', exact: true });
    await upload.getByLabel('選擇媒體檔案', { exact: true }).setInputFiles({
      name: 'primary.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect x="64" y="64" width="384" height="384" rx="80" fill="#404040"/></svg>',
      ),
    });
    await upload
      .getByLabel('上傳顯示名稱（選填）', { exact: true })
      .fill('Ordinary primary SVG');
    const uploaded = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/media/sources',
    );
    await upload.getByRole('button', { name: '上傳媒體', exact: true }).click();
    const source = MediaSourceResourceSchema.parse(
      await (await uploaded).json(),
    );
    // The upload callback opens ordinary image preparation; it must remain article-image.
    const prepare = page.getByRole('dialog', {
      name: '處理與選擇圖片',
      exact: true,
    });
    const ordinaryJob = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/media-jobs',
    );
    await prepare
      .getByRole('button', { name: '處理媒體', exact: true })
      .click();
    expect((await ordinaryJob).request().postDataJSON()).toEqual({
      sourceId: source.id,
      preset: 'article-image',
    });
    await expect(
      prepare.getByRole('button', { name: '使用這個尺寸', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await prepare
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();
    const initialMedia = MediaSourceResourceSchema.parse(
      await (
        await page.request.get(
          `${environment.url}/api/v1/media/sources/${source.id}`,
        )
      ).json(),
    );
    expect(initialMedia.asset?.presetVersion).toBe('article-image-v3');
    expect(
      initialMedia.asset?.outputs.some((output) =>
        output.publicPath.endsWith('/icon-512.png'),
      ),
    ).toBe(false);
    const icons = general.getByRole('group', {
      name: '網站圖示',
      exact: true,
    });
    await icons.getByLabel('產生多尺寸圖示', { exact: true }).check();
    await expect(
      icons.getByLabel('Safari 圖示色彩', { exact: true }),
    ).toBeEnabled();
    const requests: { method: string; path: string; body: unknown }[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        ['/api/v1/media-jobs', '/api/v1/site-settings'].includes(path) &&
        ['POST', 'PUT'].includes(request.method())
      )
        requests.push({
          method: request.method(),
          path,
          body: request.postDataJSON(),
        });
    });
    const saved = await saveSettings(page);
    expect(saved.favicon).toBe(`/media/${source.id}/image.svg`);
    expect(saved.icons.maskIcon).toBeNull();
    expect(requests.map((request) => request.path)).toEqual([
      '/api/v1/media-jobs',
      '/api/v1/site-settings',
    ]);
    expect(requests[0]?.body).toEqual({
      sourceId: source.id,
      preset: 'site-icons',
    });
    const completeMedia = MediaSourceResourceSchema.parse(
      await (
        await page.request.get(
          `${environment.url}/api/v1/media/sources/${source.id}`,
        )
      ).json(),
    );
    expect(completeMedia.sourceSha256).toBe(source.sourceSha256);
    expect(
      completeMedia.asset?.outputs.some((output) =>
        output.publicPath.endsWith('/mask-icon.svg'),
      ),
    ).toBe(true);
    requests.length = 0;
    await icons
      .getByLabel('淺色模式瀏覽器色彩', { exact: true })
      .fill('#dde0d1');
    await saveSettings(page);
    expect(requests.map((request) => request.path)).toEqual([
      '/api/v1/site-settings',
    ]);
    requests.length = 0;
    await icons.getByLabel('產生多尺寸圖示', { exact: true }).uncheck();
    await saveSettings(page);
    expect(requests.map((request) => request.path)).toEqual([
      '/api/v1/site-settings',
    ]);
  } finally {
    await environment.close();
  }
});
