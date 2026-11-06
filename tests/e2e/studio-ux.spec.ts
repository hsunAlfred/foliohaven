import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  ArticleMetaSchema,
  JobSchema,
  MediaSourceResourceSchema,
} from '@foliohaven/core';
import type { MediaSourceResource } from '@foliohaven/core';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { studioEnvironment } from '../fixtures/studio/environment.js';

const sharp = createRequire(join(process.cwd(), 'server/package.json'))(
  'sharp',
) as NativeImageFactory;
type Environment = Awaited<ReturnType<typeof studioEnvironment>>;

test.use({ viewport: { width: 1536, height: 1000 } });

async function imageBytes() {
  return sharp({
    create: { width: 1500, height: 900, channels: 3, background: '#748475' },
  })
    .png()
    .toBuffer();
}
async function seedMedia(
  page: Page,
  environment: Environment,
  kind: 'image' | 'video' = 'image',
) {
  const bytes =
    kind === 'image'
      ? await imageBytes()
      : await readFile(
          join(
            process.cwd(),
            'tests/fixtures/samples/reference/media/source/68789bc2-e491-4dbe-81de-f1a42adb7234/original.mp4',
          ),
        );
  const upload = await page.request.post(
    `${environment.url}/api/v1/media/sources`,
    {
      headers: { Origin: environment.url, 'Idempotency-Key': randomUUID() },
      multipart: {
        file: {
          name: kind === 'image' ? 'ux.png' : 'ux.mp4',
          mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
          buffer: bytes,
        },
        displayName: kind === 'image' ? '日光圖片' : '窗邊影片',
      },
    },
  );
  expect(upload.status()).toBe(201);
  const source = MediaSourceResourceSchema.parse(await upload.json());
  const started = await page.request.post(
    `${environment.url}/api/v1/media-jobs`,
    {
      headers: { Origin: environment.url, 'Idempotency-Key': randomUUID() },
      data: {
        sourceId: source.id,
        preset: kind === 'image' ? 'article-image' : 'article-video',
      },
    },
  );
  expect(started.status()).toBe(202);
  const job = JobSchema.parse(await started.json());
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
  return MediaSourceResourceSchema.parse(
    await (
      await page.request.get(
        `${environment.url}/api/v1/media/sources/${source.id}`,
      )
    ).json(),
  );
}
async function openArticle(page: Page, environment: Environment) {
  await page.goto(environment.url);
  await page.locator('tr[data-article-id="one"] .article-title-button').click();
  await expect(
    page.getByRole('textbox', { name: 'HTML 正文', exact: true }),
  ).toBeVisible();
}
async function editBody(page: Page, html: string) {
  const editor = page.getByRole('textbox', { name: 'HTML 正文', exact: true });
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(html);
}
async function saveArticle(page: Page) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().endsWith('/api/v1/articles/one'),
  );
  await page.getByRole('button', { name: '保存目前內容', exact: true }).click();
  expect((await saved).status()).toBe(200);
}
async function readMeta(environment: Environment) {
  return ArticleMetaSchema.parse(
    JSON.parse(
      await readFile(
        join(environment.root, 'content/articles/one/meta.json'),
        'utf8',
      ),
    ),
  );
}

