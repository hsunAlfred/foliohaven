import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tag, Taxonomy } from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';

test.use({ viewport: { width: 1536, height: 1000 } });

test('文章內新增 Tag：全站保存、取消勾選、重新套用與文章保存分離', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const articlePath = join(environment.root, 'content/articles/one/meta.json');
  const tagsPath = join(environment.root, 'content/tags.json');
  const categoriesPath = join(environment.root, 'content/categories.json');
  const originalArticle = await readFile(articlePath, 'utf8');
  const initial = JSON.parse(originalArticle) as { tags: string[] };
  const originalTags = JSON.parse(await readFile(tagsPath, 'utf8')) as Tag[];
  const originalCategories = await readFile(categoriesPath, 'utf8');
  const articleMutations: string[] = [];
  page.on('request', (request) => {
    if (
      /^\/api\/v1\/articles(?:\/|$)/u.test(new URL(request.url()).pathname) &&
      request.method() !== 'GET'
    )
      articleMutations.push(request.method());
  });
  try {
    await page.goto(environment.url);
    await page
      .locator('tr[data-article-id="one"] .article-title-button')
      .click();
    await expect(
      page.getByTitle('文章即時預覽', { exact: true }),
    ).toBeVisible();
    const title = page.getByLabel('文章標題', { exact: true });
    await title.fill('尚未保存的文章標題仍需保留');
    const trigger = page.getByRole('button', { name: '選擇 Tag', exact: true });
    await trigger.click();
    const picker = page.getByRole('dialog', { name: '選擇 Tag', exact: true });
    await picker.getByRole('button', { name: '新增 Tag', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新增 Tag', exact: true });
    await create
      .getByLabel('Tag 名稱', { exact: true })
      .fill('WebSocket Testing');
    await create
      .getByLabel('Tag 網址名稱', { exact: true })
      .fill('websocket-testing');
    await create
      .getByLabel('Tag 描述', { exact: true })
      .fill('測試即時通訊應用的連線與訊息行為。');
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/taxonomy' &&
        response.request().method() === 'PUT',
    );
    await create
      .getByRole('button', { name: '建立並勾選', exact: true })
      .click();
    expect((await created).status()).toBe(200);
    await expect(create).not.toBeVisible();
    await expect(picker).toBeVisible();
    await expect(
      picker.getByRole('checkbox', {
        name: 'WebSocket Testing websocket-testing',
        exact: true,
      }),
    ).toBeChecked();
    await expect(
      picker.getByRole('checkbox', {
        name: 'WebSocket Testing websocket-testing',
        exact: true,
      }),
    ).toBeFocused();
    expect(articleMutations).toEqual([]);
    expect(await readFile(articlePath, 'utf8')).toBe(originalArticle);
    const createdTags = JSON.parse(await readFile(tagsPath, 'utf8')) as Tag[];
    expect(createdTags).toHaveLength(originalTags.length + 1);
    expect(createdTags.at(-1)).toMatchObject({
      slug: 'websocket-testing',
      name: 'WebSocket Testing',
      description: '測試即時通訊應用的連線與訊息行為。',
    });
    expect(JSON.parse(await readFile(categoriesPath, 'utf8'))).toEqual(
      JSON.parse(originalCategories),
    );

    await picker.getByRole('button', { name: '取消', exact: true }).click();
    await expect(picker).not.toBeVisible();
    await expect(title).toHaveValue('尚未保存的文章標題仍需保留');
    const selected = page.getByRole('list', {
      name: '文章已選 Tag',
      exact: true,
    });
    await expect(
      selected.getByText('WebSocket Testing', { exact: true }),
    ).toHaveCount(0);
    expect(await readFile(articlePath, 'utf8')).toBe(originalArticle);

    await trigger.click();
    await picker
      .getByRole('searchbox', { name: '搜尋 Tag', exact: true })
      .fill('websocket-testing');
    const option = picker.getByRole('checkbox', {
      name: 'WebSocket Testing websocket-testing',
      exact: true,
    });
    await expect(option).not.toBeChecked();
    await option.check();
    await picker.getByRole('button', { name: '套用選擇', exact: true }).click();
    await expect(
      selected.getByText('WebSocket Testing', { exact: true }),
    ).toBeVisible();
    await expect(title).toHaveValue('尚未保存的文章標題仍需保留');
    expect(await readFile(articlePath, 'utf8')).toBe(originalArticle);
    expect(articleMutations).toEqual([]);
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/articles/one' &&
        response.request().method() === 'PUT',
    );
    await page
      .getByRole('button', { name: '保存目前內容', exact: true })
      .click();
    expect((await saved).status()).toBe(200);
    const savedArticle = JSON.parse(await readFile(articlePath, 'utf8')) as {
      title: string;
      tags: string[];
    };
    expect(savedArticle.title).toBe('尚未保存的文章標題仍需保留');
    expect(savedArticle.tags).toEqual([...initial.tags, 'websocket-testing']);
    expect(JSON.parse(await readFile(tagsPath, 'utf8'))).toEqual(createdTags);
  } finally {
    await environment.close();
  }
});

