import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ArticleMetaSchema,
  JobSchema,
  MediaSourceResourceSchema,
} from '@foliohaven/core';
import type { MediaSourceResource } from '@foliohaven/core';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { studioEnvironment } from '../fixtures/studio/environment.js';

type Environment = Awaited<ReturnType<typeof studioEnvironment>>;
const sharp = createRequire(join(process.cwd(), 'server/package.json'))(
  'sharp',
) as NativeImageFactory;
const videoFile = join(
  process.cwd(),
  'tests/fixtures/samples/reference/media/source/68789bc2-e491-4dbe-81de-f1a42adb7234/original.mp4',
);
async function seed(
  page: Page,
  environment: Environment,
  kind: 'image' | 'video' = 'image',
) {
  const bytes =
    kind === 'image'
      ? await sharp({
          create: {
            width: 1500,
            height: 900,
            channels: 3,
            background: '#698475',
          },
        })
          .png()
          .toBuffer()
      : await readFile(videoFile);
  const response = await page.request.post(
    `${environment.url}/api/v1/media/sources`,
    {
      headers: { Origin: environment.url, 'Idempotency-Key': randomUUID() },
      multipart: {
        file: {
          name: kind === 'image' ? 'light.png' : 'window.mp4',
          mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
          buffer: bytes,
        },
        displayName: kind === 'image' ? '日光圖片' : '窗邊影片',
      },
    },
  );
  expect(response.status()).toBe(201);
  const source = MediaSourceResourceSchema.parse(await response.json());
  const work = await page.request.post(`${environment.url}/api/v1/media-jobs`, {
    headers: { Origin: environment.url, 'Idempotency-Key': randomUUID() },
    data: {
      sourceId: source.id,
      preset: kind === 'image' ? 'article-image' : 'article-video',
    },
  });
  expect(work.status()).toBe(202);
  const queued = JobSchema.parse(await work.json());
  await expect
    .poll(
      async () =>
        JobSchema.parse(
          await (
            await page.request.get(
              `${environment.url}/api/v1/jobs/${queued.id}`,
            )
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
  if ((page.viewportSize()?.width ?? 1280) > 1000)
    await page.setViewportSize({ width: 1536, height: 1000 });
  await page.goto(`${environment.url}/#/articles/one`);
  await expect(
    page.getByRole('heading', { name: '編輯文章：文章', exact: true }),
  ).toBeVisible();
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
async function save(page: Page) {
  const response = page.waitForResponse(
    (value) =>
      value.request().method() === 'PUT' &&
      value.url().endsWith('/api/v1/articles/one'),
  );
  await page.getByRole('button', { name: '保存目前內容', exact: true }).click();
  expect((await response).status()).toBe(200);
}
const output = (source: MediaSourceResource, suffix: string) => {
  const item = source.asset?.outputs.find((value) =>
    value.publicPath.endsWith(suffix),
  );
  if (!item) throw new Error(`Missing isolated fixture output ${suffix}`);
  return item;
};

test('選圖彈窗：精選圖只列圖片，同圖尺寸分組，OG仍可選影片封面', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const image = await seed(page, environment);
    const video = await seed(page, environment, 'video');
    const small = output(image, '/image-480.webp');
    const poster = output(video, '/poster.webp');
    const bodyPath = join(
      environment.root,
      'content/articles/one/content.html',
    );
    const originalBody = await readFile(bodyPath);
    const observedTypes: (string | null)[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        url.pathname === '/api/v1/media/sources' &&
        request.method() === 'GET'
      )
        observedTypes.push(url.searchParams.get('type'));
    });
    await openArticle(page, environment);
    const featured = page.getByRole('combobox', {
      name: '精選圖片',
      exact: true,
      includeHidden: true,
    });
    await featured.click();
    const picker = page.getByRole('dialog', {
      name: '選擇精選圖片',
      exact: true,
    });
    await expect(picker).toBeVisible();
    await expect(picker.locator('.image-picker__grid > li')).toHaveCount(1);
    await expect(
      picker.getByRole('button', { name: '窗邊影片 · 影片封面', exact: true }),
    ).toHaveCount(0);
    expect(observedTypes).toContain('image');
    await picker.getByRole('button', { name: '日光圖片', exact: true }).click();
    await expect(
      picker
        .getByRole('group', { name: '選擇圖片尺寸', exact: true })
        .getByRole('radio'),
    ).toHaveCount(
      image.asset?.outputs.filter((item) => item.mimeType.startsWith('image/'))
        .length ?? 0,
    );
    await picker
      .getByRole('radio', {
        name: new RegExp(`^${small.width} × ${small.height}`),
      })
      .check();
    // Merely changing an unconfirmed size must not update the article form.
    await expect(featured).not.toContainText('日光圖片');
    await picker
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();
    await expect(picker).toHaveCount(0);
    await expect(featured).toBeFocused();
    await expect(featured).toContainText('日光圖片');
    await save(page);
    expect((await readMeta(environment)).featuredImage).toBe(small.publicPath);
    const og = page.getByRole('combobox', { name: 'OG Image', exact: true });
    await expect(og).toContainText('日光圖片');
    await expect(og).toContainText(`${small.width} × ${small.height}`);
    await og.click();
    const sharing = page.getByRole('dialog', {
      name: '選擇OG Image',
      exact: true,
    });
    await expect(sharing.locator('.image-picker__grid > li')).toHaveCount(2);
    await sharing
      .getByRole('button', { name: '窗邊影片 · 影片封面', exact: true })
      .click();
    await sharing
      .getByRole('radio', {
        name: new RegExp(`^${poster.width} × ${poster.height}`),
      })
      .check();
    await sharing
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();
    await save(page);
    const meta = await readMeta(environment);
    expect(meta.featuredImage).toBe(small.publicPath);
    expect(meta.seo.ogImage).toBe(poster.publicPath);
    expect(await readFile(bodyPath)).toEqual(originalBody);
  } finally {
    await environment.close();
  }
});

