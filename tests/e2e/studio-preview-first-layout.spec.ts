import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  ArticleMetaSchema,
  PreviewResponseSchema,
} from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';

type PreviewResizeProbe = {
  pending: boolean;
  hold: () => void;
  release: () => void;
};
declare global {
  interface Window {
    __previewResizeProbe?: PreviewResizeProbe;
  }
}

test.use({ viewport: { width: 1536, height: 1000 } });

async function editorGeometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing editor element: ${selector}`);
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top + window.scrollY,
        height: bounds.height,
      };
    };
    return {
      columns: rect('.editor-columns'),
      settings: rect('.editor-settings'),
      trigger: rect('button[role="combobox"][data-field="meta.featuredImage"]'),
    };
  });
}

function expectSameGeometry(
  before: Awaited<ReturnType<typeof editorGeometry>>,
  after: Awaited<ReturnType<typeof editorGeometry>>,
) {
  for (const key of ['columns', 'settings', 'trigger'] as const) {
    expect(after[key].top, `${key} document position`).toBeCloseTo(
      before[key].top,
      1,
    );
    expect(after[key].height, `${key} height`).toBeCloseTo(
      before[key].height,
      1,
    );
  }
}

test('預覽回應跨過原生選圖點擊時，初始畫布與診斷不移動文章設定', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let releasePreview: () => void = () => {};
  let responseReady: () => void = () => {};
  let responseFailed: (error: unknown) => void = () => {};
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  const heldResponse = new Promise<void>((resolve, reject) => {
    responseReady = resolve;
    responseFailed = reject;
  });
  await page.route('**/api/v1/previews', async (route) => {
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      const data = PreviewResponseSchema.parse(await response.json());
      expect(data.diagnostics).toHaveLength(2);
      responseReady();
      await previewGate;
      await route.fulfill({ response });
    } catch (error) {
      responseFailed(error);
      await route.abort().catch(() => undefined);
    }
  });
  try {
    const metadataPath = join(
      environment.root,
      'content/articles/one/meta.json',
    );
    const metadata = await readFile(metadataPath);
    expect(
      ArticleMetaSchema.parse(JSON.parse(metadata.toString())).featuredImage,
    ).toBeNull();
    await page.goto(`${environment.url}/#/articles/one`);
    await heldResponse;
    const trigger = page.getByRole('combobox', {
      name: '精選圖片',
      exact: true,
    });
    await trigger.scrollIntoViewIfNeeded();
    const before = await editorGeometry(page);
    const bounds = await trigger.boundingBox();
    if (!bounds) throw new Error('Featured image trigger must be visible');
    const point = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    releasePreview();
    await expect(page.locator('.preview-stage iframe')).toHaveCount(1);
    await expect(page.locator('.editor-preview .diagnostics li')).toHaveCount(
      2,
    );
    const after = await editorGeometry(page);
    await page.mouse.up();
    await test.info().attach('preview-loading-ready-geometry.json', {
      body: JSON.stringify({ before, after, nativePoint: point }, null, 2),
      contentType: 'application/json',
    });
    expectSameGeometry(before, after);
    const picker = page.getByRole('dialog', {
      name: '選擇精選圖片',
      exact: true,
    });
    await expect(picker.getByRole('searchbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await readFile(metadataPath)).toEqual(metadata);
  } finally {
    releasePreview();
    await page.mouse.up().catch(() => undefined);
    await page.unroute('**/api/v1/previews');
    await environment.close();
  }
});