test('圖片下拉：真圖片尺寸變體、影片Poster、null與缺失引用保留', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const image = await seedMedia(page, environment);
    const video = await seedMedia(page, environment, 'video');
    const missing = `/media/${randomUUID()}/image.webp`;
    await writeFile(
      join(environment.root, 'content/articles/one/meta.json'),
      JSON.stringify({
        ...(await readMeta(environment)),
        featuredImage: missing,
      }),
    );
    await openArticle(page, environment);
    const featured = page.getByRole('combobox', {
      name: '精選圖片',
      exact: true,
    });
    await expect(
      page
        .locator('.image-select')
        .filter({ has: page.getByLabel('精選圖片', { exact: true }) })
        .getByText('這張圖片已不存在或還不能使用。原選擇仍保留，請重新選擇。'),
    ).toBeVisible();
    await featured.click();
    await page.getByRole('searchbox', { name: '搜尋精選圖片' }).fill('不存在');
    await page
      .getByRole('dialog', { name: '選擇精選圖片', exact: true })
      .getByRole('button', { name: '搜尋', exact: true })
      .click();
    await expect(
      page.getByText('找不到符合條件的圖片，可以調整搜尋或上傳一張。'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(featured).toBeFocused();
    await saveArticle(page);
    expect((await readMeta(environment)).featuredImage).toBe(missing);
    await featured.click();
    const picker = page.getByRole('dialog', {
      name: '選擇精選圖片',
      exact: true,
    });
    await picker
      .getByRole('button', { name: image.displayName, exact: true })
      .click();
    await picker
      .locator('input[type="radio"][value$="image-480.webp"]')
      .check();
    await picker
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();
    await saveArticle(page);
    expect((await readMeta(environment)).featuredImage).toBe(
      `/media/${image.id}/image-480.webp`,
    );
    const og = page.getByRole('combobox', { name: 'OG Image', exact: true });
    await og.click();
    const ogPicker = page.getByRole('dialog', {
      name: '選擇OG Image',
      exact: true,
    });
    await ogPicker
      .getByRole('button', {
        name: `${video.displayName} · 影片封面`,
        exact: true,
      })
      .click();
    await ogPicker
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();
    await saveArticle(page);
    expect((await readMeta(environment)).seo.ogImage).toBe(
      `/media/${video.id}/poster.webp`,
    );
    await featured.click();
    await page
      .getByRole('dialog', { name: '選擇精選圖片', exact: true })
      .getByRole('button', { name: /不使用精選圖片/ })
      .click();
    await saveArticle(page);
    const meta = await readMeta(environment);
    expect(meta.featuredImage).toBeNull();
    expect(meta.seo.ogImage).toBe(`/media/${video.id}/poster.webp`);
    const thumbnail = og.locator('img');
    await expect(thumbnail).toBeVisible();
    await expect
      .poll(() =>
        thumbnail.evaluate(
          (element) => (element as HTMLImageElement).naturalWidth,
        ),
      )
      .toBeGreaterThan(0);
  } finally {
    await environment.close();
  }
});

test('圖片下拉集合契約：超過一頁、搜尋、鍵盤選擇與讀取失敗不清空', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const real = await seedMedia(page, environment);
    // Only this collection is synthetic: 12 private UI-contract records precede
    // one real media record. Selection and its file still use the real API.
    const synthetic: MediaSourceResource[] = Array.from(
      { length: 12 },
      (_, index) => {
        const id = randomUUID();
        return MediaSourceResourceSchema.parse({
          ...real,
          id,
          displayName: `分頁圖片 ${String(index + 1).padStart(2, '0')}`,
          asset: real.asset
            ? {
                ...real.asset,
                id,
                outputs: real.asset.outputs.map((output) => ({
                  ...output,
                  publicPath: output.publicPath.replace(real.id, id),
                })),
              }
            : null,
        });
      },
    );
    const records = [...synthetic, real];
    let fail = false;
    const observed: { page: number; q: string }[] = [];
    await page.route('**/api/v1/media/sources?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('pageSize') !== '12') {
        await route.continue();
        return;
      }
      const current = Number(url.searchParams.get('page') ?? 1);
      const q = url.searchParams.get('q') ?? '';
      observed.push({ page: current, q });
      if (fail) {
        await route.fulfill({
          status: 422,
          json: {
            error: {
              code: 'UX_QUERY_FAILED',
              message: '隔離的圖片讀取失敗。',
              issues: [],
              retryable: false,
              requestId: randomUUID(),
            },
          },
        });
        return;
      }
      const matching = records.filter((source) =>
        source.displayName.includes(q),
      );
      await route.fulfill({
        json: {
          items: matching.slice((current - 1) * 12, current * 12),
          total: matching.length,
          page: current,
          pageSize: 12,
        },
      });
    });
    await openArticle(page, environment);
    const featured = page.getByRole('combobox', {
      name: '精選圖片',
      exact: true,
    });
    await featured.click();
    const menu = page.getByRole('dialog', {
      name: '選擇精選圖片',
      exact: true,
    });
    await expect(menu.getByText('第 1／2 頁，共 13 筆')).toBeVisible();
    await menu.getByRole('button', { name: '下一頁', exact: true }).click();
    await expect(menu.getByText('第 2／2 頁，共 13 筆')).toBeVisible();
    await menu
      .getByRole('button', { name: real.displayName, exact: true })
      .click();
    await menu.locator('input[type=radio][value$="/image.webp"]').check();
    await menu
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();
    await expect(featured).toContainText(real.displayName);
    await featured.click();
    await menu.getByRole('searchbox').fill('日光');
    await menu.getByRole('button', { name: '搜尋', exact: true }).click();
    await expect(menu.getByText('第 1／1 頁，共 1 筆')).toBeVisible();
    expect(observed).toContainEqual({ page: 2, q: '' });
    expect(observed).toContainEqual({ page: 1, q: '日光' });
    await page.keyboard.press('Escape');
    await featured.press('ArrowDown');
    await expect(menu).toBeVisible();
    expect(
      await menu.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(featured).toBeFocused();
    fail = true;
    await featured.click();
    await expect(menu.getByRole('alert')).toContainText('UX_QUERY_FAILED');
    await page.keyboard.press('Escape');
    await expect(featured).toContainText(real.displayName);
    await saveArticle(page);
    expect((await readMeta(environment)).featuredImage).toBe(
      `/media/${real.id}/image.webp`,
    );
  } finally {
    await environment.close();
  }
});

