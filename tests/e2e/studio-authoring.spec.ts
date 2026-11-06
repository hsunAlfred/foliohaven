import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArticleResourceSchema } from '@foliohaven/core';
import type { Page } from '@playwright/test';
import { studioEnvironment } from '../fixtures/studio/environment.js';

test.use({ viewport: { width: 1536, height: 1000 } });

async function closeDetail(page: Page) {
  const dialogs = page.locator('dialog[open]');
  while ((await dialogs.count()) > 0) {
    await dialogs.last().getByRole('button', { name: /^關閉/ }).first().click();
    await expect(dialogs).toHaveCount(0);
  }
}
async function navigate(page: Page, label: string) {
  await closeDetail(page);
  const target = page.getByRole('button', { name: label, exact: true });
  if (!(await target.isVisible()))
    await page.getByRole('button', { name: '開啟導覽', exact: true }).click();
  await target.click();
}
async function confirm(
  page: Page,
  action: () => Promise<unknown>,
  accept = true,
) {
  const dialog = page
    .waitForEvent('dialog')
    .then((value) => (accept ? value.accept() : value.dismiss()));
  await action();
  await dialog;
}
async function body(page: Page, value: string) {
  const editor = page.getByRole('textbox', { name: 'HTML 正文', exact: true });
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(value);
}

test('Studio真API：建立、原文保存、sandbox預覽、發布、更新、撤回、刪除與還原', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    await page.goto(environment.url);
    await expect(
      page.getByRole('heading', { name: '文章', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '新增文章', exact: true }).click();
    await page.getByLabel('文章標題', { exact: true }).fill('Studio 完整文章');
    await page
      .getByLabel('文章網址名稱', { exact: true })
      .fill('studio-authoring');
    await page.getByLabel('分類', { exact: true }).selectOption('notes');
    await page.getByRole('button', { name: '選擇 Tag', exact: true }).click();
    const tagPicker = page.getByRole('dialog', {
      name: '選擇 Tag',
      exact: true,
    });
    await tagPicker
      .getByRole('checkbox', { name: '範例 example', exact: true })
      .check();
    await tagPicker
      .getByRole('button', { name: '套用選擇', exact: true })
      .click();
    await page
      .getByLabel('Meta Description', { exact: true })
      .fill('完整工作室流程的文章說明。');
    const html =
      '<h2 id="intro">工作室章節</h2>\n<p data-example="raw">保留原文 &amp; 空白。</p>';
    await body(page, html);
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/articles') &&
        response.request().method() === 'POST' &&
        response.status() === 201,
    );
    await page.getByRole('button', { name: '建立草稿', exact: true }).click();
    const source = ArticleResourceSchema.parse(await (await created).json());
    await expect(
      page.getByRole('heading', {
        name: '編輯文章：Studio 完整文章',
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await readFile(
        join(environment.root, 'content/articles', source.id, 'content.html'),
        'utf8',
      ),
    ).toBe(html);
    const frame = page.getByTitle('文章即時預覽', { exact: true });
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(
      page
        .frameLocator('iframe[title="文章即時預覽"]')
        .getByRole('heading', { name: '工作室章節', exact: true }),
    ).toBeVisible();
    await page.locator('.editor-dates > summary').click();
    await page
      .getByRole('button', { name: '填入目前時間', exact: true })
      .click();
    const published = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/articles/${source.id}`) &&
        response.request().method() === 'PUT',
    );
    await confirm(page, () =>
      page.getByRole('button', { name: '發布目前內容', exact: true }).click(),
    );
    const publicationResponse = await published;
    expect(publicationResponse.status()).toBe(200);
    expect(
      ArticleResourceSchema.parse(await publicationResponse.json()),
    ).toMatchObject({
      id: source.id,
      contentHtml: html,
      meta: { status: 'published' },
    });
    await expect(
      page.getByText('文章已保存。更新網站後，讀者才會看到這次變更。', {
        exact: true,
      }),
    ).toBeVisible();
    const formalUrl = page.getByRole('link', {
      name: '正式網站網址',
      exact: true,
    });
    await expect(formalUrl).toHaveAttribute(
      'href',
      'https://example.invalid/notes/studio-authoring/',
    );
    await expect(formalUrl).toHaveAttribute('target', '_blank');
    await expect(
      page.getByRole('link', { name: '成功建置預覽', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText(
        '正式網址依網站設定產生；本機成功建置不代表已部署到正式網站。',
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    const publicAddress = 'https://example.invalid/notes/studio-authoring/';
    // 隔離測試只接住目標網址；驗證真實開窗，不連外或宣稱已部署網站。
    await page.context().route(publicAddress, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><meta charset="utf-8"><title>正式網址目標</title>',
      }),
    );
    const opened = page.waitForEvent('popup');
    await formalUrl.click();
    const target = await opened;
    try {
      await expect(target).toHaveURL(publicAddress);
      await expect(target).toHaveTitle('正式網址目標');
    } finally {
      await target.close();
      await page.context().unroute(publicAddress);
    }
    const updatedHtml = `${html}\n<p>保存後更新。</p>`;
    await body(page, updatedHtml);
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/articles/${source.id}`) &&
        response.request().method() === 'PUT',
    );
    await page.keyboard.press('ControlOrMeta+s');
    const saveResponse = await saved;
    expect(saveResponse.status()).toBe(200);
    expect(
      ArticleResourceSchema.parse(await saveResponse.json()),
    ).toMatchObject({
      id: source.id,
      contentHtml: updatedHtml,
    });
    expect(
      await readFile(
        join(environment.root, 'content/articles', source.id, 'content.html'),
        'utf8',
      ),
    ).toBe(updatedHtml);
    const withdrawn = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/articles/${source.id}`) &&
        response.request().method() === 'PUT',
    );
    await confirm(page, () =>
      page.getByRole('button', { name: '撤回為草稿', exact: true }).click(),
    );
    expect((await withdrawn).status()).toBe(200);
    await expect(page.getByText(/^狀態：草稿/)).toBeVisible();
    await expect(formalUrl).toHaveCount(0);
    expect(
      JSON.parse(
        await readFile(
          join(environment.root, 'content/articles', source.id, 'meta.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ status: 'draft' });
    await page.getByRole('button', { name: '返回清單', exact: true }).click();
    const row = page.locator('tr[data-article-id]').filter({
      has: page.getByRole('button', { name: 'Studio 完整文章', exact: true }),
    });
    await row.locator('.row-menu > summary').click();
    await confirm(page, () =>
      row.getByRole('button', { name: '刪除文章', exact: true }).click(),
    );
    await expect(row).toHaveCount(0);
    await navigate(page, '衝突與復原');
    await page
      .getByRole('button', { name: /垃圾桶 · 可還原/ })
      .first()
      .click();
    await page
      .getByLabel('復原選擇', { exact: true })
      .selectOption('restore-trash');
    await confirm(page, () =>
      page
        .getByRole('button', { name: '確認套用復原決策', exact: true })
        .click(),
    );
    await expect(
      page.getByRole('status').filter({ hasText: '復原決策已完成' }),
    ).toBeVisible();
    expect(
      await readFile(
        join(environment.root, 'content/articles', source.id, 'content.html'),
        'utf8',
      ),
    ).toBe(`${html}\n<p>保存後更新。</p>`);
  } finally {
    await environment.close();
  }
});
