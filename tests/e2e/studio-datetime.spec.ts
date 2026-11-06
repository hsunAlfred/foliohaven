import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ArticleMetaSchema,
  ArticleResourceSchema,
  ArticleWriteSchema,
  SiteConfigSchema,
} from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';

test.use({
  viewport: { width: 1536, height: 1000 },
  timezoneId: 'America/Los_Angeles',
});
type Environment = Awaited<ReturnType<typeof studioEnvironment>>;

async function configure(
  environment: Environment,
  timeZone: string,
  publishedAt: string | null = '2026-01-01T00:00:00.000Z',
  updatedAt: string | null = null,
) {
  const sitePath = join(environment.root, 'content/site.json');
  const site = SiteConfigSchema.parse(
    JSON.parse(await readFile(sitePath, 'utf8')),
  );
  await writeFile(sitePath, JSON.stringify({ ...site, timeZone }));
  const metaPath = join(environment.root, 'content/articles/one/meta.json');
  const meta = ArticleMetaSchema.parse(
    JSON.parse(await readFile(metaPath, 'utf8')),
  );
  await writeFile(
    metaPath,
    JSON.stringify({ ...meta, publishedAt, updatedAt }),
  );
}
async function metadata(environment: Environment) {
  return ArticleMetaSchema.parse(
    JSON.parse(
      await readFile(
        join(environment.root, 'content/articles/one/meta.json'),
        'utf8',
      ),
    ),
  );
}
async function originalFiles(environment: Environment) {
  return Promise.all(
    ['meta.json', 'content.html'].map((name) =>
      readFile(join(environment.root, 'content/articles/one', name)),
    ),
  );
}
async function openArticle(page: Page, environment: Environment) {
  await page.goto(environment.url);
  await page.locator('tr[data-article-id="one"] .article-title-button').click();
  await expect(
    page.getByRole('heading', { name: '編輯文章：文章', exact: true }),
  ).toBeVisible();
  const settings = page.getByRole('tab', { name: '文章設定', exact: true });
  if (await settings.isVisible()) await settings.click();
  await page.locator('.editor-dates > summary').click();
}
async function save(page: Page) {
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().endsWith('/api/v1/articles/one'),
  );
  await page.getByRole('button', { name: '保存目前內容', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(200);
  return ArticleResourceSchema.parse(await response.json());
}
async function confirm(
  page: Page,
  action: () => Promise<unknown>,
  accept: boolean,
) {
  const decision = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await action();
  await decision;
}
async function back(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error('Back未在期限內移至返回目標')),
          5000,
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
async function navigate(page: Page, label: string) {
  const target = page.getByRole('button', { name: label, exact: true });
  if (!(await target.isVisible()))
    await page.getByRole('button', { name: '開啟導覽', exact: true }).click();
  await target.click();
}
async function settleInput(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
function observeWrites(page: Page) {
  let writes = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === '/api/v1/articles/one'
    )
      writes++;
  });
  return () => writes;
}
async function chooseDate(
  dialog: Locator,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
) {
  await dialog.getByLabel('年份', { exact: true }).selectOption(String(year));
  await dialog.getByLabel('月份', { exact: true }).selectOption(String(month));
  await dialog
    .getByRole('button', { name: `${year}年${month}月${day}日`, exact: true })
    .click();
  await dialog.getByLabel('小時', { exact: true }).selectOption(String(hour));
  await dialog.getByLabel('分鐘', { exact: true }).selectOption(String(minute));
  await dialog.getByLabel('秒', { exact: true }).selectOption(String(second));
}

