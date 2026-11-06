import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  ArticleResourceSchema,
  JobSchema,
  MediaSourceResourceSchema,
  SiteConfigSchema,
} from '@foliohaven/core';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { studioEnvironment } from '../fixtures/studio/environment.js';

test.use({ viewport: { width: 1536, height: 1000 } });

async function navigate(page: Page, label: string) {
  const target = page.getByRole('button', { name: label, exact: true });
  if (!(await target.isVisible()))
    await page.getByRole('button', { name: '開啟導覽', exact: true }).click();
  await target.click();
}
async function openArticle(page: Page) {
  await page.locator('tr[data-article-id="one"] .article-title-button').click();
  await expect(page.getByLabel('文章標題', { exact: true })).toHaveValue(
    '文章',
  );
}
/** 等待實際history traversal及React更新，不以固定sleep掩蓋歷史錯誤。 */
async function back(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error('Back未在期限內移至不同hash的返回目標')),
          5_000,
        );
        window.addEventListener(
          'hashchange',
          () => {
            window.clearTimeout(timer);
            requestAnimationFrame(() => resolve());
          },
          { once: true },
        );
        window.history.back();
      }),
  );
}
async function decideBack(page: Page, accept: boolean) {
  const decision = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await back(page);
  await decision;
}

test('Studio返回歷史：Back先關工作Dialog，再回原文章；拒絕捨棄後仍保留原返回目標', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const metadata = join(environment.root, 'content/articles/one/meta.json');
  const originalMetadata = await readFile(metadata);
  try {
    await page.goto(environment.url);
    await openArticle(page);
    await navigate(page, '網站更新與工作');
    await page.getByRole('button', { name: '更新網站', exact: true }).click();
    const detail = page.getByRole('dialog', {
      name: '工作詳細資料',
      exact: true,
    });
    await expect(detail).toBeVisible();
    await expect(
      detail.getByRole('definition').filter({ hasText: '網站更新 · 成功' }),
    ).toBeVisible();
    await back(page);
    await expect(detail).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: '網站更新與工作', exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/#\/jobs$/u);
    await back(page);
    await expect(page).toHaveURL(/#\/articles\/one$/u);
    await expect(page.getByLabel('文章標題', { exact: true })).toHaveValue(
      '文章',
    );

    await page
      .getByLabel('文章標題', { exact: true })
      .fill('尚未保存的導航修改');
    await decideBack(page, false);
    await expect(page).toHaveURL(/#\/articles\/one$/u);
    await expect(page.getByLabel('文章標題', { exact: true })).toHaveValue(
      '尚未保存的導航修改',
    );
    await decideBack(page, true);
    await expect(
      page.getByRole('heading', { name: '文章', exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('tr[data-article-id="one"] .article-title-button'),
    ).toHaveText('文章');
    expect(await readFile(metadata)).toEqual(originalMetadata);
  } finally {
    await environment.close();
  }
});

test('Studio未知文章提交結果：已落盤但回覆中斷時禁止離頁，同key原內容重送僅建立一篇', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const attempts: { key: string; body: string }[] = [];
  let committedId: string | null = null;
  try {
    await page.goto(environment.url);
    await page.getByRole('button', { name: '新增文章', exact: true }).click();
    const preview = page.getByTitle('文章即時預覽', { exact: true });
    const previewBody = page
      .frameLocator('iframe[title="文章即時預覽"]')
      .locator('body');
    const previewDocument = /\/api\/v1\/previews\/[^/]+\/document$/u;
    const loadedPreview = async (previous: string | null = null) => {
      let loaded: string | null = null;
      await expect
        .poll(async () => {
          const src = await preview.getAttribute('src');
          if (!src || src === previous || !previewDocument.test(src))
            return false;
          const document = await previewBody
            .evaluate((body) => ({
              pathname: body.ownerDocument.location.pathname,
              readyState: body.ownerDocument.readyState,
            }))
            .catch(() => null);
          if (
            document?.pathname !== new URL(src, environment.url).pathname ||
            document.readyState !== 'complete' ||
            (await preview.getAttribute('src')) !== src
          )
            return false;
          loaded = src;
          return true;
        })
        .toBe(true);
      if (!loaded) throw new Error('預覽未完成載入');
      return loaded;
    };
    // 先讓兩版文件真正載入，確保 Back 必須面對既有 iframe 瀏覽歷史。
    await page
      .getByLabel('文章標題', { exact: true })
      .fill('未知結果的第一版預覽');
    const firstPreview = await loadedPreview();
    await page.getByLabel('文章標題', { exact: true }).fill('未知結果的草稿');
    await loadedPreview(firstPreview);
    await page
      .getByLabel('文章網址名稱', { exact: true })
      .fill('unknown-navigation');
    await page.route('**/api/v1/articles', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      attempts.push({
        key: route.request().headers()['idempotency-key'] ?? '',
        body: route.request().postData() ?? '',
      });
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      const saved = ArticleResourceSchema.parse(await response.json());
      if (committedId === null) {
        committedId = saved.id;
        // 真API已完成交易；只中斷瀏覽器回覆，覆蓋結果不明的真實邊界。
        await route.abort('failed');
      } else {
        expect(saved.id).toBe(committedId);
        await route.fulfill({ response });
      }
    });
    await page.getByRole('button', { name: '建立草稿', exact: true }).click();
    const retry = page.getByRole('button', {
      name: '重試這次操作',
      exact: true,
    });
    await expect(retry).toBeVisible();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.key).toMatch(/^[a-f0-9-]{36}$/u);
    expect(committedId).not.toBeNull();
    const beforeRetry = await page.request.get(
      `${environment.url}/api/v1/articles`,
    );
    expect(beforeRetry.status()).toBe(200);
    expect(await beforeRetry.json()).toMatchObject({ total: 2 });

    await navigate(page, '全站設定');
    await expect(
      page.getByText('操作尚未完成，請先確認結果，再離開目前頁面。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '建立文章', exact: true }),
    ).toBeVisible();
    await back(page);
    await expect(page).toHaveURL(/#\/articles\/new$/u);
    await expect(retry).toBeVisible();
    await expect(
      page.getByRole('button', { name: '建立草稿', exact: true }),
    ).toBeDisabled();
    expect(attempts).toHaveLength(1);

    await retry.click();
    await expect(
      page.getByRole('heading', {
        name: '編輯文章：未知結果的草稿',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`#/articles/${committedId ?? 'missing'}$`, 'u'),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const collection = await page.request.get(
      `${environment.url}/api/v1/articles`,
    );
    expect(collection.status()).toBe(200);
    expect(await collection.json()).toMatchObject({ total: 2 });
    if (!committedId) throw new Error('真API未產生文章ID');
    expect(
      JSON.parse(
        await readFile(
          join(environment.root, 'content/articles', committedId, 'meta.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ title: '未知結果的草稿', slug: 'unknown-navigation' });
  } finally {
    await page.unroute('**/api/v1/articles');
    await environment.close();
  }
});

test('Studio選圖上傳Dialog：Ctrl／Cmd+S不保存文章，保留已選檔案與上傳設定', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const articleFiles = ['meta.json', 'content.html'].map((name) =>
    join(environment.root, 'content/articles/one', name),
  );
  const before = await Promise.all(articleFiles.map((path) => readFile(path)));
  let articleWrites = 0;
  page.on('request', (request) => {
    if (
      ['POST', 'PUT'].includes(request.method()) &&
      /\/api\/v1\/articles(?:\/[^/]+)?$/u.test(new URL(request.url()).pathname)
    )
      articleWrites += 1;
  });
  try {
    await page.goto(environment.url);
    await openArticle(page);
    await page.getByRole('combobox', { name: '精選圖片', exact: true }).click();
    await page.getByRole('button', { name: '上傳新媒體', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '上傳媒體', exact: true });
    await expect(upload).toBeVisible();
    await upload.getByLabel('選擇媒體檔案', { exact: true }).setInputFiles({
      name: 'navigation-shortcut.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDYoAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    const name = upload.getByLabel('上傳顯示名稱（選填）', { exact: true });
    await name.fill('保留在選圖視窗的內容');
    await name.press('ControlOrMeta+s');
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(upload).toBeVisible();
    await expect(name).toHaveValue('保留在選圖視窗的內容');
    expect(
      await upload
        .getByLabel('選擇媒體檔案', { exact: true })
        .evaluate((input) => (input as HTMLInputElement).files?.length),
    ).toBe(1);
    expect(articleWrites).toBe(0);
    const after = await Promise.all(articleFiles.map((path) => readFile(path)));
    expect(after).toEqual(before);
    const decision = page
      .waitForEvent('dialog')
      .then((dialog) => dialog.accept());
    await upload
      .getByRole('button', { name: '關閉上傳媒體', exact: true })
      .click();
    await decision;
    await expect(upload).toHaveCount(0);
  } finally {
    await environment.close();
  }
});

test('Studio全站設定：慢PUT硬擋離頁；回覆遺失保留緩衝，以原If-Match再保存進入412比較', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const attempts: { body: string; etag: string; key: string }[] = [];
  let release: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let notifyCommitted: (() => void) | undefined;
  const committed = new Promise<void>((resolve) => {
    notifyCommitted = resolve;
  });
  const sitePath = join(environment.root, 'content/site.json');
  try {
    await page.goto(environment.url);
    await navigate(page, '全站設定');
    const name = page.getByLabel('網站名稱', { exact: true });
    await name.fill('導航期間的網站設定');
    await page.route('**/api/v1/site-settings', async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue();
        return;
      }
      attempts.push({
        body: route.request().postData() ?? '',
        etag: route.request().headers()['if-match'] ?? '',
        key: route.request().headers()['idempotency-key'] ?? '',
      });
      const response = await route.fetch();
      if (attempts.length === 1) {
        expect(response.status()).toBe(200);
        notifyCommitted?.();
        // 真PUT已落盤，暫時保留回覆；最後以連線中斷驗證CAS錯誤邊界。
        await responseGate;
        await route.abort('failed');
      } else {
        expect(response.status()).toBe(412);
        await route.fulfill({ response });
      }
    });
    await page
      .getByRole('button', { name: '保存全站設定', exact: true })
      .click();
    await committed;
    await expect(
      page.getByRole('button', { name: '保存中…', exact: true }),
    ).toBeDisabled();
    await expect(name).toBeDisabled();
    const written = await readFile(sitePath);
    expect(
      SiteConfigSchema.parse(JSON.parse(written.toString())).siteName,
    ).toBe('導航期間的網站設定');
    await navigate(page, '文章');
    await expect(
      page.getByText('操作尚未完成，請先確認結果，再離開目前頁面。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '全站設定', exact: true }),
    ).toBeVisible();
    await back(page);
    await expect(page).toHaveURL(/#\/settings$/u);
    await expect(name).toHaveValue('導航期間的網站設定');
    expect(attempts).toHaveLength(1);

    release?.();
    await expect(
      page.getByRole('alert').filter({ hasText: 'SERVICE_UNAVAILABLE' }),
    ).toBeVisible();
    await expect(name).toHaveValue('導航期間的網站設定');
    const save = page.getByRole('button', {
      name: '保存全站設定',
      exact: true,
    });
    await expect(save).toBeEnabled();
    await save.click();
    const conflict = page.getByRole('region', {
      name: '版本衝突',
      exact: true,
    });
    await expect(conflict).toBeVisible();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]?.etag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(attempts[0]?.key).toBe('');
    const versions = (await conflict.locator('pre').allTextContents()).map(
      (text) => SiteConfigSchema.parse(JSON.parse(text)),
    );
    expect(versions.map((version) => version.siteName)).toEqual([
      'HTTP測試網站',
      '導航期間的網站設定',
      '導航期間的網站設定',
    ]);
    expect(await readFile(sitePath)).toEqual(written);
    const adopt = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    await conflict
      .getByRole('button', { name: '採用已保存版本', exact: true })
      .click();
    await adopt;
    await expect(conflict).toHaveCount(0);
    await expect(name).toHaveValue('導航期間的網站設定');
    await navigate(page, '文章');
    await expect(
      page.getByRole('heading', { name: '文章', exact: true }),
    ).toBeVisible();
  } finally {
    release?.();
    await page.unroute('**/api/v1/site-settings');
    await environment.close();
  }
});

test('Studio分類遷移：真工作已受理但回覆遺失時硬擋離頁，原key重送只保留一個工作', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const attempts: { key: string; body: string }[] = [];
  let jobId: string | null = null;
  try {
    await page.goto(environment.url);
    await navigate(page, '分類與 Tag');
    await page
      .getByLabel('要變更的項目', { exact: true })
      .selectOption('notes');
    await page
      .getByLabel('新的網址名稱', { exact: true })
      .fill('journal-navigation');
    await page
      .getByRole('button', { name: '查看變更影響', exact: true })
      .click();
    const plan = page.getByRole('heading', {
      name: '確認網址變更',
      exact: true,
    });
    await expect(plan).toBeVisible();
    await page.route('**/api/v1/taxonomy-migrations', async (route) => {
      if (
        route.request().method() !== 'POST' ||
        !route.request().postDataJSON().confirmed
      ) {
        await route.continue();
        return;
      }
      attempts.push({
        key: route.request().headers()['idempotency-key'] ?? '',
        body: route.request().postData() ?? '',
      });
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      const job = JobSchema.parse(await response.json());
      if (jobId === null) {
        jobId = job.id;
        await route.abort('failed');
      } else {
        expect(job.id).toBe(jobId);
        await route.fulfill({ response });
      }
    });
    const confirmation = page
      .waitForEvent('dialog')
      .then((dialog) => dialog.accept());
    await page
      .getByRole('button', { name: '確認變更網址', exact: true })
      .click();
    await confirmation;
    const retry = page.getByRole('button', {
      name: '重試這次操作',
      exact: true,
    });
    await expect(retry).toBeVisible();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.key).toMatch(/^[a-f0-9-]{36}$/u);
    await navigate(page, '全站設定');
    await expect(
      page.getByText('操作尚未完成，請先確認結果，再離開目前頁面。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(plan).toBeVisible();
    await back(page);
    await expect(page).toHaveURL(/#\/taxonomy$/u);
    await expect(retry).toBeVisible();
    expect(attempts).toHaveLength(1);
    await retry.click();
    const detail = page.getByRole('dialog', {
      name: '工作詳細資料',
      exact: true,
    });
    await expect(detail).toBeVisible();
    await expect(
      detail
        .getByRole('definition')
        .filter({ hasText: '分類／Tag 網址調整 · 成功' }),
    ).toBeVisible();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const jobs = await page.request.get(
      `${environment.url}/api/v1/jobs?type=taxonomy&page=1&pageSize=20`,
    );
    expect(jobs.status()).toBe(200);
    const collection: { items: unknown[]; total: number } = await jobs.json();
    expect(collection.total).toBe(1);
    expect(JobSchema.parse(collection.items[0]).id).toBe(jobId);
    expect(
      JSON.parse(
        await readFile(
          join(environment.root, 'content/articles/one/meta.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ category: 'journal-navigation' });
  } finally {
    await page.unroute('**/api/v1/taxonomy-migrations');
    await environment.close();
  }
});

test('Studio巢狀Dialog：分類OG上傳Back只處理最上層；取消連線保留原上傳與父編輯', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const taxonomyPath = join(environment.root, 'content/categories.json');
  const taxonomyBefore = await readFile(taxonomyPath);
  const keys: string[] = [];
  let releaseUpload: (() => void) | undefined;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  try {
    const require = createRequire(join(process.cwd(), 'server/package.json'));
    const sharp = require('sharp') as NativeImageFactory;
    const bytes = await sharp({
      create: { width: 12, height: 12, channels: 3, background: '#627461' },
    })
      .png()
      .toBuffer();
    await page.goto(environment.url);
    await navigate(page, '分類與 Tag');
    await page
      .getByRole('button', { name: '編輯分類 筆記', exact: true })
      .click();
    // 子modal開啟時父dialog應保持open，但會暫時退出可操作的無障礙樹。
    const parent = page.getByRole('dialog', {
      name: '編輯分類',
      exact: true,
      includeHidden: true,
    });
    await expect(parent).toBeVisible();
    const picker = page.getByRole('dialog', {
      name: '選擇OG Image',
      exact: true,
    });
    const openUpload = async () => {
      if (!(await picker.isVisible()))
        await parent
          .getByRole('combobox', { name: 'OG Image', exact: true })
          .click();
      await picker
        .getByRole('button', { name: '上傳新媒體', exact: true })
        .click();
      await expect(
        page.getByRole('dialog', { name: '上傳媒體', exact: true }),
      ).toBeVisible();
    };
    await openUpload();
    const upload = page.getByRole('dialog', { name: '上傳媒體', exact: true });
    await back(page);
    await expect(upload).toHaveCount(0);
    await expect(parent).toBeVisible();
    await expect(parent.getByLabel('分類名稱', { exact: true })).toHaveValue(
      '筆記',
    );

    await openUpload();
    await upload.getByLabel('選擇媒體檔案', { exact: true }).setInputFiles({
      name: 'nested-navigation.png',
      mimeType: 'image/png',
      buffer: bytes,
    });
    await upload
      .getByLabel('上傳顯示名稱（選填）', { exact: true })
      .fill('巢狀視窗保留圖片');
    await page.route('**/api/v1/media/sources', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      // 保留瀏覽器原始multipart；route.fetch在WebKit拿不到File的二進位內容。
      // 此案例驗連線取消後的原key守衛，不宣稱第一送已到服務或完成落盤。
      if (keys.length === 1) await uploadGate;
      await route.continue().catch(() => undefined);
    });
    await upload.getByRole('button', { name: '上傳媒體', exact: true }).click();
    await expect.poll(() => keys.length).toBe(1);
    await upload.getByRole('button', { name: '取消上傳', exact: true }).click();
    releaseUpload?.();
    const retry = upload.getByRole('button', {
      name: '重試上傳',
      exact: true,
    });
    await expect(retry).toBeVisible();
    await back(page);
    await expect(upload).toBeVisible();
    await expect(parent).toBeVisible();
    await expect(
      upload.getByText(
        '上傳結果尚未確認。請先重試上傳，或選擇結束重試後再關閉。',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      upload.getByLabel('上傳顯示名稱（選填）', { exact: true }),
    ).toHaveValue('巢狀視窗保留圖片');
    expect(keys).toHaveLength(1);
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/v1/media/sources'),
    );
    await retry.click();
    const response = await accepted;
    expect(response.status()).toBe(201);
    const source = MediaSourceResourceSchema.parse(await response.json());
    expect(source).toMatchObject({
      kind: 'image',
      displayName: '巢狀視窗保留圖片',
      mimeType: 'image/png',
      width: 12,
      height: 12,
      byteSize: bytes.length,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(
      await readFile(
        join(environment.root, 'media/source', source.id, 'original.png'),
      ),
    ).toEqual(bytes);
    const preparation = page.getByRole('dialog', {
      name: '處理與選擇圖片',
      exact: true,
    });
    await expect(preparation).toBeVisible();
    await expect(upload).toHaveCount(0);
    await expect(parent).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/u);
    const sources = await page.request.get(
      `${environment.url}/api/v1/media/sources`,
    );
    expect(sources.status()).toBe(200);
    const collection: { items: unknown[]; total: number } =
      await sources.json();
    expect(collection.total).toBe(1);
    expect(MediaSourceResourceSchema.parse(collection.items[0]).id).toBe(
      source.id,
    );
    await back(page);
    await expect(preparation).toHaveCount(0);
    await expect(picker).toBeVisible();
    await back(page);
    await expect(picker).toHaveCount(0);
    await expect(parent).toBeVisible();
    await expect(
      parent.getByRole('combobox', { name: 'OG Image', exact: true }),
    ).toContainText('繼承頁面類型／全域預設圖片');
    expect(await readFile(taxonomyPath)).toEqual(taxonomyBefore);
    await parent
      .getByRole('button', { name: '關閉編輯分類', exact: true })
      .click();
    await expect(parent).toHaveCount(0);
  } finally {
    releaseUpload?.();
    try {
      if (!page.isClosed()) await page.unroute('**/api/v1/media/sources');
    } finally {
      await environment.close();
    }
  }
});
