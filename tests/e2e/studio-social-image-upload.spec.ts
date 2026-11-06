import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MediaSourceResourceSchema, SiteConfigSchema } from '@foliohaven/core';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { studioEnvironment } from '../fixtures/studio/environment.js';
import { chooseSettingsSection } from '../fixtures/studio/settings.js';

test.use({ viewport: { width: 1536, height: 1000 } });

test('全域分享圖：清單仍讀取時可開啟上傳、原生選檔、處理並保存尺寸', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let releaseList = () => {};
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  let listReleased = false;
  try {
    const sharp = createRequire(join(process.cwd(), 'server/package.json'))(
      'sharp',
    ) as NativeImageFactory;
    const bytes = await sharp({
      create: {
        width: 1200,
        height: 630,
        channels: 3,
        background: '#82758c',
      },
    })
      .png()
      .toBuffer();
    const articlePath = join(
      environment.root,
      'content/articles/one/content.html',
    );
    const originalBody = await readFile(articlePath);
    await page.route('**/api/v1/media/sources?*', async (route) => {
      if (route.request().method() === 'GET' && !listReleased) await listGate;
      await route.continue();
    });
    await page.goto(`${environment.url}/#/settings`);
    const settings = await chooseSettingsSection(page, 'seo');
    const socialImage = settings.getByRole('combobox', {
      name: 'Default Social Image',
      exact: true,
    });
    const listRequested = page.waitForRequest(
      (request) =>
        request.method() === 'GET' &&
        new URL(request.url()).pathname === '/api/v1/media/sources',
    );
    await socialImage.click();
    await listRequested;
    const picker = page.getByRole('dialog', {
      name: '選擇Default Social Image',
      exact: true,
    });
    await expect(picker.getByRole('status')).toHaveText('讀取圖片中…');
    const openUpload = picker.getByRole('button', {
      name: '上傳新媒體',
      exact: true,
    });
    // The server response stays withheld: this must work before it arrives.
    await expect(openUpload).toBeEnabled();
    await openUpload.click();
    const upload = page.getByRole('dialog', { name: '上傳媒體', exact: true });
    const chooseFile = page.waitForEvent('filechooser');
    await upload.getByLabel('選擇媒體檔案', { exact: true }).click();
    await (
      await chooseFile
    ).setFiles({
      name: 'global-social-image.png',
      mimeType: 'image/png',
      buffer: bytes,
    });
    await upload
      .getByLabel('上傳顯示名稱（選填）', { exact: true })
      .fill('分享圖上傳驗證');
    listReleased = true;
    releaseList();
    const uploaded = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/media/sources',
    );
    await upload.getByRole('button', { name: '上傳媒體', exact: true }).click();
    const uploadResponse = await uploaded;
    expect(uploadResponse.status()).toBe(201);
    const source = MediaSourceResourceSchema.parse(await uploadResponse.json());
    const prepare = page.getByRole('dialog', {
      name: '處理與選擇圖片',
      exact: true,
    });
    await expect(prepare).toBeVisible();
    await prepare
      .getByRole('button', { name: '處理媒體', exact: true })
      .click();
    const size = prepare.getByRole('radio', { name: /^1200 × 630.*完整補邊/ });
    await expect(size).toBeVisible({ timeout: 30000 });
    await size.check();
    await expect(
      prepare.getByRole('radio', { name: /^1200 × 630.*裁切填滿/ }),
    ).toBeVisible();
    const selectedPath = await size.inputValue();
    expect(selectedPath).toContain(`/media/${source.id}/`);
    await prepare
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();
    await expect(picker).toHaveCount(0);
    await expect(socialImage).toContainText('分享圖上傳驗證');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/v1/site-settings',
    );
    await page
      .getByRole('button', { name: '保存全站設定', exact: true })
      .click();
    expect((await saved).status()).toBe(200);
    const site = SiteConfigSchema.parse(
      JSON.parse(
        await readFile(join(environment.root, 'content/site.json'), 'utf8'),
      ),
    );
    expect(site.social.defaultImage).toBe(selectedPath);
    expect(await readFile(articlePath)).toEqual(originalBody);
    await page.reload();
    await chooseSettingsSection(page, 'seo');
    await expect(
      page.getByRole('combobox', { name: 'Default Social Image', exact: true }),
    ).toContainText('分享圖上傳驗證');
  } finally {
    listReleased = true;
    releaseList();
    await environment.close();
  }
});