test('日期時間：以網站Taipei解讀日曆與ISO，瀏覽器LA不影響UTC保存與毫秒', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await configure(
      environment,
      'Asia/Taipei',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    const before = await originalFiles(environment);
    await openArticle(page, environment);
    expect(
      await page.evaluate(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    ).toBe('America/Los_Angeles');
    const published = page.getByLabel('發布時間', { exact: true });
    const updated = page.getByLabel('更新時間', { exact: true });
    await expect(published).toHaveValue('2026-01-01 08:00:00');
    await expect(updated).toHaveValue('2026-01-01 08:00:00');
    await page
      .getByRole('button', { name: '選擇發布時間', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: '選擇發布時間',
      exact: true,
    });
    await chooseDate(dialog, 2026, 2, 28, 23, 45, 6);
    await expect(published).toHaveValue('2026-01-01 08:00:00');
    expect(await originalFiles(environment)).toEqual(before);
    await dialog.getByRole('button', { name: '套用時間', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(published).toHaveValue('2026-02-28 23:45:06');
    await updated.fill('2026-03-01T02:22:33.456+09:00');
    await updated.press('Tab');
    await expect(updated).toHaveValue('2026-03-01 01:22:33.456');
    const response = await save(page);
    expect(response.meta.publishedAt).toBe('2026-02-28T15:45:06.000Z');
    expect(response.meta.updatedAt).toBe('2026-02-28T17:22:33.456Z');
    const saved = await metadata(environment);
    expect(saved.publishedAt).toBe(response.meta.publishedAt);
    expect(saved.updatedAt).toBe(response.meta.updatedAt);
    expect(
      await readFile(
        join(environment.root, 'content/articles/one/content.html'),
      ),
    ).toEqual(before[1]);
  } finally {
    await environment.close();
  }
});

test('日期時間：partial與無效閏日阻擋保存並保留dirty，明確清空才保存null', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await configure(
      environment,
      'Asia/Taipei',
      '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    );
    const before = await originalFiles(environment);
    const writes = observeWrites(page);
    await openArticle(page, environment);
    const published = page.getByLabel('發布時間', { exact: true });
    const updated = page.getByLabel('更新時間', { exact: true });
    await published.fill('2026-02-');
    await expect(published).toHaveAttribute('aria-invalid', 'true');
    await published.press('ControlOrMeta+s');
    await settleInput(page);
    expect(writes()).toBe(0);
    expect(await originalFiles(environment)).toEqual(before);
    await confirm(page, () => navigate(page, '全站設定'), false);
    await expect(page).toHaveURL(/#\/articles\/one$/u);
    await expect(published).toHaveValue('2026-02-');
    await page
      .getByRole('button', { name: '選擇發布時間', exact: true })
      .click();
    const picker = page.getByRole('dialog', {
      name: '選擇發布時間',
      exact: true,
    });
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(published).toHaveValue('2026-02-');
    await expect(published).toHaveAttribute('aria-invalid', 'true');
    expect(await originalFiles(environment)).toEqual(before);
    await published.fill('2026-02-29 10:11:12');
    await expect(published).toHaveAttribute('aria-invalid', 'true');
    await published.press('ControlOrMeta+s');
    await settleInput(page);
    expect(writes()).toBe(0);
    expect(await originalFiles(environment)).toEqual(before);
    await published.fill('2024-02-29 10:11:12');
    await expect(published).not.toHaveAttribute('aria-invalid', 'true');
    await published.fill('');
    await updated.fill('');
    const response = await save(page);
    expect(response.meta.publishedAt).toBeNull();
    expect(response.meta.updatedAt).toBeNull();
    expect(writes()).toBe(1);
    const saved = await metadata(environment);
    expect(saved.publishedAt).toBeNull();
    expect(saved.updatedAt).toBeNull();
  } finally {
    await environment.close();
  }
});

test('日期彈窗：鍵盤改暫存、CtrlS不寫文章，取消Escape與Back只捨棄已確認變更', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await configure(environment, 'Asia/Taipei', '2026-01-31T04:05:06.000Z');
    const before = await originalFiles(environment);
    const writes = observeWrites(page);
    await openArticle(page, environment);
    const published = page.getByLabel('發布時間', { exact: true });
    const trigger = page.getByRole('button', {
      name: '選擇發布時間',
      exact: true,
    });
    const dialog = page.getByRole('dialog', {
      name: '選擇發布時間',
      exact: true,
    });
    await trigger.click();
    await dialog.getByLabel('年份', { exact: true }).selectOption('2026');
    await dialog.getByLabel('月份', { exact: true }).selectOption('2');
    const day = dialog.getByRole('button', {
      name: '2026年2月28日',
      exact: true,
    });
    await day.focus();
    await day.press('ArrowLeft');
    const previous = dialog.getByRole('button', {
      name: '2026年2月27日',
      exact: true,
    });
    await expect(previous).toBeFocused();
    await previous.press('Space');
    await dialog.getByLabel('小時', { exact: true }).selectOption('2');
    await dialog.getByLabel('秒', { exact: true }).press('ControlOrMeta+s');
    await settleInput(page);
    expect(writes()).toBe(0);
    await expect(published).toHaveValue('2026-01-31 12:05:06');
    await confirm(
      page,
      () => dialog.getByRole('button', { name: '取消', exact: true }).click(),
      false,
    );
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('小時', { exact: true })).toHaveValue('2');
    await confirm(
      page,
      () => dialog.getByRole('button', { name: '取消', exact: true }).click(),
      true,
    );
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await originalFiles(environment)).toEqual(before);
    await trigger.click();
    await dialog.getByLabel('分鐘', { exact: true }).selectOption('17');
    await confirm(page, () => page.keyboard.press('Escape'), false);
    await expect(dialog).toBeVisible();
    await confirm(page, () => back(page), true);
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/#\/articles\/one$/u);
    await expect(published).toHaveValue('2026-01-31 12:05:06');
    expect(writes()).toBe(0);
    expect(await originalFiles(environment)).toEqual(before);
    // Clearing is an explicit change to the editor buffer, still not a file write.
    await trigger.click();
    await dialog.getByRole('button', { name: '清除', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(published).toHaveValue('');
    expect(await originalFiles(environment)).toEqual(before);
    await save(page);
    expect((await metadata(environment)).publishedAt).toBeNull();
  } finally {
    await environment.close();
  }
});

