import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { studioEnvironment } from '../fixtures/studio/environment.js';

// This fixture deliberately keeps a missing draft Tag to exercise recovery.
test('文章 Tag：大量清單搜尋、上限、取消、套用與保存分離及手機鍵盤操作', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const source = join(environment.root, 'content/articles/one/meta.json');
  const metadata = JSON.parse(await readFile(source, 'utf8')) as Record<
    string,
    unknown
  >;
  const initialTags = [
    'example',
    'missing-tag',
    ...Array.from({ length: 18 }, (_, i) => `topic-${i}`),
  ];
  await writeFile(source, JSON.stringify({ ...metadata, tags: initialTags }));
  await writeFile(
    join(environment.root, 'content/tags.json'),
    JSON.stringify([
      { slug: 'example', name: '範例', description: '範例資料' },
      {
        slug: 'django-channels',
        name: 'Django Channels',
        description: '即時應用',
      },
      ...Array.from({ length: 191 }, (_, i) => ({
        slug: `topic-${i}`,
        name: `主題 ${i}`,
        description: `主題 ${i} 說明`,
      })),
    ]),
  );
  const before = await readFile(source, 'utf8');
  const previews: string[] = [];
  const mutations: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/previews' && request.method() === 'POST')
      previews.push(path);
    if (
      /^\/api\/v1\/articles(?:\/|$)/u.test(path) &&
      request.method() !== 'GET'
    )
      mutations.push(path);
  });
  try {
    await page.setViewportSize({ width: 1536, height: 1000 });
    await page.goto(environment.url);
    await page
      .locator('tr[data-article-id="one"] .article-title-button')
      .click();
    await expect(
      page.getByTitle('文章即時預覽', { exact: true }),
    ).toBeVisible();
    const savedSelection = page.getByRole('list', {
      name: '文章已選 Tag',
      exact: true,
    });
    await expect(savedSelection.getByRole('listitem')).toHaveCount(20);
    await expect(
      savedSelection.getByText('missing-tag', { exact: false }),
    ).toContainText('已失效');
    const trigger = page.getByRole('button', { name: '選擇 Tag', exact: true });
    const previewCount = previews.length;
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '選擇 Tag', exact: true });
    const search = dialog.getByRole('searchbox', {
      name: '搜尋 Tag',
      exact: true,
    });
    await expect(
      dialog.getByRole('button', { name: '關閉選擇 Tag', exact: true }),
    ).toBeFocused();
    await expect(
      dialog
        .getByRole('group', { name: '可選 Tag', exact: true })
        .getByRole('checkbox'),
    ).toHaveCount(193);
    await search.fill('ＤＪＡＮＧＯ');
    const django = dialog.getByRole('checkbox', {
      name: 'Django Channels django-channels',
      exact: true,
    });
    await expect(django).toBeDisabled();
    await dialog
      .getByRole('button', { name: '移除 Tag：missing-tag', exact: true })
      .click();
    await expect(django).toBeEnabled();
    await django.focus();
    await page.keyboard.press('Space');
    await expect(django).toBeChecked();
    await search.fill('not-present');
    await expect(
      dialog.getByText('沒有符合的 Tag，請試試其他名稱或 slug。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog
        .getByRole('list', { name: '目前勾選 Tag', exact: true })
        .getByText('Django Channels', { exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(450);
    expect(previews).toHaveLength(previewCount);
    expect(mutations).toEqual([]);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(
      savedSelection.getByText('missing-tag', { exact: false }),
    ).toBeVisible();
    await expect(
      savedSelection.getByText('Django Channels', { exact: true }),
    ).toHaveCount(0);
    expect(await readFile(source, 'utf8')).toBe(before);

    await trigger.click();
    await search.fill('django-channels');
    await expect(django).not.toBeChecked();
    await dialog
      .getByRole('button', { name: '移除 Tag：missing-tag', exact: true })
      .click();
    await django.check();
    await dialog.getByRole('button', { name: '套用選擇', exact: true }).click();
    await expect(
      savedSelection.getByText('Django Channels', { exact: true }),
    ).toBeVisible();
    await expect(
      savedSelection.getByText('missing-tag', { exact: false }),
    ).toHaveCount(0);
    expect(await readFile(source, 'utf8')).toBe(before);
    expect(mutations).toEqual([]);
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/articles/one') &&
        response.request().method() === 'PUT',
    );
    await page
      .getByRole('button', { name: '保存目前內容', exact: true })
      .click();
    expect((await saved).status()).toBe(200);
    expect(
      (JSON.parse(await readFile(source, 'utf8')) as { tags: string[] }).tags,
    ).toEqual(
      initialTags
        .filter((slug) => slug !== 'missing-tag')
        .concat('django-channels'),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: '文章設定', exact: true }).click();
    await trigger.click();
    await expect(
      dialog.getByRole('button', { name: '關閉選擇 Tag', exact: true }),
    ).toBeFocused();
    await expect(
      dialog.getByRole('button', { name: '套用選擇', exact: true }),
    ).toBeInViewport();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await search.fill('EXAMPLE');
    await expect(
      dialog.getByRole('checkbox', { name: '範例 example', exact: true }),
    ).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await environment.close();
  }
});

