import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PublishedArticleMetaSchema } from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';

test.use({ viewport: { width: 1536, height: 1000 } });

const id = (number: number) => `related-${String(number).padStart(2, '0')}`;
const title = (number: number) =>
  `延伸文章 ${String(number).padStart(2, '0')}${number === 25 ? ' needle' : ''}`;

test('延伸閱讀以輕量選項分頁搜尋，保留跨頁選擇、取消、順序及明確保存', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  const source = join(environment.root, 'content/articles/one/meta.json');
  const original = JSON.parse(await readFile(source, 'utf8')) as Record<
    string,
    unknown
  >;
  const collectionReads: string[] = [];
  const optionRequests: string[] = [];
  const options: URL[] = [];
  const mutations: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/articles' && request.method() === 'GET')
      collectionReads.push(request.url());
    if (url.pathname === '/api/v1/article-options')
      optionRequests.push(request.url());
    if (url.pathname === '/api/v1/articles/one' && request.method() !== 'GET')
      mutations.push(request.method());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    // Development StrictMode cancels its first effect. Count completed reads,
    // while retaining the request observer above to reject full collections.
    if (
      response.request().method() === 'GET' &&
      response.status() === 200 &&
      url.pathname === '/api/v1/article-options'
    )
      options.push(url);
  });
  try {
    for (let number = 1; number <= 25; number++) {
      const directory = join(environment.root, 'content/articles', id(number));
      const date = `2026-01-${String(number).padStart(2, '0')}T00:00:00.000Z`;
      const meta = PublishedArticleMetaSchema.parse({
        ...original,
        status: 'published',
        title: title(number),
        slug: id(number),
        publishedAt: date,
        updatedAt: date,
      });
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'meta.json'), JSON.stringify(meta));
      await writeFile(
        join(directory, 'content.html'),
        '<h2 id="intro">閱讀</h2><p>隔離的延伸閱讀測試正文。</p>',
      );
    }
    await writeFile(
      source,
      JSON.stringify({
        ...original,
        relatedReading: { title: '繼續閱讀', articleIds: [id(23)] },
      }),
    );
    const before = await readFile(source, 'utf8');
    await page.goto(`${environment.url}/#/articles/one`);
    const selected = page.getByRole('list', {
      name: '已選延伸閱讀文章',
      exact: true,
    });
    await expect(selected.locator('strong')).toHaveText([title(23)]);
    expect(collectionReads).toEqual([]);
    expect(options).toHaveLength(1);
    expect(options[0]?.searchParams.get('selected')).toBe(id(23));
    expect(options[0]?.searchParams.get('status')).toBe('published');
    expect(options[0]?.searchParams.get('pageSize')).toBe('20');

    const trigger = page.getByRole('button', {
      name: '選擇延伸閱讀文章',
      exact: true,
    });
    const dialog = page.getByRole('dialog', {
      name: '選擇延伸閱讀文章',
      exact: true,
    });
    await trigger.click();
    await expect(dialog.getByRole('checkbox')).toHaveCount(20);
    await dialog.getByRole('checkbox', { name: title(1), exact: true }).check();
    await dialog.getByRole('button', { name: '下一頁', exact: true }).click();
    await expect(dialog.getByRole('checkbox')).toHaveCount(5);
    await dialog
      .getByRole('checkbox', { name: title(25), exact: true })
      .check();
    await dialog.screenshot({
      path: test.info().outputPath('related-reading-picker.png'),
      caret: 'initial',
    });
    await dialog
      .getByRole('searchbox', { name: '搜尋可選文章' })
      .fill('NEEDLE');
    await expect(dialog.getByRole('checkbox')).toHaveCount(1);
    await expect(
      dialog.getByRole('checkbox', { name: title(25), exact: true }),
    ).toBeChecked();
    expect(options.at(-1)?.searchParams.get('page')).toBe('1');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(selected.locator('strong')).toHaveText([title(23)]);
    expect(await readFile(source, 'utf8')).toBe(before);

    await trigger.click();
    await expect(dialog.getByRole('checkbox')).toHaveCount(20);
    await expect(
      dialog.getByRole('checkbox', { name: title(1), exact: true }),
    ).not.toBeChecked();
    await dialog.getByRole('checkbox', { name: title(1), exact: true }).check();
    await dialog.getByRole('button', { name: '下一頁', exact: true }).click();
    await expect(dialog.getByRole('checkbox')).toHaveCount(5);
    await dialog
      .getByRole('checkbox', { name: title(25), exact: true })
      .check();
    const selectionNames = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.status() === 200 &&
        url.pathname === '/api/v1/article-options' &&
        url.searchParams.get('selected') === [id(1), id(23), id(25)].join(',')
      );
    });
    await dialog.getByRole('button', { name: '套用選擇', exact: true }).click();
    expect(await (await selectionNames).finished()).toBeNull();
    await expect(selected.locator('strong')).toHaveText([
      title(23),
      title(1),
      title(25),
    ]);
    const readsBeforeMove = optionRequests.length;
    await selected
      .getByRole('button', { name: `將「${title(25)}」往上移`, exact: true })
      .click();
    await expect(selected.locator('strong')).toHaveText([
      title(23),
      title(25),
      title(1),
    ]);
    for (const row of await selected.getByRole('listitem').all())
      expect((await row.boundingBox())?.height).toBeLessThan(80);
    await page.locator('.article-related-settings').screenshot({
      path: test.info().outputPath('related-reading-settings.png'),
      caret: 'initial',
    });
    expect(optionRequests).toHaveLength(readsBeforeMove);
    expect(collectionReads).toEqual([]);
    expect(mutations).toEqual([]);
    expect(await readFile(source, 'utf8')).toBe(before);

    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/articles/one' &&
        response.request().method() === 'PUT',
    );
    await page
      .getByRole('button', { name: '保存目前內容', exact: true })
      .click();
    expect((await saved).status()).toBe(200);
    const stored = JSON.parse(await readFile(source, 'utf8')) as {
      relatedReading: { title: string; articleIds: string[] };
    };
    expect(stored.relatedReading).toEqual({
      title: '繼續閱讀',
      articleIds: [id(23), id(25), id(1)],
    });
    await page.reload();
    await expect(selected.locator('strong')).toHaveText([
      title(23),
      title(25),
      title(1),
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: '文章設定', exact: true }).click();
    await trigger.click();
    await expect(dialog.getByRole('checkbox')).toHaveCount(20);
    await expect(
      dialog.getByRole('button', { name: '套用選擇', exact: true }),
    ).toBeEnabled();
    await expect(
      dialog.getByRole('button', { name: '套用選擇', exact: true }),
    ).toBeInViewport();
    await expect(
      dialog.getByRole('button', { name: '下一頁', exact: true }),
    ).toBeInViewport();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await dialog.screenshot({
      path: test.info().outputPath('related-reading-mobile.png'),
      caret: 'initial',
    });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  } finally {
    await environment.close();
  }
});