test('媒體Dialog：Escape未保存保護、焦點還原、未知結果留存與同key重送', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const bytes = await imageBytes();
    await page.goto(environment.url);
    await page.getByRole('button', { name: '媒體庫', exact: true }).click();
    const upload = page.getByRole('button', { name: '上傳媒體', exact: true });
    await upload.click();
    const dialog = page.getByRole('dialog', { name: '上傳媒體', exact: true });
    await dialog.getByLabel('選擇媒體檔案').setInputFiles({
      name: 'local.png',
      mimeType: 'image/png',
      buffer: bytes,
    });
    let confirmation = page
      .waitForEvent('dialog')
      .then((value) => value.dismiss());
    await page.keyboard.press('Escape');
    await confirmation;
    await expect(dialog).toBeVisible();
    confirmation = page.waitForEvent('dialog').then((value) => value.accept());
    await page.keyboard.press('Escape');
    await confirmation;
    await expect(dialog).toHaveCount(0);
    await expect(upload).toBeFocused();
    await upload.click();
    await dialog.getByLabel('選擇媒體檔案').setInputFiles({
      name: 'retry.png',
      mimeType: 'image/png',
      buffer: bytes,
    });
    const keys: string[] = [];
    await page.route('**/api/v1/media/sources', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (keys.length === 1)
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'UX_UNCONFIRMED',
              message: '隔離的上傳結果未確認。',
              issues: [],
              retryable: true,
              requestId: randomUUID(),
            },
          },
        });
      else await route.continue();
    });
    await dialog.getByRole('button', { name: '上傳媒體', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: '重試上傳' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        '上傳結果尚未確認。請先重試上傳，或選擇結束重試後再關閉。',
      ),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('upload-pending-dialog.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: '重試上傳' }).click();
    await expect(
      page.getByRole('dialog', { name: '媒體設定與引用' }),
    ).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe('');
    expect(keys[1]).toBe(keys[0]);
    const collection = await page.request.get(
      `${environment.url}/api/v1/media/sources`,
    );
    const data = (await collection.json()) as { total: number };
    expect(data.total).toBe(1);
  } finally {
    await environment.close();
  }
});

test('媒體Dialog：重試介面出現時關閉守門已同步', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(environment.url);
    await page.getByRole('button', { name: '媒體庫', exact: true }).click();
    await page.getByRole('button', { name: '上傳媒體', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '上傳媒體', exact: true });
    await dialog.getByLabel('選擇媒體檔案').setInputFiles({
      name: 'pending.png',
      mimeType: 'image/png',
      buffer: await imageBytes(),
    });
    await page.route('**/api/v1/media/sources', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'UX_UNCONFIRMED',
            message: '隔離的上傳結果未確認。',
            issues: [],
            retryable: true,
            requestId: randomUUID(),
          },
        },
      });
    });
    await dialog.evaluate((element) => {
      // 在重試介面首次 commit 時送出 cancel，不能等父層 passive effect
      // 或先等待關閉按鈕 enabled，否則會錯過使用者已可操作的狀態窗口。
      const observer = new MutationObserver(() => {
        const retry = [...element.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === '重試上傳',
        );
        if (!retry) return;
        observer.disconnect();
        const close = element.querySelector<HTMLButtonElement>('.dialog-close');
        element.setAttribute(
          'data-close-disabled-at-retry',
          String(close?.disabled),
        );
        element.dispatchEvent(new Event('cancel', { cancelable: true }));
      });
      observer.observe(element, { childList: true, subtree: true });
    });
    await dialog.getByRole('button', { name: '上傳媒體', exact: true }).click();
    await expect(dialog).toHaveAttribute(
      'data-close-disabled-at-retry',
      'false',
    );
    await expect(
      dialog.getByText(
        '上傳結果尚未確認。請先重試上傳，或選擇結束重試後再關閉。',
      ),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: '重試上傳' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: '關閉上傳媒體' }),
    ).toBeEnabled();
  } finally {
    await environment.close();
  }
});

