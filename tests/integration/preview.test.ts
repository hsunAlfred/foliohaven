import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { PreviewResponseSchema } from '@foliohaven/core';
import {
  article,
  call,
  sandbox,
  start,
  token,
} from '../fixtures/http/environment.mjs';
import type { RunningService } from '../fixtures/http/environment.mjs';

let root = '';
let running: RunningService;
let now: Date;
beforeEach(async () => {
  root = await sandbox();
  now = new Date();
  running = await start(root, { clock: () => now });
});
afterEach(async () => {
  await running?.service.close();
  if (root) await rm(root, { recursive: true, force: true });
});
const preview = (editorId: string = randomUUID(), input = article()) =>
  call(running, '/api/v1/previews', {
    method: 'POST',
    body: input,
    headers: { 'x-alfred-editor-id': editorId },
  });
describe('API-02：React共用預覽、隔離與記憶體期限', () => {
  it('preview必須附editor UUID，DTO不接受id/diagnostics，錯誤不產生假文件', async () => {
    expect(
      (
        await call(running, '/api/v1/previews', {
          method: 'POST',
          body: article(),
        })
      ).status,
    ).toBe(422);
    expect((await preview('../outside')).status).toBe(422);
    expect(
      (
        await call(running, '/api/v1/previews', {
          method: 'POST',
          body: { ...article(), diagnostics: [] },
          headers: { 'x-alfred-editor-id': randomUUID() },
        })
      ).status,
    ).toBe(422);
  });
  it('未保存草稿以正式共用文章版型/TOC/CSS輸出，顯示診斷且保存raw bytes完全不變', async () => {
    const before = await readFile(
      join(root, 'content/articles/one/content.html'),
    );
    const result = await preview();
    expect(result.status).toBe(201);
    const value = PreviewResponseSchema.parse(result.body);
    expect(value.diagnostics.length).toBeGreaterThan(0);
    const document = await call(running, value.documentUrl);
    expect(document.status).toBe(200);
    expect(document.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(document.bytes.toString()).toContain(
      'class="page-container article-page"',
    );
    expect(document.bytes.toString()).toContain('href="#intro"');
    expect(document.bytes.toString()).toContain('HTTP合成文章。');
    expect(document.bytes.toString()).toContain('class="site-header-inner"');
    expect(document.bytes.toString()).toContain('class="site-footer-inner"');
    expect(document.bytes.toString()).toContain('target="_blank"');
    expect(document.bytes.toString()).toContain('target="_self"');
    expect(document.bytes.toString()).toContain(
      '這裡僅預覽版面；請在網站預覽中開啟其他頁面。',
    );
    expect(document.headers['content-security-policy']).toContain(
      "script-src 'none'",
    );
    expect(document.headers['content-security-policy']).toContain(
      "style-src-attr 'none'",
    );
    expect(document.headers['content-security-policy']).not.toContain(
      'unsafe-hashes',
    );
    expect(document.bytes.toString()).not.toMatch(/class="cl-/u);
    expect(document.headers['content-security-policy']).toMatch(
      /(?:^|; )sandbox(?:;|$)/u,
    );
    expect(document.bytes.toString()).not.toContain('hydrateRoot');
    const css = await call(running, '/api/v1/preview-assets/styles.css');
    expect(css.status).toBe(200);
    expect(css.bytes.toString()).toContain('.article-grid');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(
      (await call(running, value.documentUrl, { authorized: false })).status,
    ).toBe(403);
    expect(
      (
        await call(running, '/api/v1/preview-assets/styles.css', {
          authorized: false,
        })
      ).status,
    ).toBe(403);
    expect(
      await readFile(join(root, 'content/articles/one/content.html')),
    ).toEqual(before);
  });
  it('同editor新預覽取代舊URL、不同editor獨立；到期與重啟皆404', async () => {
    const editor = randomUUID();
    const first = PreviewResponseSchema.parse((await preview(editor)).body);
    const other = PreviewResponseSchema.parse((await preview()).body);
    const latest = PreviewResponseSchema.parse(
      (
        await preview(editor, {
          ...article(),
          contentHtml: '<h2 id="latest">新內容</h2>',
        })
      ).body,
    );
    expect((await call(running, first.documentUrl)).status).toBe(404);
    expect((await call(running, other.documentUrl)).status).toBe(200);
    expect(
      (await call(running, latest.documentUrl)).bytes.toString(),
    ).toContain('新內容');
    now = new Date(now.getTime() + 600_001);
    expect((await call(running, latest.documentUrl)).status).toBe(404);
    const fresh = PreviewResponseSchema.parse((await preview()).body);
    await running.service.close();
    running = await start(root, { clock: () => now });
    expect((await call(running, fresh.documentUrl)).status).toBe(404);
  });
  it('並行預覽也遵守50份上限，既有editor仍可替換且無超額可用文件', async () => {
    const editor = randomUUID();
    const first = PreviewResponseSchema.parse((await preview(editor)).body);
    const replies = await Promise.all(
      Array.from({ length: 52 }, () => preview()),
    );
    expect(replies.filter((result) => result.status === 201)).toHaveLength(49);
    expect(replies.filter((result) => result.status === 429)).toHaveLength(3);
    const replaced = await preview(editor);
    expect(replaced.status).toBe(201);
    expect((await call(running, first.documentUrl)).status).toBe(404);
  });
  it('真正Chromium iframe sandbox及CSP阻止script與事件，內容與共用CSS仍可閱讀', async () => {
    const result = await call(running, '/api/v1/previews', {
      method: 'POST',
      body: {
        ...article(),
        contentHtml:
          '<h2 id="safe">可閱讀</h2><script>window.__previewExecuted=true;parent.__previewEscaped=true;</script><img src="missing" onerror="window.__previewExecuted=true">',
      },
      headers: {
        'x-alfred-editor-id': randomUUID(),
        origin: running.url,
        'x-alfred-studio-origin': running.url,
      },
    });
    expect(result.status).toBe(201);
    const value = PreviewResponseSchema.parse(result.body);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      // 僅合成fixture token由測試攔截器附加；產品瀏覽器從不接收process token。
      await page.route('**/api/v1/**', (route) =>
        route.continue({
          headers: {
            ...route.request().headers(),
            'x-alfred-process-token': token,
          },
        }),
      );
      await page.setContent(
        `<iframe sandbox src="${running.url}${value.documentUrl}"></iframe>`,
      );
      const frame = page.frameLocator('iframe');
      await frame.locator('h2#safe').waitFor();
      expect(await frame.locator('h2#safe').textContent()).toBe('可閱讀');
      expect(
        await page.evaluate(() => Reflect.get(window, '__previewEscaped')),
      ).toBeUndefined();
      const child = page
        .frames()
        .find((frame) => frame.url().includes(value.id));
      if (!child) throw new Error('preview frame missing');
      expect(
        await child.evaluate(() => Reflect.get(window, '__previewExecuted')),
      ).toBeUndefined();
      expect(
        await frame
          .locator('.article-grid')
          .evaluate((node) => getComputedStyle(node).display),
      ).toBe('grid');
    } finally {
      await browser.close();
    }
  });
});