test('文章內新增 Tag：手機表單、必要欄位、網址格式及同名檢查', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const tagsPath = join(environment.root, 'content/tags.json');
  const before = await readFile(tagsPath, 'utf8');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname === '/api/v1/taxonomy' &&
      request.method() === 'PUT'
    )
      writes.push(request.method());
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(environment.url);
    await page
      .locator('tr[data-article-id="one"] .article-title-button')
      .click();
    await page.getByRole('tab', { name: '文章設定', exact: true }).click();
    await page.getByRole('button', { name: '選擇 Tag', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '選擇 Tag', exact: true });
    await picker.getByRole('button', { name: '新增 Tag', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新增 Tag', exact: true });
    const name = create.getByLabel('Tag 名稱', { exact: true });
    const slug = create.getByLabel('Tag 網址名稱', { exact: true });
    const description = create.getByLabel('Tag 描述', { exact: true });
    const submit = create.getByRole('button', {
      name: '建立並勾選',
      exact: true,
    });
    await name.fill('新測試標籤');
    await slug.fill('new-topic');
    await submit.click();
    await expect(create.getByRole('alert')).toBeVisible();
    await expect(name).toHaveValue('新測試標籤');
    expect(writes).toEqual([]);
    await description.fill('新的實作主題。');
    await slug.fill('Invalid Slug');
    await submit.click();
    await expect(create.getByRole('alert')).toBeVisible();
    expect(writes).toEqual([]);
    await slug.fill('new-topic');
    await name.fill('範例');
    const currentTaxonomy = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/taxonomy' &&
        response.request().method() === 'GET',
    );
    await submit.click();
    expect((await currentTaxonomy).status()).toBe(200);
    await expect(create.getByRole('alert')).toContainText(
      /已存在|已使用|同名|重複/u,
    );
    await expect(create).toBeVisible();
    await expect(description).toHaveValue('新的實作主題。');
    expect(writes).toEqual([]);
    expect(await readFile(tagsPath, 'utf8')).toBe(before);
    expect(
      await create.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await expect(submit).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(create).not.toBeVisible();
    await expect(picker).toBeVisible();
    await expect(
      picker.getByRole('button', { name: '新增 Tag', exact: true }),
    ).toBeFocused();
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await environment.close();
  }
});