test('紐約DST：不存在時刻不保存，重複時刻必須明選並保存正確UTC候選', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await configure(
      environment,
      'America/New_York',
      '2026-03-01T10:00:00.000Z',
    );
    const before = await originalFiles(environment);
    const writes = observeWrites(page);
    await openArticle(page, environment);
    const published = page.getByLabel('發布時間', { exact: true });
    await published.fill('2026-03-08 02:30');
    await expect(published).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByText('這個時刻因時區調整而不存在，請選擇其他時間。', {
        exact: true,
      }),
    ).toBeVisible();
    await published.press('ControlOrMeta+s');
    await settleInput(page);
    expect(writes()).toBe(0);
    expect(await originalFiles(environment)).toEqual(before);
    await published.fill('2026-11-01 01:30');
    const overlap = page.getByRole('group', {
      name: '發布時間的重複時段',
      exact: true,
    });
    const first = overlap.getByRole('radio', {
      name: '第一次（UTC-04:00）',
      exact: true,
    });
    const second = overlap.getByRole('radio', {
      name: '第二次（UTC-05:00）',
      exact: true,
    });
    await expect(first).not.toBeChecked();
    await expect(second).not.toBeChecked();
    await published.press('ControlOrMeta+s');
    await settleInput(page);
    expect(writes()).toBe(0);
    await second.check();
    const later = await save(page);
    expect(later.meta.publishedAt).toBe('2026-11-01T06:30:00.000Z');
    expect((await metadata(environment)).publishedAt).toBe(
      '2026-11-01T06:30:00.000Z',
    );
    // A new edit must request a choice again, rather than reusing the last offset.
    await published.fill('2026-11-01 02:30');
    await published.fill('2026-11-01 01:30');
    await expect(first).not.toBeChecked();
    await expect(second).not.toBeChecked();
    await first.check();
    const earlier = await save(page);
    expect(earlier.meta.publishedAt).toBe('2026-11-01T05:30:00.000Z');
    expect((await metadata(environment)).publishedAt).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(
      await readFile(
        join(environment.root, 'content/articles/one/content.html'),
      ),
    ).toEqual(before[1]);
  } finally {
    await environment.close();
  }
});

