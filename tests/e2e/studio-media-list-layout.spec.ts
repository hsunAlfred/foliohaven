import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { studioEnvironment } from '../fixtures/studio/environment.js';

type MediaPointerEvidence = {
  type: string;
  time: number;
  targetTag?: string | null;
  targetClass?: string | null;
  targetLabel?: string | null;
  downTargetConnected?: boolean;
  downButtonConnected?: boolean;
  targetIsDownButton?: boolean;
  cardTop?: number | null;
  previousOpen?: boolean;
  currentOpen?: boolean;
};

declare global {
  interface Window {
    __foliohavenMediaPointerEvents?: MediaPointerEvidence[];
  }
}

test('媒體庫背景更新：卡片位置與原生點擊目標穩定，仍可鍵盤開啟引用', async ({
  page,
}, testInfo) => {
  const environment = await studioEnvironment();
  let releaseList = () => {};
  const listReleased = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  let captureList = () => {};
  const readyListRequested = new Promise<void>((resolve) => {
    captureList = resolve;
  });
  let released = false;
  const releaseReadyList = () => {
    released = true;
    releaseList();
  };
  let recordingDetail = false;
  const detailRequests: string[] = [];
  const detailReads: {
    path: string;
    status: number | null;
    error: string | null;
  }[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      recordingDetail &&
      request.method() === 'GET' &&
      /^\/api\/v1\/media\/sources\/[^/]+$/u.test(path)
    )
      detailRequests.push(path);
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (
      recordingDetail &&
      response.request().method() === 'GET' &&
      /^\/api\/v1\/media\/sources\/[^/]+$/u.test(path)
    )
      detailReads.push({ path, status: response.status(), error: null });
  });
  page.on('requestfailed', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      recordingDetail &&
      request.method() === 'GET' &&
      /^\/api\/v1\/media\/sources\/[^/]+$/u.test(path)
    )
      detailReads.push({
        path,
        status: null,
        error: request.failure()?.errorText ?? null,
      });
  });
  try {
    const require = createRequire(join(process.cwd(), 'server/package.json'));
    const sharp = require('sharp') as NativeImageFactory;
    const bytes = await sharp({
      create: { width: 90, height: 60, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    await page.setViewportSize({ width: 1536, height: 1000 });
    await page.goto(environment.url);
    await page.getByRole('button', { name: '媒體庫', exact: true }).click();
    await page.getByRole('button', { name: '上傳媒體', exact: true }).click();
    await page.getByLabel('選擇媒體檔案', { exact: true }).setInputFiles({
      name: 'stable-card.png',
      mimeType: 'image/png',
      buffer: bytes,
    });
    await page
      .getByLabel('上傳顯示名稱（選填）', { exact: true })
      .fill('穩定媒體卡');
    await page
      .getByRole('dialog', { name: '上傳媒體', exact: true })
      .getByRole('button', { name: '上傳媒體', exact: true })
      .click();
    await expect(page.getByLabel('媒體顯示名稱', { exact: true })).toHaveValue(
      '穩定媒體卡',
    );
    const card = page.getByRole('button', { name: '穩定媒體卡', exact: true });
    // The collection keeps this pending source while its processed reload waits.
    await expect(
      page.locator('.media-card[aria-label="穩定媒體卡"]'),
    ).toContainText('等待處理');
    await page.route('**/api/v1/media/sources**', async (route) => {
      const request = route.request();
      if (
        request.method() !== 'GET' ||
        new URL(request.url()).pathname !== '/api/v1/media/sources'
      ) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      if (response.status() !== 200) {
        await route.fulfill({ response });
        return;
      }
      const payload = (await response.json()) as {
        items: { displayName: string; asset: unknown }[];
      };
      if (
        !released &&
        payload.items.some(
          (source) => source.displayName === '穩定媒體卡' && source.asset,
        )
      ) {
        captureList();
        await listReleased;
      }
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '處理媒體', exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: '媒體處理進度', exact: true })
        .getByText('處理完成', { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await readyListRequested;
    await page
      .getByRole('button', { name: '關閉媒體設定與引用', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', { name: '媒體設定與引用', exact: true }),
    ).not.toBeVisible();
    await expect(card.locator('.media-thumbnail__empty')).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: '讀取媒體中…' }),
    ).toHaveText('讀取媒體中…');
    recordingDetail = true;
    await page.evaluate(() => {
      const events: MediaPointerEvidence[] = [];
      window.__foliohavenMediaPointerEvents = events;
      let downTarget: Node | null = null;
      let downButton: Element | null = null;
      for (const type of [
        'pointerdown',
        'mousedown',
        'pointerup',
        'mouseup',
        'click',
      ]) {
        document.addEventListener(
          type,
          (event) => {
            const target =
              event.target instanceof Element ? event.target : null;
            if (
              !downTarget &&
              (type === 'pointerdown' || type === 'mousedown')
            ) {
              downTarget = target;
              downButton = target?.closest('.media-card') ?? null;
            }
            events.push({
              type,
              time: performance.now(),
              targetTag: target?.tagName ?? null,
              targetClass: target?.getAttribute('class') ?? null,
              targetLabel: target?.getAttribute('aria-label') ?? null,
              downTargetConnected: downTarget?.isConnected ?? false,
              downButtonConnected: downButton?.isConnected ?? false,
              targetIsDownButton: target === downButton,
              cardTop: downButton?.getBoundingClientRect().top ?? null,
            });
          },
          true,
        );
      }
      new MutationObserver((records) => {
        for (const record of records) {
          if (
            record.type === 'attributes' &&
            record.target instanceof Element &&
            record.target.matches('dialog.media-detail-dialog')
          )
            events.push({
              type: 'dialog-open-attribute',
              time: performance.now(),
              previousOpen: record.oldValue !== null,
              currentOpen: record.target.hasAttribute('open'),
            });
        }
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['open'],
        attributeOldValue: true,
      });
    });
    const before = await card.boundingBox();
    const placeholder = await card
      .locator('.media-thumbnail__empty')
      .boundingBox();
    if (!before || !placeholder)
      throw new Error('Pending media card missing bounds');
    await page.mouse.move(
      placeholder.x + placeholder.width / 2,
      placeholder.y + placeholder.height / 2,
    );
    await page.mouse.down();
    releaseReadyList();
    await expect(card).toContainText('可引用');
    await expect(card.locator('.media-thumbnail img')).toBeVisible();
    const after = await card.boundingBox();
    if (!after) throw new Error('Processed media card missing bounds');
    await page.mouse.up();
    const detail = page.getByRole('dialog', {
      name: '媒體設定與引用',
      exact: true,
    });
    try {
      await expect(
        detail.getByLabel('此次圖片引用的 Alt', { exact: true }),
      ).toBeVisible();
    } finally {
      await testInfo.attach('media-card-native-pointer.json', {
        body: JSON.stringify({
          before,
          after,
          detailRequests,
          detailReads,
          events: await page.evaluate(
            () => window.__foliohavenMediaPointerEvents,
          ),
        }),
        contentType: 'application/json',
      });
    }
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    const events = await page.evaluate(
      () => window.__foliohavenMediaPointerEvents ?? [],
    );
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      const event = events.find((item) => item.type === type);
      expect(event?.targetIsDownButton).toBe(true);
      expect(event?.downTargetConnected).toBe(true);
    }
    // Development StrictMode can abort and restart a read; native activation
    // must still happen once and open exactly one dialog for the chosen source.
    expect(
      events.filter(
        (event) => event.type === 'click' && event.targetIsDownButton,
      ),
    ).toHaveLength(1);
    await expect(detail).toHaveCount(1);
    await expect(
      detail.getByLabel('媒體顯示名稱', { exact: true }),
    ).toHaveValue('穩定媒體卡');
    await detail
      .getByRole('button', { name: '關閉媒體設定與引用', exact: true })
      .click();
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(
      detail.getByLabel('此次圖片引用的 Alt', { exact: true }),
    ).toBeVisible();
  } finally {
    releaseReadyList();
    await page.unrouteAll({ behavior: 'wait' });
    await environment.close();
  }
});