test('精選圖舊影片封面與失效值：讀取或取消選圖不會清除原設定', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const video = await seed(page, environment, 'video');
    const poster = output(video, '/poster.webp');
    const path = join(environment.root, 'content/articles/one/meta.json');
    await writeFile(
      path,
      JSON.stringify({
        ...(await readMeta(environment)),
        featuredImage: poster.publicPath,
      }),
    );
    const original = await readFile(path);
    await openArticle(page, environment);
    const featured = page.getByRole('combobox', {
      name: '精選圖片',
      exact: true,
    });
    await expect(
      page.getByText(
        '目前選用的是影片封面。精選圖片只接受圖片，請選擇另一張；保存前不會自動變更。',
        { exact: true },
      ),
    ).toBeVisible();
    await featured.click();
    const picker = page.getByRole('dialog', {
      name: '選擇精選圖片',
      exact: true,
    });
    await expect(
      picker.getByText('找不到符合條件的圖片，可以調整搜尋或上傳一張。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(picker.locator('.image-picker__grid > li')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(featured).toBeFocused();
    expect(await readFile(path)).toEqual(original);
    await page.route('**/api/v1/media/sources?*', async (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'PICKER_READ_FAILED',
            message: '隔離的媒體讀取失敗。',
            retryable: true,
            issues: [],
            requestId: randomUUID(),
          },
        },
      }),
    );
    await featured.click();
    await expect(picker.getByRole('alert')).toContainText('PICKER_READ_FAILED');
    await page.keyboard.press('Escape');
    expect(await readFile(path)).toEqual(original);
    expect((await readMeta(environment)).featuredImage).toBe(poster.publicPath);
    const missingPath = `/media/${randomUUID()}/image.webp`;
    await writeFile(
      path,
      JSON.stringify({
        ...(await readMeta(environment)),
        featuredImage: missingPath,
      }),
    );
    const missingBytes = await readFile(path);
    await page.reload();
    await expect(
      featured
        .locator('..')
        .getByText('這張圖片已不存在或還不能使用。原選擇仍保留，請重新選擇。', {
          exact: true,
        }),
    ).toBeVisible();
    await featured.click();
    await expect(picker.getByRole('alert')).toContainText('PICKER_READ_FAILED');
    await page.keyboard.press('Escape');
    expect(await readFile(path)).toEqual(missingBytes);
    expect((await readMeta(environment)).featuredImage).toBe(missingPath);
  } finally {
    await environment.close();
  }
});