declare global {
  interface Window {
    __foliohavenTagFocusFrame?: {
      arm: () => void;
      pending: () => boolean;
      release: () => Promise<void>;
    };
  }
}

test('移除 Tag 的延後焦點：保留使用者新焦點、原生 Space 選取與最後一項還原', async ({
  page,
}, testInfo) => {
  const environment = await studioEnvironment();
  const source = join(environment.root, 'content/articles/one/meta.json');
  const initialTags = [
    'example',
    'missing-tag',
    ...Array.from({ length: 18 }, (_, index) => `topic-${index}`),
  ];
  const metadata = JSON.parse(await readFile(source, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(source, JSON.stringify({ ...metadata, tags: initialTags }));
  await writeFile(
    join(environment.root, 'content/tags.json'),
    JSON.stringify([
      { slug: 'example', name: '範例', description: '範例資料' },
      {
        slug: 'django-channels',
        name: 'Django Channels',
        description: '即時應用',
      },
      ...Array.from({ length: 18 }, (_, index) => ({
        slug: `topic-${index}`,
        name: `主題 ${index}`,
        description: `主題 ${index} 說明`,
      })),
    ]),
  );
  const before = await readFile(source, 'utf8');
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (
      /^\/api\/v1\/articles(?:\/|$)/u.test(new URL(request.url()).pathname) &&
      request.method() !== 'GET'
    )
      mutations.push(request.method());
  });
  // Hold only the product's selected-Tag focus callback. Browser frames and
  // Playwright's own animation-frame checks keep their native scheduling.
  await page.addInitScript(() => {
    const nativeFrame = window.requestAnimationFrame.bind(window);
    let armed = false;
    let pending: FrameRequestCallback | null = null;
    window.__foliohavenTagFocusFrame = {
      arm: () => {
        if (armed || pending)
          throw new Error('Tag focus frame already pending');
        armed = true;
      },
      pending: () => pending !== null,
      release: () => {
        const callback = pending;
        if (!callback) throw new Error('Tag focus frame was not captured');
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
      if (armed && new Error().stack?.includes('ArticleTagsEditor.tsx')) {
        armed = false;
        pending = callback;
        return nativeFrame(() => {});
      }
      return nativeFrame(callback);
    };
  });
  const armFrame = () =>
    page.evaluate(() => {
      const gate = window.__foliohavenTagFocusFrame;
      if (!gate) throw new Error('Tag focus frame gate missing');
      gate.arm();
    });
  const releaseFrame = () =>
    page.evaluate(() => {
      const gate = window.__foliohavenTagFocusFrame;
      if (!gate) throw new Error('Tag focus frame gate missing');
      return gate.release();
    });
  const expectFramePending = () =>
    expect
      .poll(() =>
        page.evaluate(
          () => window.__foliohavenTagFocusFrame?.pending() ?? false,
        ),
      )
      .toBe(true);
  const focusState = () =>
    page.evaluate(() => {
      const dialog = document.querySelector('.article-tag-picker[open]');
      const active = document.activeElement;
      const django = dialog?.querySelector<HTMLInputElement>(
        'input[data-tag-slug="django-channels"]',
      );
      return {
        time: performance.now(),
        activeTag: active?.tagName,
        activeLabel: active?.getAttribute('aria-label'),
        djangoFocused: active === django,
        djangoChecked: django?.checked,
        selectedCount: dialog?.querySelectorAll(
          'ul[aria-label="目前勾選 Tag"] > li',
        ).length,
      };
    });
  try {
    await page.setViewportSize({ width: 1536, height: 1000 });
    await page.goto(environment.url);
    await page
      .locator('tr[data-article-id="one"] .article-title-button')
      .click();
    const trigger = page.getByRole('button', { name: '選擇 Tag', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '選擇 Tag', exact: true });
    const search = dialog.getByRole('searchbox', {
      name: '搜尋 Tag',
      exact: true,
    });
    const selected = dialog.getByRole('list', {
      name: '目前勾選 Tag',
      exact: true,
    });
    await search.fill('ＤＪＡＮＧＯ');
    const django = dialog.getByRole('checkbox', {
      name: 'Django Channels django-channels',
      exact: true,
    });
    await expect(django).toBeDisabled();
    const originalCheckbox = await django.elementHandle();
    if (!originalCheckbox) throw new Error('Django checkbox missing');
    const initialBounds = await django.boundingBox();
    await armFrame();
    await dialog
      .getByRole('button', { name: '移除 Tag：missing-tag', exact: true })
      .click();
    await expect(django).toBeEnabled();
    await expectFramePending();
    await django.focus();
    await expect(django).toBeFocused();
    const beforeFrame = await focusState();
    await releaseFrame();
    const afterFrame = await focusState();
    await page.keyboard.press('Space');
    const afterSpace = await focusState();
    await testInfo.attach('selected-tag-focus-state.json', {
      body: JSON.stringify({
        beforeFrame,
        afterFrame,
        afterSpace,
        initialBounds,
        finalBounds: await django.boundingBox(),
        sameCheckbox: await django.evaluate(
          (input, original) => input === original,
          originalCheckbox,
        ),
      }),
      contentType: 'application/json',
    });
    await expect(django).toBeChecked();
    await expect(django).toBeFocused();
    await expect(selected.getByRole('listitem')).toHaveCount(20);
    await expect(
      selected.getByRole('button', { name: '移除 Tag：主題 0', exact: true }),
    ).toBeVisible();
    expect(mutations).toEqual([]);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(trigger).toBeFocused();
    expect(await readFile(source, 'utf8')).toBe(before);

    // If focus has not moved, keyboard removal still restores the next chip.
    await trigger.click();
    await dialog
      .getByRole('button', { name: '移除 Tag：範例', exact: true })
      .focus();
    await armFrame();
    await page.keyboard.press('Space');
    await expect(selected.getByRole('listitem')).toHaveCount(19);
    await expectFramePending();
    await releaseFrame();
    await expect(
      dialog.getByRole('button', {
        name: '移除 Tag：missing-tag',
        exact: true,
      }),
    ).toBeFocused();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(await readFile(source, 'utf8')).toBe(before);

    // The final chip unmounts SelectedTags; its search fallback must survive.
    await trigger.click();
    for (let remaining = initialTags.length; remaining > 1; remaining--) {
      await selected.getByRole('button').first().click();
      await expect(selected.getByRole('listitem')).toHaveCount(remaining - 1);
    }
    await selected.getByRole('button').focus();
    await armFrame();
    await page.keyboard.press('Space');
    await expect(selected.getByRole('listitem')).toHaveCount(0);
    await expectFramePending();
    await releaseFrame();
    await expect(search).toBeFocused();
    await search.fill('django-channels');
    await django.focus();
    await page.keyboard.press('Space');
    await expect(django).toBeChecked();
    await dialog.getByRole('button', { name: '套用選擇', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await readFile(source, 'utf8')).toBe(before);
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/articles/one') &&
        response.request().method() === 'PUT',
    );
    await page
      .getByRole('button', { name: '保存目前內容', exact: true })
      .click();
    expect((await saved).status()).toBe(200);
    expect(
      (JSON.parse(await readFile(source, 'utf8')) as { tags: string[] }).tags,
    ).toEqual(['django-channels']);
  } finally {
    await environment.close();
  }
});