test('連續新增 Tag：延遲的舊清單不會吃掉第二個 Tag，達上限後焦點仍在新選項', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const articlePath = join(environment.root, 'content/articles/one/meta.json');
  const tagsPath = join(environment.root, 'content/tags.json');
  const original = JSON.parse(await readFile(articlePath, 'utf8')) as Record<
    string,
    unknown
  >;
  const initialTags = [
    'example',
    ...Array.from({ length: 17 }, (_, index) => `topic-${index}`),
  ];
  await writeFile(
    articlePath,
    JSON.stringify({ ...original, tags: initialTags }),
  );
  await writeFile(
    tagsPath,
    JSON.stringify(
      initialTags.map((slug) => ({
        slug,
        name: slug === 'example' ? '範例' : slug,
        description: `${slug} 主題說明`,
      })),
    ),
  );
  const before = await readFile(articlePath, 'utf8');
  const gate = () => {
    let release = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { wait, release };
  };
  const releaseFirstReload = gate();
  const firstReloadCaptured = gate();
  const releaseSecondWrite = gate();
  const secondWriteCaptured = gate();
  let firstCreated = false;
  let firstReloadHeld = false;
  let secondCreated = false;
  let failedReloads = 0;
  const articleWrites: string[] = [];
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname === '/api/v1/articles/one' &&
      request.method() !== 'GET'
    )
      articleWrites.push(request.method());
  });
  await page.route('**/api/v1/taxonomy', async (route) => {
    if (route.request().method() === 'PUT') {
      const candidate = route.request().postDataJSON() as Taxonomy;
      const response = await route.fetch();
      if (candidate.tags.some((tag) => tag.slug === 'race-second')) {
        secondWriteCaptured.release();
        await releaseSecondWrite.wait;
        secondCreated = true;
      } else firstCreated = true;
      await route.fulfill({ response });
      return;
    }
    if (route.request().method() !== 'GET') return route.continue();
    if (secondCreated) {
      failedReloads += 1;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'TEST_REFRESH_UNAVAILABLE',
            message: '隔離測試：第二輪重新讀取失敗。',
            retryable: true,
            issues: [],
            requestId: '00000000-0000-4000-8000-000000000001',
          },
        }),
      });
      return;
    }
    if (firstCreated && !firstReloadHeld) {
      firstReloadHeld = true;
      const response = await route.fetch();
      const snapshot = (await response.json()) as Taxonomy;
      // A display-only marker proves this delayed response reached the parent
      // React state before the second create callback runs. The Tag data is
      // the real first-write snapshot and intentionally lacks the second Tag.
      const marked = {
        ...snapshot,
        categories: snapshot.categories.map((category) =>
          category.path === 'notes'
            ? { ...category, name: '筆記（延遲讀取完成）' }
            : category,
        ),
      };
      firstReloadCaptured.release();
      await releaseFirstReload.wait;
      await route.fulfill({ response, json: marked });
      return;
    }
    await route.continue();
  });
  try {
    await page.goto(environment.url);
    await page
      .locator('tr[data-article-id="one"] .article-title-button')
      .click();
    await page.getByRole('button', { name: '選擇 Tag', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '選擇 Tag', exact: true });
    const create = page.getByRole('dialog', { name: '新增 Tag', exact: true });
    for (const [slug, name] of [
      ['race-first', 'Race First'],
      ['race-second', 'Race Second'],
    ] as const) {
      await picker
        .getByRole('button', { name: '新增 Tag', exact: true })
        .click();
      await create.getByLabel('Tag 名稱', { exact: true }).fill(name);
      await create.getByLabel('Tag 網址名稱', { exact: true }).fill(slug);
      await create
        .getByLabel('Tag 描述', { exact: true })
        .fill(`${name} 主題說明。`);
      await create
        .getByRole('button', { name: '建立並勾選', exact: true })
        .click();
      if (slug === 'race-first') {
        await expect(create).not.toBeVisible();
        await firstReloadCaptured.wait;
      } else {
        await secondWriteCaptured.wait;
        releaseFirstReload.release();
        await expect(
          page.locator('[data-field="meta.category"] option[value="notes"]'),
        ).toHaveText('筆記（延遲讀取完成）');
        releaseSecondWrite.release();
        await expect(create).not.toBeVisible();
      }
    }
    const second = picker.getByRole('checkbox', {
      name: 'Race Second race-second',
      exact: true,
    });
    await expect(second).toBeChecked();
    await expect(second).toBeFocused();
    await expect(
      picker.getByRole('button', { name: '新增 Tag', exact: true }),
    ).toBeDisabled();
    await expect(picker.getByRole('status')).toContainText('已勾選 20 / 20');
    await expect.poll(() => failedReloads, { timeout: 15_000 }).toBe(4);
    await expect(second).toBeChecked();
    await expect(second).toBeFocused();
    await expect(picker.locator('.article-tags-warning')).toHaveCount(0);
    await picker
      .getByRole('searchbox', { name: '搜尋 Tag', exact: true })
      .fill('');
    await expect(
      picker.getByRole('checkbox', {
        name: 'Race First race-first',
        exact: true,
      }),
    ).toBeChecked();
    await expect(second).toBeChecked();
    await expect(
      picker.getByRole('searchbox', { name: '搜尋 Tag', exact: true }),
    ).toBeFocused();
    expect(await readFile(articlePath, 'utf8')).toBe(before);
    expect(articleWrites).toEqual([]);
    const savedTags = JSON.parse(await readFile(tagsPath, 'utf8')) as Tag[];
    expect(savedTags.map((tag) => tag.slug)).toEqual([
      ...initialTags,
      'race-first',
      'race-second',
    ]);
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    await expect(picker).not.toBeVisible();
    await expect(
      page.getByRole('button', { name: '選擇 Tag', exact: true }),
    ).toBeFocused();
    await expect(
      page
        .getByRole('list', { name: '文章已選 Tag', exact: true })
        .getByRole('listitem'),
    ).toHaveCount(18);
    expect(await readFile(articlePath, 'utf8')).toBe(before);
  } finally {
    releaseFirstReload.release();
    releaseSecondWrite.release();
    await page.unrouteAll({ behavior: 'wait' });
    await environment.close();
  }
});