test('日期手機版：390與320日曆可捲動，瀏覽同一ISO與未改動開關不會變髒', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const unexpectedDialogs: string[] = [];
  const dismissUnexpected = async (dialog: {
    message(): string;
    dismiss(): Promise<void>;
  }) => {
    unexpectedDialogs.push(dialog.message());
    await dialog.dismiss();
  };
  page.on('dialog', dismissUnexpected);
  try {
    await configure(
      environment,
      'Asia/Taipei',
      '2026-02-28T23:59:58.007+08:00',
      '2026-02-28T15:59:58.007Z',
    );
    const before = await originalFiles(environment);
    const writes = observeWrites(page);
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ]) {
      await page.setViewportSize(viewport);
      await openArticle(page, environment);
      const published = page.getByLabel('發布時間', { exact: true });
      await expect(published).toHaveValue('2026-02-28 23:59:58.007');
      await published.focus();
      await published.press('Tab');
      const trigger = page.getByRole('button', {
        name: '選擇發布時間',
        exact: true,
      });
      await trigger.click();
      const dialog = page.getByRole('dialog', {
        name: '選擇發布時間',
        exact: true,
      });
      await expect(dialog).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      if (bounds) {
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds.height).toBeLessThanOrEqual(viewport.height);
      }
      await page.keyboard.press('Tab');
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
      await page.keyboard.press('Shift+Tab');
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
      if (viewport.width === 320) {
        const canScroll = await dialog.evaluate((element) => {
          const candidates = [
            element,
            ...element.querySelectorAll<HTMLElement>('*'),
          ];
          const scroller = candidates.find(
            (candidate) =>
              candidate.scrollHeight > candidate.clientHeight + 2 &&
              /auto|scroll/u.test(getComputedStyle(candidate).overflowY),
          );
          if (!scroller) return false;
          scroller.scrollTop = scroller.scrollHeight;
          return scroller.scrollTop > 0;
        });
        expect(canScroll).toBe(true);
      }
      await page.screenshot({
        path: test.info().outputPath(`datetime-${viewport.width}.png`),
        fullPage: false,
      });
      await dialog
        .getByRole('button', {
          name: viewport.width === 390 ? '套用時間' : '取消',
          exact: true,
        })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(published).toHaveValue('2026-02-28 23:59:58.007');
      await navigate(page, '文章');
      await expect(page).toHaveURL(/#\/articles$/u);
      expect(unexpectedDialogs).toEqual([]);
      expect(writes()).toBe(0);
      expect(await originalFiles(environment)).toEqual(before);
    }
  } finally {
    page.off('dialog', dismissUnexpected);
    await environment.close();
  }
});

test('未知網站時區：不以瀏覽器時區代猜，日期控制不可編輯且原始ISO保持不變', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await configure(
      environment,
      'Asia/Taipei',
      '2026-01-01T00:00:00.123Z',
      '2026-01-02T00:00:00.123Z',
    );
    const before = await originalFiles(environment);
    const writes = observeWrites(page);
    await page.route('**/api/v1/site-settings', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 403,
        json: {
          error: {
            code: 'TIMEZONE_UNAVAILABLE',
            message: '隔離的網站時區讀取失敗。',
            retryable: false,
            issues: [],
            requestId: '11111111-1111-4111-8111-111111111111',
          },
        },
      });
    });
    await openArticle(page, environment);
    for (const name of ['發布時間', '更新時間']) {
      const input = page.getByLabel(name, { exact: true });
      await expect
        .poll(async () =>
          input.evaluate((element) => {
            const control = element as HTMLInputElement;
            return control.disabled || control.readOnly;
          }),
        )
        .toBe(true);
      await expect(
        page.getByRole('button', { name: `選擇${name}`, exact: true }),
      ).toBeDisabled();
    }
    await navigate(page, '文章');
    await expect(page).toHaveURL(/#\/articles$/u);
    expect(writes()).toBe(0);
    expect(await originalFiles(environment)).toEqual(before);
  } finally {
    await environment.close();
  }
});

