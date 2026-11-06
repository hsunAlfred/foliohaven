import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  CurrentArtifactSchema,
  JobSchema,
} from '@foliohaven/core';
import type { CurrentArtifact } from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';

test.setTimeout(90_000);

async function layout(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element)
        throw new Error(`Missing artifact layout element: ${selector}`);
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top + scrollY, height: bounds.height };
    };
    return {
      card: rect('.artifact-summary'),
      heading: rect('.artifact-summary-heading'),
      state: rect('.artifact-summary-state'),
      metadata: rect('.artifact-meta'),
      row: rect('.jobs-table tbody tr'),
    };
  });
}

function sameLayout(
  before: Awaited<ReturnType<typeof layout>>,
  after: Awaited<ReturnType<typeof layout>>,
) {
  for (const key of ['card', 'heading', 'state', 'metadata', 'row'] as const) {
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

function withWarning(artifact: CurrentArtifact): CurrentArtifact {
  const current = artifact.current;
  const build = current?.build;
  if (!current || !build)
    throw new Error('Artifact fixture needs a real completed build');
  return CurrentArtifactSchema.parse({
    ...artifact,
    current: {
      ...current,
      build: {
        ...build,
        result: {
          ...build.result,
          warnings: [
            {
              severity: 'warning',
              code: 'ARTIFACT_LAYOUT_NOTICE',
              message: '完整更新提醒仍可閱讀。',
            },
          ],
        },
      },
    },
  });
}

test('網站狀態卡：初始與重讀不移工作列，錯誤即為未知且桌機手機可完整閱讀', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  type Gate = {
    seen: Promise<void>;
    markSeen: () => void;
    wait: Promise<void>;
    release: () => void;
  };
  let gate: Gate | null = null;
  let failure = false;
  const hold = () => {
    if (gate) throw new Error('Artifact response gate already pending');
    let markSeen: () => void = () => {};
    let release: () => void = () => {};
    const held: Gate = {
      seen: new Promise<void>((resolve) => {
        markSeen = resolve;
      }),
      markSeen: () => markSeen(),
      wait: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => {
        if (gate === held) gate = null;
        release();
      },
    };
    gate = held;
    return held;
  };
  const releasePending = () => gate?.release();
  const apiError = ApiErrorSchema.parse({
    error: {
      code: 'ARTIFACT_READ_UNAVAILABLE',
      message:
        '網站狀態讀取失敗。' +
        '這是隔離測試的完整錯誤說明。'.repeat(45) +
        '完整錯誤訊息結尾。',
      retryable: false,
      issues: [],
      requestId: randomUUID(),
    },
  });
  const sourcePaths = [
    'content/site.json',
    'content/articles/one/meta.json',
    'content/articles/one/content.html',
  ];
  const sources = await Promise.all(
    sourcePaths.map((path) => readFile(join(environment.root, path))),
  );
  await page.route('**/api/v1/artifacts/current', async (route) => {
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const artifact = CurrentArtifactSchema.parse(await response.json());
      const currentGate = gate;
      if (currentGate) {
        currentGate.markSeen();
        await currentGate.wait;
      }
      await route.fulfill({
        response,
        status: failure ? 403 : 200,
        json: failure ? apiError : withWarning(artifact),
      });
    } catch {
      await route.abort().catch(() => undefined);
    }
  });
  try {
    const accepted = await page.request.post(
      `${environment.url}/api/v1/build-jobs`,
      {
        headers: { Origin: environment.url, 'Idempotency-Key': randomUUID() },
        data: {},
      },
    );
    expect(accepted.status()).toBe(202);
    const created = JobSchema.parse(await accepted.json());
    await expect
      .poll(
        async () =>
          JobSchema.parse(
            await (
              await page.request.get(
                `${environment.url}/api/v1/jobs/${created.id}`,
              )
            ).json(),
          ).status,
        { timeout: 30_000 },
      )
      .toBe('succeeded');
    const geometries: Record<string, unknown>[] = [];
    for (const width of [1536, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      failure = false;
      const initial = hold();
      await page.goto(`${environment.url}/?artifact-layout=${width}#/jobs`);
      await initial.seen;
      const row = page.locator('.jobs-table tbody tr').first();
      const rowButton = row.getByRole('button', {
        name: '網站更新 · 成功',
        exact: true,
      });
      await expect(rowButton).toBeVisible();
      const card = page.getByRole('region', { name: '網站狀態', exact: true });
      const state = card.getByRole('status');
      await expect(state).toContainText('正在確認網站是否已套用最新內容…');
      const waiting = await layout(page);
      initial.release();
      await expect(state).toContainText('網站已更新至目前保存的內容。');
      const ready = await layout(page);
      sameLayout(waiting, ready);
      const typography = await state.evaluate((element) => ({
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        height: element.clientHeight,
      }));
      expect(typography.height).toBeGreaterThanOrEqual(
        typography.lineHeight * 2,
      );
      await expect(card.locator('.artifact-counts')).not.toContainText('—');
      await expect(card.locator('.artifact-update-time time')).toHaveCount(1);
      await expect(
        page.getByRole('heading', { name: '網站更新與工作', exact: true }),
      ).toHaveAccessibleName('網站更新與工作');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`artifact-${width}-ready.png`),
        fullPage: true,
      });

      const metadata = await card.locator('.artifact-update-time').innerText();
      const counts = await card.locator('.artifact-counts').innerText();
      const refresh = hold();
      await rowButton.click();
      await refresh.seen;
      await expect(state).toContainText('正在確認網站是否已套用最新內容…');
      await expect(card).not.toContainText('網站已更新至目前保存的內容。');
      await expect(card.locator('.artifact-update-time')).toHaveText(metadata);
      await expect(card.locator('.artifact-counts')).toHaveText(counts);
      await page
        .locator('dialog[open]')
        .getByRole('button', { name: /^關閉/u })
        .first()
        .click();
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      const refreshing = await layout(page);
      sameLayout(ready, refreshing);
      await rowButton.scrollIntoViewIfNeeded();
      const bounds = await rowButton.boundingBox();
      if (!bounds) throw new Error('Job row button must be visible');
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await page.mouse.down();
      refresh.release();
      await expect(state).toContainText('網站已更新至目前保存的內容。');
      sameLayout(ready, await layout(page));
      const detailRead = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          response.url().endsWith(`/api/v1/jobs/${created.id}`),
      );
      await page.mouse.up();
      expect((await detailRead).status()).toBe(200);
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await page
        .locator('dialog[open]')
        .getByRole('button', { name: /^關閉/u })
        .first()
        .click();
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      await expect(state).toContainText('網站已更新至目前保存的內容。');

      const records = card.locator('.artifact-records');
      const complete = card.getByRole('region', {
        name: '完整網站更新資訊',
        exact: true,
      });
      await state
        .getByRole('button', { name: '更新提醒（1）', exact: true })
        .click();
      await expect(complete).toBeFocused();
      await expect(complete).toContainText('完整更新提醒仍可閱讀。');
      await records.locator('summary').first().click();
      failure = true;
      await expect(state).toContainText('暫時無法確認網站狀態，請重新檢查。');
      await expect(card).not.toContainText('網站已更新至目前保存的內容。');
      await expect(card.locator('.artifact-counts')).toHaveText(
        /— 個頁面、— 個檔案/u,
      );
      await expect(card.locator('.artifact-update-time')).toHaveText(
        '更新於 —',
      );
      const unavailable = await layout(page);
      sameLayout(ready, unavailable);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`artifact-${width}-error.png`),
        fullPage: true,
      });
      await records.locator('summary').first().focus();
      await page.keyboard.press('Enter');
      await expect(complete.getByRole('alert')).toContainText(
        '完整錯誤訊息結尾。',
      );
      await complete.focus();
      await page.keyboard.press('End');
      await expect
        .poll(() => complete.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await expect
        .poll(() =>
          complete.evaluate(
            (element) =>
              element.scrollTop >=
              element.scrollHeight - element.clientHeight - 1,
          ),
        )
        .toBe(true);
      expect(
        await complete.evaluate((element) => {
          const paragraph = element.querySelector('[role="alert"] > p');
          const text = paragraph?.firstChild;
          if (!text || text.nodeType !== Node.TEXT_NODE) return false;
          const range = document.createRange();
          range.setStart(
            text,
            Math.max(0, (text.textContent?.length ?? 0) - 10),
          );
          range.setEnd(text, text.textContent?.length ?? 0);
          const tail = range.getBoundingClientRect();
          const viewport = element.getBoundingClientRect();
          return tail.top >= viewport.top && tail.bottom <= viewport.bottom;
        }),
      ).toBe(true);
      await page.keyboard.press('Tab');
      await expect(complete.locator('summary')).toBeFocused();
      await page.keyboard.press('Enter');
      await complete.focus();
      await page.keyboard.press('End');
      await expect(complete).toContainText(apiError.error.requestId);
      await page.screenshot({
        path: test.info().outputPath(`artifact-${width}-error-details.png`),
        fullPage: true,
      });
      await records.locator('summary').first().click();
      geometries.push({
        width,
        typography,
        waiting,
        ready,
        refreshing,
        unavailable,
      });
    }
    await test.info().attach('artifact-layout-states.json', {
      body: JSON.stringify(geometries, null, 2),
      contentType: 'application/json',
    });
    expect(
      await Promise.all(
        sourcePaths.map((path) => readFile(join(environment.root, path))),
      ),
    ).toEqual(sources);
  } finally {
    releasePending();
    await page.mouse.up().catch(() => undefined);
    await page.unroute('**/api/v1/artifacts/current');
    await environment.close();
  }
});