test('預覽檢查區保留初始錯誤與上次成功，長訊息可用鍵盤閱讀與重試', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let releaseInitial: () => void = () => {};
  let initialReady: () => void = () => {};
  let initialFailed: (error: unknown) => void = () => {};
  const initialGate = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const heldInitial = new Promise<void>((resolve, reject) => {
    initialReady = resolve;
    initialFailed = reject;
  });
  let requestCount = 0;
  const failure = ApiErrorSchema.parse({
    error: {
      code: 'PREVIEW_TEMPORARILY_UNAVAILABLE',
      message:
        '預覽暫時無法完成，請重新產生預覽。' +
        '這是一段隔離測試的長錯誤說明。'.repeat(60) +
        '完整訊息結尾。',
      retryable: true,
      issues: [],
      requestId: randomUUID(),
    },
  });
  await page.route('**/api/v1/previews', async (route) => {
    const index = requestCount++;
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      const data = PreviewResponseSchema.parse(await response.json());
      if (index === 0) {
        initialReady();
        await initialGate;
      }
      if (index === 0 || index === 2) {
        await route.fulfill({ status: 503, json: failure });
      } else {
        // Exercise the UI's bounded message viewport with valid API contracts;
        // article rendering still comes from the actual successful service.
        const diagnostics =
          index === 1
            ? Array.from({ length: 24 }, (_, offset) => ({
                severity: 'warning' as const,
                code: 'PREVIEW_FIXTURE_NOTICE',
                message: `隔離測試檢查項目 ${offset + 1}，所有訊息都必須能完整閱讀。`,
              }))
            : [];
        await route.fulfill({
          response,
          json: PreviewResponseSchema.parse({ ...data, diagnostics }),
        });
      }
    } catch (error) {
      initialFailed(error);
      await route.abort().catch(() => undefined);
    }
  });
  try {
    const metadataPath = join(
      environment.root,
      'content/articles/one/meta.json',
    );
    const original = await readFile(metadataPath);
    await page.goto(`${environment.url}/#/articles/one`);
    await heldInitial;
    const before = await editorGeometry(page);
    const feedback = page.getByRole('region', {
      name: '預覽檢查結果',
      exact: true,
    });
    await expect(feedback).toContainText('預覽完成後會顯示檢查結果。');
    releaseInitial();
    await expect(feedback.getByRole('alert')).toContainText('完整訊息結尾。');
    await expect(feedback).toContainText('本次預覽未完成。');
    await expect(page.locator('.preview-stage iframe')).toHaveCount(0);
    await expect(
      page.locator('.preview-stage .preview-placeholder'),
    ).toBeVisible();
    expectSameGeometry(before, await editorGeometry(page));
    await page.locator('.editor-preview').screenshot({
      path: test.info().outputPath('initial-error-preview.png'),
    });

    const retry = feedback.getByRole('button', {
      name: '重新產生預覽',
      exact: true,
    });
    const keyboardRetry = async () => {
      await feedback.focus();
      // A replacement error may inherit the preceding diagnostics' bottom
      // position. Return within this region before End; at its existing end,
      // Chromium correctly forwards End to the outer page instead.
      if ((await feedback.evaluate((element) => element.scrollTop)) > 0) {
        await page.keyboard.press('Home');
        await expect
          .poll(() => feedback.evaluate((element) => element.scrollTop))
          .toBe(0);
      }
      await page.keyboard.press('End');
      await expect
        .poll(() =>
          feedback.evaluate((element) =>
            Math.abs(
              element.scrollTop - (element.scrollHeight - element.clientHeight),
            ),
          ),
        )
        .toBeLessThan(1);
      await page.keyboard.press('Tab');
      await expect(feedback.locator('summary')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(retry).toBeFocused();
      await expect(retry).toBeInViewport();
      await page.keyboard.press('Enter');
    };
    await keyboardRetry();
    await expect(feedback.locator('.diagnostics li')).toHaveCount(24);
    await expect(page.locator('.preview-stage iframe')).toHaveCount(1);
    const lastGood = await page
      .locator('.preview-stage iframe')
      .getAttribute('src');
    expectSameGeometry(before, await editorGeometry(page));
    await feedback.focus();
    await page.keyboard.press('End');
    await expect(feedback.locator('.diagnostics li').last()).toBeInViewport();
    await page.locator('.editor-preview').screenshot({
      path: test.info().outputPath('scrollable-diagnostics-preview.png'),
    });

    await page.getByLabel('文章標題', { exact: true }).fill('文章檢查');
    await expect(feedback.getByRole('alert')).toContainText('完整訊息結尾。');
    await expect(feedback).toContainText('目前顯示上一次成功的預覽。');
    await expect(page.locator('.preview-stage iframe')).toHaveAttribute(
      'src',
      lastGood ?? '',
    );
    expectSameGeometry(before, await editorGeometry(page));
    await keyboardRetry();
    await expect(feedback).toContainText('沒有診斷問題。');
    await expect(feedback.getByRole('alert')).toHaveCount(0);
    expectSameGeometry(before, await editorGeometry(page));
    expect(await readFile(metadataPath)).toEqual(original);
    expect(requestCount).toBe(4);
  } finally {
    releaseInitial();
    await page.unroute('**/api/v1/previews');
    await environment.close();
  }
});

