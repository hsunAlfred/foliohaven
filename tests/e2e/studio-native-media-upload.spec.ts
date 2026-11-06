import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
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
const formats = [
  {
    format: 'SVG',
    filename: 'brand-native.svg',
    uploadMime: 'image/svg+xml',
    mime: 'image/svg+xml',
    variant: 'image.svg',
    nativeLabel: /SVG.*向量圖/u,
  },
  {
    format: 'ICO',
    filename: 'brand-native.ico',
    uploadMime: 'image/vnd.microsoft.icon',
    mime: 'image/x-icon',
    variant: 'favicon.ico',
    nativeLabel: /ICO.*原生圖示/u,
  },
] as const;

async function nativeFixture(format: (typeof formats)[number]['format']) {
  if (format === 'SVG')
    return Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-labelledby="fixture-title">' +
        '<title id="fixture-title">Native media fixture</title>' +
        '<rect width="512" height="512" fill="#e9e4dc"/>' +
        '<circle cx="256" cy="256" r="160" fill="#6d5b79"/></svg>',
    );
  const sharp = createRequire(join(process.cwd(), 'server/package.json'))(
    'sharp',
  ) as NativeImageFactory;
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = await Promise.all(
    sizes.map((size) =>
      sharp({
        create: {
          width: size,
          height: size,
          channels: 4,
          background: '#6d5b79',
        },
      })
        .png()
        .toBuffer(),
    ),
  );
  // Build a standard ICO directory independently of the production encoder.
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  for (const [index, frame] of frames.entries()) {
    const size = sizes[index];
    if (size === undefined) throw new Error('Missing ICO fixture frame size');
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frame.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  }
  return Buffer.concat([directory, ...frames]);
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

