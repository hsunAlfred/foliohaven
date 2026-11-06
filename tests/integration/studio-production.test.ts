import { expect, it } from 'vitest';
import { chromium, expect as browserExpect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createServer } from 'vite';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ArticleResourceSchema,
  ArticleMetaSchema,
  JobSchema,
  SearchIndexSchema,
} from '@foliohaven/core';
import type { Job } from '@foliohaven/core';
import { createLocalService } from '../../server/src/http/index.js';
import type { LocalService } from '../../server/src/http/index.js';
import { createStudioViteConfig } from '../../studio/vite.config.js';
import { samplesWorkspace } from '../fixtures/samples/workspace.js';

async function editHtml(page: Page, value: string) {
  const editor = page.getByRole('textbox', { name: 'HTML 正文', exact: true });
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(value);
}
async function confirm(page: Page, action: () => Promise<unknown>) {
  const accepted = page
    .waitForEvent('dialog')
    .then((dialog) => dialog.accept());
  await action();
  await accepted;
}
async function navigateStudio(page: Page, label: string) {
  if (await page.locator('dialog[open]').count())
    await page.locator('dialog[open] .dialog-close').last().click();
  await page.getByRole('button', { name: label, exact: true }).click();
}
async function buildFromStudio(page: Page, origin: string): Promise<Job> {
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/v1/build-jobs'),
  );
  await page.getByRole('button', { name: '更新網站', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const queued = JobSchema.parse(await response.json());
  const deadline = Date.now() + 240_000;
  let result = queued;
  while (result.status === 'queued' || result.status === 'running') {
    if (Date.now() > deadline)
      throw new Error('正式 Studio Build 工作超過驗收期限。');
    const current = await page.request.get(
      `${origin}/api/v1/jobs/${queued.id}`,
    );
    expect(current.status()).toBe(200);
    result = JobSchema.parse(await current.json());
    if (result.status === 'queued' || result.status === 'running')
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  expect(result.status, result.error?.code ?? '正式 Build 應成功').toBe(
    'succeeded',
  );
  expect(result.type).toBe('build');
  await browserExpect(
    page.getByRole('definition').filter({ hasText: '網站更新 · 成功' }),
  ).toBeVisible({ timeout: 10_000 });
  return result;
}
async function sitemap(root: string) {
  const names = (await readdir(join(root, 'dist'))).filter((name) =>
    /^sitemap-\d+\.xml$/u.test(name),
  );
  return (
    await Promise.all(
      names.map((name) => readFile(join(root, 'dist', name), 'utf8')),
    )
  ).join('\n');
}

it('STUDIO-PRODUCTION-01: actual Studio authoring publishes the sixth sample through default Astro Build and withdraws every public projection', async () => {
  const fixture = await samplesWorkspace();
  let service: LocalService | undefined;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Browser | undefined;
  try {
    // 沒有 buildExecution、假 worker 或 render fixture；採產品預設 snapshot／Astro／promotion。
    // token 只經 Node closure 傳入代理，不能存進 client、fixture檔或報告。
    const token = randomBytes(32).toString('hex');
    service = await createLocalService({
      repositoryRoot: fixture.root,
      proxyToken: token,
    });
    const address = await service.listen({ port: 0 });
    const config = createStudioViteConfig({
      proxyToken: token,
      apiOrigin: address.url,
    });
    const cacheDir = join(
      fixture.root,
      'studio/node_modules/.vite-cache-studio',
    );
    vite = await createServer({
      ...config,
      configFile: false,
      logLevel: 'silent',
      cacheDir,
      server: {
        ...config.server,
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        fs: {
          ...config.server?.fs,
          allow: [...(config.server?.fs?.allow ?? []), cacheDir],
        },
      },
    });
    await vite.listen();
    const socket = vite.httpServer?.address();
    if (!socket || typeof socket === 'string')
      throw new Error('Studio正式驗收未取得測試連接埠。');
    const origin = `http://127.0.0.1:${socket.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1536, height: 1000 },
    });
    page.setDefaultTimeout(15_000);
    const browserFailures: {
      kind: string;
      path?: string;
      message?: string;
      status?: number;
    }[] = [];
    const cacheResponses: { url: string; status: number }[] = [];
    page.on('pageerror', (error) =>
      browserFailures.push({ kind: 'pageerror', message: error.message }),
    );
    page.on('requestfailed', (request) =>
      browserFailures.push({
        kind: 'requestfailed',
        path: new URL(request.url()).pathname,
        message: request.failure()?.errorText ?? 'unknown',
      }),
    );
    page.on('response', (response) => {
      const path = decodeURIComponent(new URL(response.url()).pathname);
      if (path.includes(cacheDir))
        cacheResponses.push({ url: response.url(), status: response.status() });
      if ([403, 404, 500, 504].includes(response.status()))
        browserFailures.push({ kind: 'http', path, status: response.status() });
    });
    await page.goto(origin);
    try {
      await browserExpect(
        page.getByRole('heading', { name: '文章工作室', exact: true }),
      ).toBeVisible({ timeout: 15000 });
    } catch {
      throw new Error(
        'Studio bootstrap失敗；瀏覽器實際診斷：' +
          JSON.stringify(browserFailures),
      );
    }
    expect(
      cacheResponses.length,
      '真正optimized依賴必須經獨立cache載入',
    ).toBeGreaterThan(0);
    expect(cacheResponses.every((response) => response.status === 200)).toBe(
      true,
    );
    // 以實際瀏覽器取得的模組URL再確認白名單存取，不能僅以UI恰好呈現判定cache可用。
    for (const response of cacheResponses)
      expect((await page.request.get(response.url)).status()).toBe(200);
    // Studio/API 單獨入口沒有網站 Dev 的 live 媒體暖機；作者先以真正媒體工作處理既有來源。
    for (const displayName of ['本機合成幾何圖片', '本機合成兩秒測試影片']) {
      if (await page.locator('dialog[open]').count())
        await page.locator('dialog[open] .dialog-close').last().click();
      await navigateStudio(page, '媒體庫');
      await page
        .getByRole('button', { name: displayName, exact: true })
        .click();
      await page.getByRole('button', { name: '處理媒體', exact: true }).click();
      await browserExpect(
        page
          .getByRole('region', { name: '媒體處理進度', exact: true })
          .getByText('處理完成', { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
    }
    if (await page.locator('dialog[open]').count())
      await page.locator('dialog[open] .dialog-close').last().click();
    await navigateStudio(page, '文章');
    await page.getByRole('button', { name: '新增文章', exact: true }).click();
    await page
      .getByLabel('文章標題', { exact: true })
      .fill('Studio正式管線文章');
    await page
      .getByLabel('文章網址名稱', { exact: true })
      .fill('studio-pipeline-proof');
    await page.getByLabel('分類', { exact: true }).selectOption('notes');
    await page.getByRole('button', { name: '選擇 Tag', exact: true }).click();
    const tagPicker = page.getByRole('dialog', {
      name: '選擇 Tag',
      exact: true,
    });
    await tagPicker
      .getByRole('searchbox', { name: '搜尋 Tag', exact: true })
      .fill('EXAMPLE');
    await tagPicker
      .getByRole('checkbox', { name: '範例 example', exact: true })
      .check();
    await tagPicker
      .getByRole('button', { name: '套用選擇', exact: true })
      .click();
    await browserExpect(tagPicker).not.toBeVisible();
    const selectedTags = page.getByRole('list', {
      name: '文章已選 Tag',
      exact: true,
    });
    await browserExpect(
      selectedTags.getByText('範例', { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel('Meta Description', { exact: true })
      .fill('由真實Studio發布並經預設Astro建置的第六篇文章。');
    const content =
      '<h2 id="studio-proof">Studio正式輸出</h2>\n<p>文章從編輯器走到正式靜態輸出。</p>';
    await editHtml(page, content);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/v1/articles'),
    );
    await page.getByRole('button', { name: '建立草稿', exact: true }).click();
    const sourceResponse = await created;
    expect(sourceResponse.status()).toBe(201);
    const source = ArticleResourceSchema.parse(await sourceResponse.json());
    expect(source.meta.tags).toEqual(['example']);
    expect(
      ArticleMetaSchema.parse(
        JSON.parse(
          await readFile(
            join(fixture.root, 'content/articles', source.id, 'meta.json'),
            'utf8',
          ),
        ),
      ).tags,
    ).toEqual(['example']);
    await browserExpect(
      page.getByRole('heading', { name: '編輯文章：Studio正式管線文章' }),
    ).toBeVisible();
    await browserExpect(
      page
        .frameLocator('iframe')
        .getByRole('heading', { name: 'Studio正式輸出', exact: true }),
    ).toBeVisible();
    expect(
      await readFile(
        join(fixture.root, 'content/articles', source.id, 'content.html'),
        'utf8',
      ),
    ).toBe(content);
    await page.locator('.editor-dates > summary').click();
    await page
      .getByRole('button', { name: '填入目前時間', exact: true })
      .click();
    const publishing = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/api/v1/articles/${source.id}`),
    );
    await confirm(page, () =>
      page.getByRole('button', { name: '發布目前內容', exact: true }).click(),
    );
    const published = await publishing;
    const publishedBody = (await published.json()) as {
      error?: { code: string; issues: unknown };
    };
    expect(
      published.status(),
      JSON.stringify(publishedBody.error ?? null),
    ).toBe(200);
    await browserExpect(page.getByText(/^狀態：已發布/)).toBeVisible();
    await navigateStudio(page, '網站更新與工作');
    const first = await buildFromStudio(page, origin);
    expect(first.type === 'build' && first.result?.outputDirectory).toBe(
      'dist',
    );
    const document = await readFile(
      join(fixture.root, 'dist/notes/studio-pipeline-proof/index.html'),
      'utf8',
    );
    expect(document).toContain('Studio正式管線文章');
    expect(document).toContain('Studio正式輸出');
    expect(document).toContain(
      'https://example.invalid/notes/studio-pipeline-proof/',
    );
    expect(document).not.toContain('<astro-island');
    const search = SearchIndexSchema.parse(
      JSON.parse(
        await readFile(join(fixture.root, 'dist/search-index.json'), 'utf8'),
      ),
    );
    expect(search.articles).toHaveLength(6);
    expect(search.articles.some((article) => article.id === source.id)).toBe(
      true,
    );
    const rss = await readFile(join(fixture.root, 'dist/rss.xml'), 'utf8');
    expect(rss.match(/<item>/gu)).toHaveLength(6);
    expect(rss).toContain(`article:${source.id}`);
    expect(await sitemap(fixture.root)).toContain(
      '/notes/studio-pipeline-proof/',
    );
    expect(
      await readFile(
        join(fixture.root, 'dist/category/notes/index.html'),
        'utf8',
      ),
    ).toContain('/notes/studio-pipeline-proof/');
    if (await page.locator('dialog[open]').count())
      await page.locator('dialog[open] .dialog-close').last().click();
    await navigateStudio(page, '文章');
    await page
      .getByRole('button', { name: 'Studio正式管線文章', exact: true })
      .click();
    await browserExpect(
      selectedTags.getByText('範例', { exact: true }),
    ).toBeVisible();
    const withdrawn = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/api/v1/articles/${source.id}`),
    );
    const privateContent =
      '<h2 id="private">STUDIO_WITHDRAWN_PRIVATE_SENTINEL</h2>';
    await editHtml(page, privateContent);
    await confirm(page, () =>
      page.getByRole('button', { name: '撤回為草稿', exact: true }).click(),
    );
    expect((await withdrawn).status()).toBe(200);
    await browserExpect(page.getByText(/^狀態：草稿/)).toBeVisible();
    expect(
      await readFile(
        join(fixture.root, 'content/articles', source.id, 'content.html'),
        'utf8',
      ),
    ).toBe(privateContent);
    await navigateStudio(page, '網站更新與工作');
    await buildFromStudio(page, origin);
    await expect(
      readFile(
        join(fixture.root, 'dist/notes/studio-pipeline-proof/index.html'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const finalSearch = SearchIndexSchema.parse(
      JSON.parse(
        await readFile(join(fixture.root, 'dist/search-index.json'), 'utf8'),
      ),
    );
    expect(finalSearch.articles).toHaveLength(5);
    expect(
      finalSearch.articles.some((article) => article.id === source.id),
    ).toBe(false);
    const finalRss = await readFile(join(fixture.root, 'dist/rss.xml'), 'utf8');
    expect(finalRss.match(/<item>/gu)).toHaveLength(5);
    expect(finalRss).not.toContain(`article:${source.id}`);
    expect(finalRss).not.toContain('STUDIO_WITHDRAWN_PRIVATE_SENTINEL');
    expect(await sitemap(fixture.root)).not.toContain(
      '/notes/studio-pipeline-proof/',
    );
    for (const path of [
      'dist/index.html',
      'dist/category/notes/index.html',
      'dist/search-index.json',
    ]) {
      const output = await readFile(join(fixture.root, path), 'utf8');
      expect(output).not.toContain('/notes/studio-pipeline-proof/');
      expect(output).not.toContain('STUDIO_WITHDRAWN_PRIVATE_SENTINEL');
    }
  } finally {
    await browser?.close();
    await vite?.close();
    await service?.close();
    await fixture.cleanup();
  }
}, 480_000);

async function rssArticles(page: Page, root: string) {
  const xml = await readFile(join(root, 'dist/rss.xml'), 'utf8');
  const parsed = await page.evaluate((source) => {
    const document = new DOMParser().parseFromString(source, 'application/xml');
    return {
      valid: document.getElementsByTagName('parsererror').length === 0,
      items: Array.from(document.getElementsByTagName('item'), (item) => {
        const guid = item.getElementsByTagName('guid')[0];
        return {
          guid: guid?.textContent ?? '',
          isPermaLink: guid?.getAttribute('isPermaLink') ?? '',
          link: item.getElementsByTagName('link')[0]?.textContent ?? '',
        };
      }),
    };
  }, xml);
  expect(parsed.valid, '正式 RSS 必須是合法 XML').toBe(true);
  for (const item of parsed.items) {
    expect(item.guid).toMatch(/^article:[a-z\d-]+$/u);
    expect(item.isPermaLink).toBe('false');
  }
  expect(new Set(parsed.items.map((item) => item.guid)).size).toBe(
    parsed.items.length,
  );
  return new Map(
    parsed.items.map((item) => [item.guid.slice('article:'.length), item]),
  );
}

it('STUDIO-PRODUCTION-02: category migration remains editable, repairs existing cross-article links through Studio, and preserves RSS GUIDs while regenerating URLs', async () => {
  const fixture = await samplesWorkspace();
  let service: LocalService | undefined;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Browser | undefined;
  try {
    const ids = await readdir(join(fixture.root, 'content/articles'));
    const sources = await Promise.all(
      ids.map(async (id) => {
        const directory = join(fixture.root, 'content/articles', id);
        const meta = ArticleMetaSchema.parse(
          JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')),
        );
        if (meta.status !== 'published')
          throw new Error('正式遷移驗收需要五篇已發布樣本。');
        return {
          id,
          meta,
          contentHtml: await readFile(join(directory, 'content.html'), 'utf8'),
        };
      }),
    );
    expect(sources).toHaveLength(5);
    const repairs = sources.filter((source) =>
      /\/(?:category\/)?notes\//u.test(source.contentHtml),
    );
    expect(
      repairs.length,
      '必須存在多篇真正舊 URL 錯誤，才能驗證逐篇修復',
    ).toBeGreaterThanOrEqual(2);
    const token = randomBytes(32).toString('hex');
    service = await createLocalService({
      repositoryRoot: fixture.root,
      proxyToken: token,
    });
    const address = await service.listen({ port: 0 });
    const config = createStudioViteConfig({
      proxyToken: token,
      apiOrigin: address.url,
    });
    const cacheDir = join(
      fixture.root,
      'studio/node_modules/.vite-cache-studio-migration',
    );
    vite = await createServer({
      ...config,
      configFile: false,
      logLevel: 'silent',
      cacheDir,
      server: {
        ...config.server,
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        fs: {
          ...config.server?.fs,
          allow: [...(config.server?.fs?.allow ?? []), cacheDir],
        },
      },
    });
    await vite.listen();
    const socket = vite.httpServer?.address();
    if (!socket || typeof socket === 'string')
      throw new Error('Studio遷移驗收未取得測試連接埠。');
    const origin = `http://127.0.0.1:${socket.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1536, height: 1000 },
    });
    page.setDefaultTimeout(15_000);
    const browserFailures: {
      kind: string;
      path?: string;
      message?: string;
      status?: number;
    }[] = [];
    const cacheResponses: { url: string; status: number }[] = [];
    page.on('pageerror', (error) =>
      browserFailures.push({ kind: 'pageerror', message: error.message }),
    );
    page.on('requestfailed', (request) =>
      browserFailures.push({
        kind: 'requestfailed',
        path: new URL(request.url()).pathname,
        message: request.failure()?.errorText ?? 'unknown',
      }),
    );
    page.on('response', (response) => {
      const path = decodeURIComponent(new URL(response.url()).pathname);
      if (path.includes(cacheDir))
        cacheResponses.push({ url: response.url(), status: response.status() });
      if ([403, 404, 500, 504].includes(response.status()))
        browserFailures.push({ kind: 'http', path, status: response.status() });
    });
    await page.goto(origin);
    try {
      await browserExpect(
        page.getByRole('heading', { name: '文章工作室', exact: true }),
      ).toBeVisible({ timeout: 15_000 });
    } catch {
      throw new Error(
        'Studio遷移bootstrap失敗；瀏覽器實際診斷：' +
          JSON.stringify(browserFailures),
      );
    }
    expect(cacheResponses.length).toBeGreaterThan(0);
    for (const response of cacheResponses) {
      expect(response.status).toBe(200);
      expect((await page.request.get(response.url)).status()).toBe(200);
    }
    for (const displayName of ['本機合成幾何圖片', '本機合成兩秒測試影片']) {
      if (await page.locator('dialog[open]').count())
        await page.locator('dialog[open] .dialog-close').last().click();
      await navigateStudio(page, '媒體庫');
      await page
        .getByRole('button', { name: displayName, exact: true })
        .click();
      await page.getByRole('button', { name: '處理媒體', exact: true }).click();
      await browserExpect(
        page
          .getByRole('region', { name: '媒體處理進度', exact: true })
          .getByText('處理完成', { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
    }
    await navigateStudio(page, '網站更新與工作');
    await buildFromStudio(page, origin);
    const beforeRss = await rssArticles(page, fixture.root);
    expect(beforeRss.size).toBe(5);
    for (const source of sources) {
      expect(beforeRss.get(source.id)).toMatchObject({
        guid: `article:${source.id}`,
        link: `https://example.invalid/${source.meta.category}/${source.meta.slug}/`,
      });
    }
    await navigateStudio(page, '分類與 Tag');
    await page.getByText('修改分類或 Tag 網址', { exact: true }).click();
    await page
      .getByLabel('要變更的項目', { exact: true })
      .selectOption('notes');
    await page.getByLabel('新的網址名稱', { exact: true }).fill('guides');
    await page
      .getByRole('button', { name: '查看變更影響', exact: true })
      .click();
    await browserExpect(
      page.getByRole('heading', { name: '確認網址變更', exact: true }),
    ).toBeVisible();
    const migrationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/v1/taxonomy-migrations'),
    );
    await confirm(page, () =>
      page.getByRole('button', { name: '確認變更網址', exact: true }).click(),
    );
    const accepted = await migrationResponse;
    expect(accepted.status()).toBe(202);
    const migration = JobSchema.parse(await accepted.json());
    expect(migration.type).toBe('taxonomy');
    await browserExpect(
      page
        .getByRole('definition')
        .filter({ hasText: '分類／Tag 網址調整 · 成功' }),
    ).toBeVisible({ timeout: 60_000 });
    // 遷移不會偷偷重寫文章正文；多篇舊URL必須能經作者逐篇修正。
    for (const source of repairs)
      expect(
        await readFile(
          join(fixture.root, 'content/articles', source.id, 'content.html'),
          'utf8',
        ),
      ).toBe(source.contentHtml);
    const readArticles = async () => {
      const result = await page.request.get(
        `${origin}/api/v1/articles?pageSize=100`,
      );
      expect(result.status(), '管理清單應在正文舊連結尚未修好時仍可使用').toBe(
        200,
      );
      const body = (await result.json()) as { items: unknown };
      return ArticleResourceSchema.array().parse(body.items);
    };
    const pending = await readArticles();
    expect(pending).toHaveLength(5);
    expect(
      pending.some((article) =>
        article.diagnostics.some((item) => item.severity === 'error'),
      ),
    ).toBe(true);
    for (const [index, source] of repairs.entries()) {
      if (await page.locator('dialog[open]').count())
        await page.locator('dialog[open] .dialog-close').last().click();
      await navigateStudio(page, '文章');
      await page
        .getByRole('button', { name: source.meta.title, exact: true })
        .click();
      await browserExpect(
        page.getByRole('heading', {
          name: `編輯文章：${source.meta.title}`,
          exact: true,
        }),
      ).toBeVisible();
      await browserExpect(page.getByLabel('分類', { exact: true })).toHaveValue(
        source.meta.category === 'notes' ? 'guides' : source.meta.category,
      );
      const next = source.contentHtml
        .replaceAll('/category/notes/', '/category/guides/')
        .replaceAll('/notes/', '/guides/');
      expect(next).not.toBe(source.contentHtml);
      await editHtml(page, next);
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          response.url().endsWith(`/api/v1/articles/${source.id}`),
      );
      await page
        .getByRole('button', { name: '保存目前內容', exact: true })
        .click();
      const response = await saved;
      const result = (await response.json()) as { error?: unknown };
      expect(response.status(), JSON.stringify(result.error ?? null)).toBe(200);
      await browserExpect(
        page.getByRole('status').filter({
          hasText: '文章已保存。更新網站後，讀者才會看到這次變更。',
        }),
      ).toBeVisible();
      expect(
        await readFile(
          join(fixture.root, 'content/articles', source.id, 'content.html'),
          'utf8',
        ),
      ).toBe(next);
      const current = await readArticles();
      const remaining = new Set(
        repairs.slice(index + 1).map((article) => article.id),
      );
      if (remaining.size > 0)
        expect(
          current.some(
            (article) =>
              remaining.has(article.id) &&
              article.diagnostics.some((item) => item.severity === 'error'),
          ),
          '目前文章已可保存，其他文章的真實舊連結錯誤必須仍呈現',
        ).toBe(true);
      else
        expect(
          current.every((article) =>
            article.diagnostics.every((item) => item.severity !== 'error'),
          ),
        ).toBe(true);
    }
    await navigateStudio(page, '網站更新與工作');
    await buildFromStudio(page, origin);
    const afterRss = await rssArticles(page, fixture.root);
    expect([...afterRss.keys()].sort()).toEqual([...beforeRss.keys()].sort());
    const search = SearchIndexSchema.parse(
      JSON.parse(
        await readFile(join(fixture.root, 'dist/search-index.json'), 'utf8'),
      ),
    );
    expect(search.articles).toHaveLength(5);
    const locations = await sitemap(fixture.root);
    const htmlFiles = (
      await readdir(join(fixture.root, 'dist'), { recursive: true })
    ).filter((path) => path.endsWith('.html'));
    expect(htmlFiles.some((path) => /^category\/guides\//u.test(path))).toBe(
      true,
    );
    expect(htmlFiles.some((path) => /^category\/notes\//u.test(path))).toBe(
      false,
    );
    const publicDocuments = new Map(
      await Promise.all(
        htmlFiles.map(
          async (path) =>
            [
              path,
              await readFile(join(fixture.root, 'dist', path), 'utf8'),
            ] as const,
        ),
      ),
    );
    for (const source of sources) {
      const category =
        source.meta.category === 'notes' ? 'guides' : source.meta.category;
      const path = `/${category}/${source.meta.slug}/`;
      const link = `https://example.invalid${path}`;
      expect(afterRss.get(source.id)).toMatchObject({
        guid: beforeRss.get(source.id)?.guid,
        link,
        isPermaLink: 'false',
      });
      expect(
        search.articles.find((article) => article.id === source.id),
      ).toMatchObject({ url: path, category: { path: category } });
      expect(
        publicDocuments.get(`${category}/${source.meta.slug}/index.html`),
      ).toContain(link);
      if (source.meta.category === 'notes') {
        expect(afterRss.get(source.id)?.link).not.toBe(
          beforeRss.get(source.id)?.link,
        );
        expect(htmlFiles).not.toContain(`notes/${source.meta.slug}/index.html`);
      }
      if (source.meta.seo.index === false)
        expect(locations).not.toContain(link);
      else expect(locations).toContain(link);
    }
    for (const [path, document] of publicDocuments) {
      expect(document, path).not.toContain('/category/notes/');
      expect(document, path).not.toContain('/notes/');
    }
    const tagDocuments = [...publicDocuments.entries()].filter(([path]) =>
      path.startsWith('tag/'),
    );
    expect(tagDocuments.length).toBeGreaterThan(0);
    expect(
      tagDocuments.some(([, document]) =>
        document.includes('/guides/article-basics/'),
      ),
    ).toBe(true);
    expect(locations).not.toContain('/notes/');
    expect(locations).not.toContain('/category/notes/');
  } finally {
    await browser?.close();
    await vite?.close();
    await service?.close();
    await fixture.cleanup();
  }
}, 480_000);