test('390px編輯：多行欄位、選圖保留正文、預覽失敗清楚且可重試', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let releaseLargeImage = () => {};
  const largeImageRelease = new Promise<void>((resolve) => {
    releaseLargeImage = resolve;
  });
  let captureLargeImage = () => {};
  const largeImageRequested = new Promise<void>((resolve) => {
    captureLargeImage = resolve;
  });
  try {
    const source = await seedMedia(page, environment);
    // Keep the real full-size preview pending to expose image-load layout shifts.
    await page.route(
      `**/api/v1/media/files/${source.id}/image.webp`,
      async (route) => {
        const response = await route.fetch();
        captureLargeImage();
        await largeImageRelease;
        await route.fulfill({ response });
      },
    );
    const original = await readFile(
      join(environment.root, 'content/articles/one/content.html'),
      'utf8',
    );
    await writeFile(
      join(environment.root, 'content/articles/one/meta.json'),
      JSON.stringify({
        ...(await readMeta(environment)),
        status: 'published',
        publishedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await openArticle(page, environment);
    await page.getByRole('tab', { name: '預覽', exact: true }).click();
    const preview = page.locator('.editor-preview');
    await expect(
      page
        .frameLocator('iframe[title="文章即時預覽"]')
        .getByRole('heading', { name: '開始', exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByText('沒有診斷問題。', { exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: '正文', exact: true }).click();
    let failNext = true;
    await page.route('**/api/v1/previews', async (route) => {
      if (failNext) {
        failNext = false;
        await route.fulfill({
          status: 500,
          json: {
            error: {
              code: 'INTERNAL_ERROR',
              message: '隔離的預覽失敗。',
              issues: [],
              retryable: true,
              requestId: randomUUID(),
            },
          },
        });
      } else await route.continue();
    });
    const html =
      '<h2 id="retained">選圖後仍在的未保存正文</h2><p>只保留在編輯器。</p>';
    await editBody(page, html);
    await page.getByRole('tab', { name: '預覽', exact: true }).click();
    await expect(preview.getByRole('alert')).toContainText('INTERNAL_ERROR');
    await expect(
      preview.getByText('目前顯示上一次成功的預覽。', { exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByText('沒有診斷問題。', { exact: true }),
    ).toHaveCount(0);
    await preview
      .getByRole('button', { name: '重新產生預覽', exact: true })
      .click();
    await expect(
      page
        .frameLocator('iframe[title="文章即時預覽"]')
        .getByRole('heading', { name: '選圖後仍在的未保存正文' }),
    ).toBeVisible();
    await page.getByRole('tab', { name: '文章設定', exact: true }).click();
    const description = page.getByLabel('Meta Description', { exact: true });
    await expect(description).toHaveAttribute('rows', '3');
    await expect(
      page.getByLabel('精選圖片 Alt（空白可作裝飾）', { exact: true }),
    ).toHaveAttribute('rows', '2');
    const featured = page.getByRole('combobox', {
      name: '精選圖片',
      exact: true,
    });
    await featured.click();
    const picker = page.getByRole('dialog', {
      name: '選擇精選圖片',
      exact: true,
    });
    await picker
      .getByRole('button', { name: source.displayName, exact: true })
      .click();
    const useSize = picker.getByRole('button', {
      name: '使用這個尺寸',
      exact: true,
    });
    await largeImageRequested;
    await useSize.scrollIntoViewIfNeeded();
    const beforeImage = await useSize.boundingBox();
    expect(beforeImage).not.toBeNull();
    releaseLargeImage();
    const largeImage = picker.locator('.image-picker__large-preview img');
    await expect
      .poll(() =>
        largeImage.evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true);
    const afterImage = await useSize.boundingBox();
    expect(afterImage).not.toBeNull();
    if (!beforeImage || !afterImage)
      throw new Error('Image action bounds missing');
    // Loading must not move the pointer target between pointerdown and pointerup.
    expect(Math.abs(afterImage.y - beforeImage.y)).toBeLessThanOrEqual(1);
    await useSize.click();
    await expect(picker).not.toBeVisible();
    await expect(featured).toContainText(source.displayName);
    await featured.click();
    await expect(picker).toBeVisible();
    await expect(
      picker.getByRole('button', { name: source.displayName, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath('mobile-image-select.png'),
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      await description.evaluate(
        (element) => element.getBoundingClientRect().width,
      ),
    ).toBeLessThan(390);
    await page.getByRole('tab', { name: '正文', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: 'HTML 正文', exact: true }),
    ).toContainText('選圖後仍在的未保存正文');
    expect(
      await readFile(
        join(environment.root, 'content/articles/one/content.html'),
        'utf8',
      ),
    ).toBe(original);
    await page.screenshot({
      path: test.info().outputPath('mobile-editor-retained.png'),
      fullPage: true,
    });
  } finally {
    releaseLargeImage();
    await page.unrouteAll({ behavior: 'wait' });
    await environment.close();
  }
});