test('首次預覽先量測符合區域尺寸，延遲的ResizeObserver不閃全尺寸或阻擋選圖', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let releasePreview: () => void = () => {};
  let responseReady: () => void = () => {};
  let responseFailed: (error: unknown) => void = () => {};
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  const heldResponse = new Promise<void>((resolve, reject) => {
    responseReady = resolve;
    responseFailed = reject;
  });
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    const pending: (() => void)[] = [];
    let released = false;
    const probe: PreviewResizeProbe = {
      pending: false,
      hold() {
        released = false;
        probe.pending = false;
      },
      release() {
        released = true;
        for (const deliver of pending.splice(0)) deliver();
      },
    };
    window.__previewResizeProbe = probe;
    // Only delay delivery of the preview's real native observation. Its first
    // visible geometry must not depend on when the browser delivers this event.
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          if (
            !released &&
            entries.some((entry) =>
              entry.target.classList.contains('preview-stage'),
            )
          ) {
            probe.pending = true;
            pending.push(() => callback(entries, observer));
          } else callback(entries, observer);
        });
      }
    };
  });
  await page.route('**/api/v1/previews', async (route) => {
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      PreviewResponseSchema.parse(await response.json());
      responseReady();
      await previewGate;
      await route.fulfill({ response });
    } catch (error) {
      responseFailed(error);
      await route.abort().catch(() => undefined);
    }
  });
  try {
    const metadataPath = join(
      environment.root,
      'content/articles/one/meta.json',
    );
    const meta = ArticleMetaSchema.parse(
      JSON.parse(await readFile(metadataPath, 'utf8')),
    );
    const metadata = Buffer.from(
      JSON.stringify({
        ...meta,
        featuredImage: `/media/${randomUUID()}/image.webp`,
      }),
    );
    await writeFile(metadataPath, metadata);
    await page.goto(environment.url);
    await page
      .locator('tr[data-article-id="one"] .article-title-button')
      .click();
    await heldResponse;
    await expect(page.locator('.preview-stage')).toHaveCount(1);
    await expect(page.locator('.preview-stage iframe')).toHaveCount(0);
    await page.waitForFunction(() => window.__previewResizeProbe?.pending);
    const stage = page.locator('.preview-stage');
    const geometry = () =>
      stage.evaluate((element) => {
        const style = getComputedStyle(element);
        const contentWidth =
          element.getBoundingClientRect().width -
          parseFloat(style.borderLeftWidth) -
          parseFloat(style.borderRightWidth) -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        const sheet = element.querySelector('.preview-sheet');
        if (!(sheet instanceof HTMLElement))
          throw new Error('NO_PREVIEW_SHEET');
        return {
          scale: Number(element.getAttribute('data-scale')),
          fit: Math.min(
            1,
            contentWidth / Number(element.getAttribute('data-viewport-width')),
          ),
          width: sheet.getBoundingClientRect().width,
          height: sheet.getBoundingClientRect().height,
        };
      });
    const first = await geometry();
    expect(first.fit).toBeLessThan(1);
    expect(first.scale).toBeCloseTo(first.fit, 5);
    expect(first.width).toBeCloseTo(1200 * first.fit, 1);
    expect(first.height).toBeCloseTo(800 * first.fit, 1);

    releasePreview();
    await expect(page.locator('.preview-stage iframe')).toHaveCount(1);
    const ready = await geometry();
    expect(ready).toEqual(first);

    const trigger = page.getByRole('combobox', {
      name: '精選圖片',
      exact: true,
    });
    await trigger.click();
    const picker = page.getByRole('dialog', {
      name: '選擇精選圖片',
      exact: true,
    });
    await expect(picker.getByRole('searchbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await readFile(metadataPath)).toEqual(metadata);

    await page.evaluate(() => window.__previewResizeProbe?.release());
    await page.setViewportSize({ width: 1400, height: 1000 });
    await expect
      .poll(async () => {
        const current = await geometry();
        return Math.abs(current.scale - current.fit);
      })
      .toBeLessThan(0.00001);
    await page.getByLabel('預覽縮放', { exact: true }).selectOption('75');
    await expect(stage).toHaveAttribute('data-scale', '0.75');
    await page
      .getByRole('group', { name: '預覽模擬裝置', exact: true })
      .getByRole('button', { name: '手機', exact: true })
      .click();
    await expect(stage).toHaveAttribute('data-viewport-width', '390');
    expect((await geometry()).height).toBeCloseTo(844 * 0.75, 1);

    await page.getByLabel('預覽縮放', { exact: true }).selectOption('fit');
    await page.evaluate(() => window.__previewResizeProbe?.hold());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: '預覽', exact: true }).click();
    const mobile = await geometry();
    expect(mobile.fit).toBeLessThan(1);
    expect(mobile.scale).toBeCloseTo(mobile.fit, 5);
    expect(mobile.height).toBeCloseTo(844 * mobile.scale, 1);
  } finally {
    releasePreview();
    if (!page.isClosed())
      await page
        .evaluate(() => window.__previewResizeProbe?.release())
        .catch(() => undefined);
    await page.unroute('**/api/v1/previews');
    await environment.close();
  }
});