async function processedSource(
  page: Page,
  environment: Environment,
  id: string,
) {
  const detail = page.getByRole('dialog', {
    name: '媒體設定與引用',
    exact: true,
  });
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/media-jobs',
  );
  await detail.getByRole('button', { name: '處理媒體', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const job = JobSchema.parse(await response.json());
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
  const preview = detail.getByAltText('媒體處理預覽', { exact: true });
  await expect(preview).toHaveAttribute('src', /\/image\.webp$/u);
  await expect
    .poll(() =>
      preview.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  const current = await page.request.get(
    `${environment.url}/api/v1/media/sources/${id}`,
  );
  expect(current.status()).toBe(200);
  return MediaSourceResourceSchema.parse(await current.json());
}

for (const format of formats) {
  test(`${format.format}：Studio選檔、處理、WebP預覽及原生favicon／PNG32保存重讀`, async ({
    page,
  }) => {
    const environment = await studioEnvironment();
    try {
      const originalBody = await readFile(
        join(environment.root, 'content/articles/one/content.html'),
      );
      const bytes = await nativeFixture(format.format);
      const displayName = `${format.format}原生媒體驗證`;
      await page.goto(`${environment.url}/#/media`);
      await page.getByRole('button', { name: '上傳媒體', exact: true }).click();
      const upload = page.getByRole('dialog', {
        name: '上傳媒體',
        exact: true,
      });
      const input = upload.getByLabel('選擇媒體檔案', { exact: true });
      await expect(input).toHaveAttribute('accept', /\.svg/u);
      await expect(input).toHaveAttribute('accept', /\.ico/u);
      const choosing = page.waitForEvent('filechooser');
      await input.click();
      await (
        await choosing
      ).setFiles({
        name: format.filename,
        mimeType: format.uploadMime,
        buffer: bytes,
      });
      // Unvalidated native inputs are never rendered as a browser blob preview.
      await expect(upload.locator('.media-upload__preview')).toHaveCount(0);
      await expect(
        upload.getByText('SVG 與 ICO 會在上傳並通過檢查後提供預覽。', {
          exact: true,
        }),
      ).toBeVisible();
      await upload
        .getByLabel('上傳顯示名稱（選填）', { exact: true })
        .fill(displayName);
      const uploaded = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/media/sources',
      );
      await upload
        .getByRole('button', { name: '上傳媒體', exact: true })
        .click();
      const response = await uploaded;
      expect(response.status()).toBe(201);
      const source = MediaSourceResourceSchema.parse(await response.json());
      expect(source.mimeType).toBe(format.mime);
      expect(source.sourceSha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(
        await readFile(
          join(
            environment.root,
            'media/source',
            source.id,
            `original.${format.format.toLowerCase()}`,
          ),
        ),
      ).toEqual(bytes);
      const ready = await processedSource(page, environment, source.id);
      expect(ready.asset?.presetVersion).toBe('article-image-v3');
      const native = ready.asset?.outputs.find((output) =>
        output.publicPath.endsWith(`/${format.variant}`),
      );
      if (!native) throw new Error(`Missing native ${format.format} output`);
      expect(native.mimeType).toBe(format.mime);
      const served = await page.request.get(
        environment.url +
          native.publicPath.replace('/media/', '/api/v1/media/files/'),
      );
      expect(served.status()).toBe(200);
      expect(served.headers()['content-type']).toContain(format.mime);
      const servedBytes = await served.body();
      if (format.format === 'ICO') {
        expect(ready).toMatchObject({ width: 256, height: 256 });
        expect(Array.from(servedBytes.subarray(0, 4))).toEqual([0, 0, 1, 0]);
        const count = servedBytes.readUInt16LE(4);
        expect(count).toBe(6);
        expect(
          Array.from({ length: count }, (_, index) => {
            const offset = 6 + index * 16;
            return [servedBytes[offset] || 256, servedBytes[offset + 1] || 256];
          }),
        ).toEqual([16, 32, 48, 64, 128, 256].map((size) => [size, size]));
      } else {
        expect(servedBytes.toString('utf8')).toContain('<svg');
        expect(served.headers()['content-security-policy']).toContain(
          "default-src 'none'",
        );
        expect(served.headers()['content-security-policy']).toContain(
          'sandbox',
        );
      }
      await page
        .getByRole('dialog', { name: '媒體設定與引用', exact: true })
        .getByRole('button', { name: '關閉媒體設定與引用', exact: true })
        .click();
      const card = page.getByRole('button', { name: displayName, exact: true });
      await expect(card).toContainText('可引用');
      await expect(card.locator('img')).toHaveAttribute(
        'src',
        /\/image(?:-[1-9]\d*)?\.webp$/u,
      );

      await page.goto(`${environment.url}/#/settings`);
      const general = await chooseSettingsSection(page, 'general');
      const icon = general.getByRole('combobox', {
        name: '主圖（Favicon）',
        exact: true,
      });
      await icon.click();
      const picker = page.getByRole('dialog', {
        name: '選擇主圖（Favicon）',
        exact: true,
      });
      await picker
        .getByRole('button', { name: displayName, exact: true })
        .click();
      const nativeRadio = picker.getByRole('radio', {
        name: format.nativeLabel,
      });
      await expect(nativeRadio).toBeChecked();
      expect(await nativeRadio.inputValue()).toBe(native.publicPath);
      const nativePreview = picker.locator('.image-picker__large-preview img');
      await expect
        .poll(() =>
          nativePreview.evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
        )
        .toBe(true);
      await picker
        .getByRole('button', { name: '使用這個尺寸', exact: true })
        .click();
      expect((await saveSettings(page)).favicon).toBe(native.publicPath);
      await page.reload();
      await chooseSettingsSection(page, 'general');
      await expect(icon).toContainText(displayName);

      await icon.click();
      await picker
        .getByRole('button', { name: displayName, exact: true })
        .click();
      await expect(nativeRadio).toBeChecked();
      const png = picker.getByRole('radio', { name: /^32 × 32.*PNG/u });
      await png.check();
      const pngPath = await png.inputValue();
      expect(pngPath).toBe(`/media/${source.id}/favicon.png`);
      await picker
        .getByRole('button', { name: '使用這個尺寸', exact: true })
        .click();
      expect((await saveSettings(page)).favicon).toBe(pngPath);
      await page.reload();
      await chooseSettingsSection(page, 'general');
      await expect(icon).toContainText('32 × 32');
      await icon.click();
      await picker
        .getByRole('button', { name: displayName, exact: true })
        .click();
      await expect(png).toBeChecked();
      await expect(nativeRadio).not.toBeChecked();
      expect(
        SiteConfigSchema.parse(
          JSON.parse(
            await readFile(join(environment.root, 'content/site.json'), 'utf8'),
          ),
        ).favicon,
      ).toBe(pngPath);
      expect(
        await readFile(
          join(environment.root, 'content/articles/one/content.html'),
        ),
      ).toEqual(originalBody);
    } finally {
      await environment.close();
    }
  });
}

test('不安全SVG上傳遭拒，沒有來源新增或原始SVG預覽', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    const before = await page.request.get(
      `${environment.url}/api/v1/media/sources?pageSize=100`,
    );
    expect(before.status()).toBe(200);
    const initial = (await before.json()) as { total: number };
    await page.goto(`${environment.url}/#/media`);
    await page.getByRole('button', { name: '上傳媒體', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '上傳媒體', exact: true });
    await upload.getByLabel('選擇媒體檔案', { exact: true }).setInputFiles({
      name: 'unsafe.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><script>alert("unsafe")</script><rect width="32" height="32"/></svg>',
      ),
    });
    await expect(upload.locator('.media-upload__preview')).toHaveCount(0);
    const rejected = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/media/sources',
    );
    await upload.getByRole('button', { name: '上傳媒體', exact: true }).click();
    const response = await rejected;
    expect(response.status()).toBe(422);
    expect(ApiErrorSchema.parse(await response.json()).error.code).toBe(
      'MEDIA_SVG_UNSAFE',
    );
    const after = await page.request.get(
      `${environment.url}/api/v1/media/sources?pageSize=100`,
    );
    expect(after.status()).toBe(200);
    expect(((await after.json()) as { total: number }).total).toBe(
      initial.total,
    );
    await expect(
      page.getByRole('dialog', { name: '媒體設定與引用', exact: true }),
    ).toHaveCount(0);
  } finally {
    await environment.close();
  }
});
