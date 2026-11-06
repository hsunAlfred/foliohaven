import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArticleMetaSchema } from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';

test.use({ viewport: { width: 1536, height: 1000 } });

declare global {
  interface Window {
    __focusOwnerFrame?: {
      arm: () => void;
      pending: () => boolean;
      release: () => Promise<void>;
      stack: () => string;
    };
  }
}

async function installFrameGate(page: Page, module: string) {
  await page.addInitScript((targetModule) => {
    const nativeFrame = window.requestAnimationFrame.bind(window);
    let armed = false;
    let pending: FrameRequestCallback | null = null;
    let capturedStack = '';
    window.__focusOwnerFrame = {
      arm: () => {
        if (armed || pending) throw new Error('Focus callback already armed');
        armed = true;
      },
      pending: () => pending !== null,
      stack: () => capturedStack,
      release: () => {
        const callback = pending;
        if (!callback) throw new Error('No actual callback captured');
        pending = null;
        return new Promise<void>((resolve) => {
          nativeFrame((timestamp) => {
            try {
              callback(timestamp);
            } finally {
              resolve();
            }
          });
        });
      },
    };
    window.requestAnimationFrame = (callback) => {
      const stack = new Error().stack ?? '';
      if (armed && stack.includes(targetModule)) {
        armed = false;
        pending = callback;
        capturedStack = stack;
        return nativeFrame(() => {});
      }
      return nativeFrame(callback);
    };
  }, module);
}
const arm = (page: Page) =>
  page.evaluate(() => {
    const frame = window.__focusOwnerFrame;
    if (!frame) throw new Error('Focus callback gate was not installed');
    frame.arm();
  });
const release = (page: Page) =>
  page.evaluate(() => {
    const frame = window.__focusOwnerFrame;
    if (!frame) throw new Error('Focus callback gate was not installed');
    return frame.release();
  });
const pending = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() => window.__focusOwnerFrame?.pending() ?? false),
    )
    .toBe(true);
const state = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    return {
      time: performance.now(),
      tag: element?.tagName,
      id: element?.id,
      role: element?.getAttribute('role'),
      field: element?.getAttribute('data-field'),
      label: element?.getAttribute('aria-label'),
      text: element?.textContent?.trim().slice(0, 100),
      stack: window.__focusOwnerFrame?.stack(),
    };
  });

test('選圖延後焦點：正常還原且尊重使用者移往文章標題', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    const source = join(environment.root, 'content/articles/one/meta.json');
    const original = await readFile(source);
    await installFrameGate(page, 'ImageSelect.tsx');
    await page.goto(`${environment.url}/#/articles/one`);
    const trigger = page.getByRole('combobox', {
      name: '精選圖片',
      exact: true,
    });
    const title = page.getByLabel('文章標題', { exact: true });
    const picker = page.getByRole('dialog', {
      name: '選擇精選圖片',
      exact: true,
    });
    const choose = async () => {
      await trigger.click();
      await arm(page);
      await picker
        .getByRole('button', { name: '不使用精選圖片', exact: false })
        .click();
      await pending(page);
      await expect(picker).toHaveCount(0);
    };
    await choose();
    await release(page);
    await expect(trigger).toBeFocused();
    const normal = await state(page);
    await choose();
    await title.focus();
    await expect(title).toBeFocused();
    const before = await state(page);
    await release(page);
    await expect(title).toBeFocused();
    const after = await state(page);
    await page.keyboard.insertText('繼續輸入');
    await expect(title).toHaveValue(/繼續輸入/u);
    await test.info().attach('actual-callback-focus-proof.json', {
      body: JSON.stringify({ normal, before, after }, null, 2),
      contentType: 'application/json',
    });
    expect(await readFile(source)).toEqual(original);
  } finally {
    await environment.close();
  }
});

test('日曆延後焦點：保留時間欄位焦點且跨月移除仍可導航', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    const source = join(environment.root, 'content/articles/one/meta.json');
    const meta = ArticleMetaSchema.parse(
      JSON.parse(await readFile(source, 'utf8')),
    );
    await writeFile(
      source,
      JSON.stringify({ ...meta, publishedAt: '2026-02-28T04:05:06.000Z' }),
    );
    const original = await readFile(source);
    await installFrameGate(page, 'DateTimeField.tsx');
    await page.goto(`${environment.url}/#/articles/one`);
    await page.locator('.editor-dates > summary').click();
    await page
      .getByRole('button', { name: '選擇發布時間', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: '選擇發布時間',
      exact: true,
    });
    const day = (number: number) =>
      dialog.getByRole('button', { name: `2026年2月${number}日`, exact: true });
    await day(28).focus();
    await arm(page);
    await day(28).press('ArrowLeft');
    await pending(page);
    await release(page);
    await expect(day(27)).toBeFocused();
    const normal = await state(page);
    await arm(page);
    await day(27).press('ArrowLeft');
    await pending(page);
    const hour = dialog.getByLabel('小時', { exact: true });
    await hour.focus();
    await expect(hour).toBeFocused();
    const before = await state(page);
    await release(page);
    await expect(hour).toBeFocused();
    const after = await state(page);
    await hour.selectOption('7');
    await expect(hour).toHaveValue('7');
    await day(26).focus();
    const previousDay = await day(26).elementHandle();
    if (!previousDay) throw new Error('Original calendar day must exist');
    await arm(page);
    await day(26).press('PageDown');
    await pending(page);
    expect(await previousDay.evaluate((element) => element.isConnected)).toBe(
      false,
    );
    expect(
      await page.evaluate(() => document.activeElement === document.body),
    ).toBe(true);
    const removed = await state(page);
    await release(page);
    const nextMonth = dialog.getByRole('button', {
      name: '2026年3月26日',
      exact: true,
    });
    await expect(nextMonth).toBeFocused();
    const restored = await state(page);
    await test.info().attach('removed-calendar-owner.json', {
      body: JSON.stringify({ removed, restored }, null, 2),
      contentType: 'application/json',
    });
    await test.info().attach('actual-callback-focus-proof.json', {
      body: JSON.stringify({ normal, before, after }, null, 2),
      contentType: 'application/json',
    });
    expect(await readFile(source)).toEqual(original);
  } finally {
    await environment.close();
  }
});

test('設定頁籤延後焦點：正常導航且保留使用者已進入的欄位', async ({ page }) => {
  const environment = await studioEnvironment();
  try {
    const source = join(environment.root, 'content/site.json');
    const original = await readFile(source);
    await installFrameGate(page, 'SiteSettingsView.tsx');
    await page.goto(`${environment.url}/#/settings`);
    const general = page.getByRole('tab', { name: '網站與作者', exact: true });
    const navigation = page.getByRole('tab', { name: '導覽', exact: true });
    await general.focus();
    await arm(page);
    await general.press('ArrowRight');
    await pending(page);
    await release(page);
    await expect(navigation).toBeFocused();
    const normal = await state(page);
    await arm(page);
    await navigation.press('ArrowLeft');
    await pending(page);
    const name = page.getByLabel('網站名稱', { exact: true });
    await name.focus();
    await expect(name).toBeFocused();
    const before = await state(page);
    await release(page);
    await expect(name).toBeFocused();
    const after = await state(page);
    await page.keyboard.insertText('繼續輸入');
    await expect(name).toHaveValue(/繼續輸入/u);
    await test.info().attach('actual-callback-focus-proof.json', {
      body: JSON.stringify({ normal, before, after }, null, 2),
      contentType: 'application/json',
    });
    expect(await readFile(source)).toEqual(original);
  } finally {
    await environment.close();
  }
});