test('手機選圖與預設值：真分頁契約、返回列表、搜尋與沿用預設不丟正文', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const image = await seed(page, environment);
    const main = output(image, '/image.webp');
    const small = output(image, '/image-768.webp');
    const sitePath = join(environment.root, 'content/site.json');
    const site = JSON.parse(await readFile(sitePath, 'utf8')) as {
      social: { defaultImage: string | null };
    };
    await writeFile(
      sitePath,
      JSON.stringify({
        ...site,
        social: { ...site.social, defaultImage: main.publicPath },
      }),
    );
    // Synthetic collection only exercises pagination/UI; every saved selection uses the real final item.
    const synthetic = Array.from({ length: 12 }, (_, index) => {
      const id = randomUUID();
      return {
        ...image,
        id,
        displayName: `合成圖片 ${index + 1}`,
        asset: image.asset
          ? {
              ...image.asset,
              id,
              outputs: image.asset.outputs.map((item) => ({
                ...item,
                publicPath: item.publicPath.replace(image.id, id),
              })),
            }
          : null,
      };
    });
    const records = [...synthetic, image];
    const observed: { page: number; q: string }[] = [];
    await page.route('**/api/v1/media/sources?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('pageSize') !== '12') {
        await route.continue();
        return;
      }
      const current = Number(url.searchParams.get('page') ?? 1),
        q = url.searchParams.get('q') ?? '';
      observed.push({ page: current, q });
      const items = records.filter((item) => item.displayName.includes(q));
      await route.fulfill({
        json: {
          items: items.slice((current - 1) * 12, current * 12),
          total: items.length,
          page: current,
          pageSize: 12,
        },
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await openArticle(page, environment);
    const html = '<h2 id="keep">選圖後仍保留的正文</h2><p>尚未保存。</p>';
    const editor = page.getByRole('textbox', {
      name: 'HTML 正文',
      exact: true,
    });
    await editor.click();
    await editor.press('ControlOrMeta+A');
    await page.keyboard.insertText(html);
    await page.getByRole('tab', { name: '文章設定', exact: true }).click();
    const og = page.getByRole('combobox', { name: 'OG Image', exact: true });
    await expect(og).toContainText('日光圖片');
    await og.click();
    const picker = page.getByRole('dialog', {
      name: '選擇OG Image',
      exact: true,
    });
    await expect(
      picker.getByText('第 1／2 頁，共 13 筆', { exact: true }),
    ).toBeVisible();
    await expect(picker.locator('.image-picker__grid > li')).toHaveCount(12);
    await picker.getByRole('button', { name: '下一頁', exact: true }).click();
    await expect(
      picker.getByText('第 2／2 頁，共 13 筆', { exact: true }),
    ).toBeVisible();
    await picker.getByRole('button', { name: '日光圖片', exact: true }).click();
    await expect(
      picker.getByRole('group', { name: '選擇圖片尺寸', exact: true }),
    ).toBeVisible();
    await picker
      .getByRole('button', { name: '返回圖片列表', exact: true })
      .click();
    await expect(
      picker.getByText('第 2／2 頁，共 13 筆', { exact: true }),
    ).toBeVisible();
    await picker.getByRole('searchbox').fill('日光');
    await picker.getByRole('button', { name: '搜尋', exact: true }).click();
    await expect(
      picker.getByText('第 1／1 頁，共 1 筆', { exact: true }),
    ).toBeVisible();
    await picker.getByRole('button', { name: '日光圖片', exact: true }).click();
    await picker
      .getByRole('radio', {
        name: new RegExp(`^${small.width} × ${small.height}`),
      })
      .check();
    await page.screenshot({
      path: test.info().outputPath('mobile-image-sizes.png'),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await picker
      .getByRole('button', { name: '使用這個尺寸', exact: true })
      .click();
    await page.getByRole('tab', { name: '正文', exact: true }).click();
    await expect(editor).toContainText('選圖後仍保留的正文');
    await save(page);
    expect((await readMeta(environment)).seo.ogImage).toBe(small.publicPath);
    expect(
      await readFile(
        join(environment.root, 'content/articles/one/content.html'),
        'utf8',
      ),
    ).toBe(html);
    await page.getByRole('tab', { name: '文章設定', exact: true }).click();
    await og.click();
    await picker.locator('.image-picker__default').click();
    await expect(og).toContainText('日光圖片');
    await save(page);
    expect((await readMeta(environment)).seo.ogImage).toBeNull();
    expect(observed).toContainEqual({ page: 2, q: '' });
    expect(observed).toContainEqual({ page: 1, q: '日光' });
  } finally {
    await environment.close();
  }
});

test('精選圖原地上傳：只接受圖片，拒絕影片但保持編輯內容', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    await openArticle(page, environment);
    await page.getByRole('combobox', { name: '精選圖片', exact: true }).click();
    const picker = page.getByRole('dialog', {
      name: '選擇精選圖片',
      exact: true,
    });
    await picker
      .getByRole('button', { name: '上傳新媒體', exact: true })
      .click();
    const upload = page.getByRole('dialog', { name: '上傳媒體', exact: true });
    await expect(upload.getByLabel('選擇媒體檔案')).toHaveAttribute(
      'accept',
      '.jpg,.jpeg,.png,.webp,.avif,.svg,.ico',
    );
    await upload.getByLabel('選擇媒體檔案').setInputFiles(videoFile);
    await expect(upload.getByRole('status')).toContainText('這裡只能上傳圖片');
    await expect(
      upload.getByRole('button', { name: '上傳媒體', exact: true }),
    ).toBeDisabled();
    await expect(
      upload.getByLabel('Poster 秒數（選填）', { exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await readMeta(environment)).featuredImage).toBeNull();
    const collection = await page.request.get(
      `${environment.url}/api/v1/media/sources`,
    );
    expect((await collection.json()) as { total: number }).toMatchObject({
      total: 0,
    });
  } finally {
    await environment.close();
  }
});