test('日期412衝突：保留本機版本維持invalid暫存，採用已保存版本重設日期並以最新ETag保存', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const articlePath = join(environment.root, 'content/articles/one/meta.json');
  const articleResponse = (method: 'GET' | 'PUT') =>
    page.waitForResponse(
      (response) =>
        response.request().method() === method &&
        new URL(response.url()).pathname === '/api/v1/articles/one',
    );
  try {
    await configure(environment, 'Asia/Taipei');
    const writes = observeWrites(page);
    const loaded = articleResponse('GET');
    await openArticle(page, environment);
    const initial = await loaded;
    expect(initial.status()).toBe(200);
    const initialEtag = (await initial.headerValue('etag')) ?? '';
    expect(initialEtag).toMatch(/^"[a-f0-9]{64}"$/u);
    const published = page.getByLabel('發布時間', { exact: true });
    const saveButton = page.getByRole('button', {
      name: '保存目前內容',
      exact: true,
    });
    const conflict = page.getByRole('region', {
      name: '版本衝突',
      exact: true,
    });

    await published.fill('2026-02-28 12:34:56');
    const firstExternalDate = '2026-02-01T01:02:03.456Z';
    await writeFile(
      articlePath,
      JSON.stringify({
        ...(await metadata(environment)),
        publishedAt: firstExternalDate,
      }),
    );
    const firstExternalFiles = await originalFiles(environment);
    const firstFailed = articleResponse('PUT');
    const firstReloaded = articleResponse('GET');
    await saveButton.click();
    const firstFailure = await firstFailed;
    expect(firstFailure.status()).toBe(412);
    expect(firstFailure.request().headers()['if-match']).toBe(initialEtag);
    expect(
      ArticleWriteSchema.parse(firstFailure.request().postDataJSON()).meta
        .publishedAt,
    ).toBe('2026-02-28T04:34:56.000Z');
    const firstCurrent = await firstReloaded;
    expect(firstCurrent.status()).toBe(200);
    const firstCurrentEtag = (await firstCurrent.headerValue('etag')) ?? '';
    expect(firstCurrentEtag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(firstCurrentEtag).not.toBe(initialEtag);
    expect(
      ArticleResourceSchema.parse(await firstCurrent.json()).meta.publishedAt,
    ).toBe(firstExternalDate);
    await expect(conflict).toBeVisible();
    expect(await originalFiles(environment)).toEqual(firstExternalFiles);

    await published.fill('2026-02-');
    await expect(published).toHaveAttribute('aria-invalid', 'true');
    await expect(saveButton).toBeDisabled();
    await confirm(
      page,
      () =>
        conflict
          .getByRole('button', {
            name: '保留我的內容繼續編輯',
            exact: true,
          })
          .click(),
      true,
    );
    await expect(conflict).toHaveCount(0);
    await expect(published).toHaveValue('2026-02-');
    await expect(published).toHaveAttribute('aria-invalid', 'true');
    await expect(saveButton).toBeDisabled();
    await published.press('ControlOrMeta+s');
    await settleInput(page);
    expect(writes()).toBe(1);
    expect(await originalFiles(environment)).toEqual(firstExternalFiles);

    await published.fill('2026-03-01 11:22:33.004');
    await expect(published).not.toHaveAttribute('aria-invalid', 'true');
    await expect(saveButton).toBeEnabled();
    const secondExternalDate = '2026-03-02T02:03:04.005Z';
    await writeFile(
      articlePath,
      JSON.stringify({
        ...(await metadata(environment)),
        publishedAt: secondExternalDate,
      }),
    );
    const secondExternalFiles = await originalFiles(environment);
    const secondFailed = articleResponse('PUT');
    const secondReloaded = articleResponse('GET');
    await saveButton.click();
    const secondFailure = await secondFailed;
    expect(secondFailure.status()).toBe(412);
    expect(secondFailure.request().headers()['if-match']).toBe(
      firstCurrentEtag,
    );
    expect(
      ArticleWriteSchema.parse(secondFailure.request().postDataJSON()).meta
        .publishedAt,
    ).toBe('2026-03-01T03:22:33.004Z');
    const secondCurrent = await secondReloaded;
    expect(secondCurrent.status()).toBe(200);
    const secondCurrentEtag = (await secondCurrent.headerValue('etag')) ?? '';
    expect(secondCurrentEtag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(secondCurrentEtag).not.toBe(firstCurrentEtag);
    expect(
      ArticleResourceSchema.parse(await secondCurrent.json()).meta.publishedAt,
    ).toBe(secondExternalDate);
    await expect(conflict).toBeVisible();
    expect(await originalFiles(environment)).toEqual(secondExternalFiles);

    await published.fill('2026-03-');
    await expect(published).toHaveAttribute('aria-invalid', 'true');
    await expect(saveButton).toBeDisabled();
    const adopt = () =>
      conflict
        .getByRole('button', { name: '採用已保存版本', exact: true })
        .click();
    await confirm(page, adopt, false);
    await expect(conflict).toBeVisible();
    await expect(published).toHaveValue('2026-03-');
    await expect(saveButton).toBeDisabled();
    expect(await originalFiles(environment)).toEqual(secondExternalFiles);
    await confirm(page, adopt, true);
    await expect(conflict).toHaveCount(0);
    await expect(published).toHaveValue('2026-03-02 10:03:04.005');
    await expect(published).not.toHaveAttribute('aria-invalid', 'true');
    await expect(saveButton).toBeEnabled();
    await settleInput(page);
    expect(writes()).toBe(2);
    expect(await originalFiles(environment)).toEqual(secondExternalFiles);

    const accepted = articleResponse('PUT');
    const saved = await save(page);
    const success = await accepted;
    expect(success.request().headers()['if-match']).toBe(secondCurrentEtag);
    expect(saved.meta.publishedAt).toBe(secondExternalDate);
    expect((await metadata(environment)).publishedAt).toBe(secondExternalDate);
    expect(writes()).toBe(3);
    expect((await originalFiles(environment))[1]).toEqual(
      secondExternalFiles[1],
    );
  } finally {
    await environment.close();
  }
});
