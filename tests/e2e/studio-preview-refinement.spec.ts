import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { studioEnvironment } from '../fixtures/studio/environment.js';

test('文章預覽：真裝置寬度、縮放、放大檢視與提早切換排版保留未保存正文', async ({
  page,
}, testInfo) => {
  const environment = await studioEnvironment();
  const source = join(environment.root, 'content/articles/one/content.html');
  const before = await readFile(source, 'utf8');
  const mutations: string[] = [];
  const workspaceReads: string[] = [];
  const styleViolations: string[] = [];
  const consoleErrors: string[] = [];
  const inspectionMessages: { operation: string; message: string }[] = [];
  const previewDocuments: Promise<string | null>[] = [];
  const previewDocumentUrls = new Set<string>();
  const blockedNavigationMessages: string[] = [];
  const screenshotStyleMessages: string[] = [];
  let takingScreenshot = false;
  let testingNavigation = false;
  let sandboxInspection: string | null = null;
  const inspectSandbox = async <T>(
    operation: string,
    inspect: () => Promise<T>,
  ): Promise<T> => {
    const previous = sandboxInspection;
    sandboxInspection = operation;
    try {
      return await inspect();
    } finally {
      sandboxInspection = previous;
    }
  };
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const scriptWarning =
      /^Blocked script execution in '([^']+)' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/u.exec(
        message.text(),
      );
    if (
      sandboxInspection !== null &&
      ['chromium', 'webkit'].includes(testInfo.project.name) &&
      scriptWarning?.[1]
    ) {
      const target = new URL(scriptWarning[1]);
      target.hash = '';
      if (
        target.origin === environment.url &&
        target.search === '' &&
        previewDocumentUrls.has(target.href)
      ) {
        // Trace confirms these exact warnings occur inside Playwright's own
        // iframe locator/inspection calls; raw HTML and DOM must have no script.
        inspectionMessages.push({
          operation: sandboxInspection,
          message: message.text(),
        });
        return;
      }
    }
    if (
      testingNavigation &&
      /Blocked opening .+sandboxed frame.+allow-popups/iu.test(message.text())
    ) {
      blockedNavigationMessages.push(message.text());
      return;
    }
    if (
      /(?:Content Security Policy|style-src|stylesheet)/iu.test(message.text())
    )
      if (
        takingScreenshot &&
        testInfo.project.name === 'webkit' &&
        message.text() ===
          "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy."
      )
        screenshotStyleMessages.push(message.text());
      else styleViolations.push(message.text());
    else consoleErrors.push(message.text());
  });
  const capture = async (name: string) => {
    expect(styleViolations).toEqual([]);
    takingScreenshot = true;
    try {
      // WebKit screenshots inject <style>body {}</style> to sync animations.
      // Keep that exact automation warning separate; retain the real CSP.
      await page.screenshot({
        path: testInfo.outputPath(name),
        fullPage: true,
        caret: 'initial',
      });
    } finally {
      takingScreenshot = false;
    }
  };
  page.on('response', (response) => {
    const request = response.request();
    if (
      request.method() === 'GET' &&
      response.status() === 200 &&
      /^\/api\/v1\/previews\/[^/]+\/document$/u.test(
        new URL(request.url()).pathname,
      )
    ) {
      previewDocumentUrls.add(response.url());
      previewDocuments.push(response.text().catch(() => null));
    }
    if (
      request.method() === 'GET' &&
      response.status() === 200 &&
      new URL(request.url()).pathname === '/api/v1/workspace'
    )
      workspaceReads.push(request.url());
  });
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      /\/api\/v1\/articles(?:\/|$)/.test(new URL(request.url()).pathname)
    )
      mutations.push(request.method());
  });
  try {
    await page.setViewportSize({ width: 1536, height: 1000 });
    await page.goto(environment.url);
    await page
      .locator('tr[data-article-id="one"] .article-title-button')
      .click();
    const editor = page.getByRole('textbox', {
      name: 'HTML 正文',
      exact: true,
    });
    const html =
      '<h2 id="device-preview">裝置預覽</h2><p>切換後仍保留這段未保存文字。</p>';
    await inspectSandbox(
      'edit while the initial preview is present',
      async () => {
        await editor.click();
        await editor.press('ControlOrMeta+A');
        await page.keyboard.insertText(html);
      },
    );
    const frame = page.frameLocator('iframe[title="文章即時預覽"]');
    await inspectSandbox('inspect the shared preview document', async () => {
      await expect(
        frame.getByRole('heading', { name: '裝置預覽', exact: true }),
      ).toBeVisible();
      await expect(frame.locator('script')).toHaveCount(0);
      await expect(frame.locator('.article-page')).toBeVisible();
      await expect(frame.locator('[class*="cl-"]')).toHaveCount(0);
      await expect(frame.locator('.site-header-inner')).toHaveCSS(
        'display',
        'flex',
      );
      await expect(frame.locator('html')).toHaveCSS('font-size', '16px');
      await expect(frame.locator('.site-footer-inner')).toHaveCSS(
        'display',
        'flex',
      );
      await expect(frame.locator('.site-brand')).toHaveText('HTTP測試網站');
      await expect(frame.locator('.site-footer')).toContainText('HTTP測試網站');
    });
    const previewUrl = await inspectSandbox(
      'follow the SSR section link',
      async () => {
        await frame.locator('[data-reading-toc-link]').click();
        await expect
          .poll(() => frame.locator('body').evaluate(() => location.hash))
          .toBe('#device-preview');
        return frame.locator('body').evaluate(() => location.href);
      },
    );
    const navigation = frame.locator('.site-brand');
    await inspectSandbox('check sandboxed cross-page navigation', async () => {
      await expect(navigation).toHaveAttribute('target', '_blank');
      await expect(navigation).toHaveAttribute(
        'title',
        '這裡僅預覽版面；請在網站預覽中開啟其他頁面。',
      );
      testingNavigation = true;
      try {
        await navigation.click();
      } finally {
        testingNavigation = false;
      }
      expect(await frame.locator('body').evaluate(() => location.href)).toBe(
        previewUrl,
      );
      await expect(
        frame.getByRole('heading', { name: '裝置預覽', exact: true }),
      ).toBeVisible();
    });
    expect(workspaceReads).toHaveLength(1);
    await expect(page.getByText('文章識別資訊', { exact: true })).toHaveCount(
      0,
    );
    for (const [name, width] of [
      ['桌機', 1200],
      ['平板', 768],
      ['手機', 390],
    ] as const) {
      await page
        .getByRole('group', { name: '預覽模擬裝置', exact: true })
        .getByRole('button', { name, exact: true })
        .click();
      await inspectSandbox(`inspect ${name} viewport`, async () => {
        await expect
          .poll(() => frame.locator('body').evaluate(() => window.innerWidth))
          .toBe(width);
        expect(
          await frame
            .locator('html')
            .evaluate((element) => element.scrollWidth <= innerWidth),
        ).toBe(true);
      });
      await expect(page.getByTitle('文章即時預覽')).toHaveAttribute(
        'sandbox',
        '',
      );
      expect(
        await page
          .locator('.preview-stage')
          .evaluate((element) =>
            Number((element as HTMLElement).dataset.scale),
          ),
      ).toBeLessThanOrEqual(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    // Before the mobile tabs, settings occupy their own full-width row.
    for (const width of [1920, 1600, 1536, 1535, 1440, 1281]) {
      await page.setViewportSize({ width, height: 1000 });
      const workspace = await page.locator('.editor-workspace').boundingBox();
      const settings = await page.locator('.editor-settings').boundingBox();
      const code = await page.locator('.editor-code').boundingBox();
      const preview = await page.locator('.editor-preview').boundingBox();
      expect(workspace).not.toBeNull();
      expect(settings).not.toBeNull();
      expect(code).not.toBeNull();
      expect(preview).not.toBeNull();
      if (!workspace || !settings || !code || !preview)
        throw new Error(`編輯區在 ${width}px 應完整顯示`);
      expect(settings.y).toBeGreaterThanOrEqual(workspace.y + workspace.height);
      expect(Math.abs(settings.x - workspace.x)).toBeLessThan(1);
      expect(Math.abs(settings.width - workspace.width)).toBeLessThan(1);
      expect(Math.abs(code.y - preview.y)).toBeLessThan(1);
      expect(preview.x).toBeGreaterThan(code.x);
      await expect(
        page.getByRole('tablist', { name: '編輯工作區', exact: true }),
      ).toBeHidden();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const tabs = page.getByRole('tablist', { name: '編輯工作區', exact: true });
    await expect(tabs).toBeVisible();
    await tabs.getByRole('tab', { name: '預覽', exact: true }).click();
    await page
      .getByRole('group', { name: '預覽模擬裝置', exact: true })
      .getByRole('button', { name: '桌機', exact: true })
      .click();
    await page.getByLabel('預覽縮放', { exact: true }).selectOption('100');
    await inspectSandbox('inspect the unscaled desktop viewport', async () => {
      await expect
        .poll(() => frame.locator('body').evaluate(() => innerWidth))
        .toBe(1200);
    });
    expect(
      await page
        .locator('.preview-stage')
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByLabel('預覽縮放', { exact: true }).selectOption('fit');
    const dialog = page.getByRole('dialog', { name: '放大預覽', exact: true });
    await inspectSandbox('inspect the expanded mobile preview', async () => {
      await page.getByRole('button', { name: '放大預覽', exact: true }).click();
      await dialog.getByRole('button', { name: '手機', exact: true }).click();
      await expect
        .poll(() =>
          page
            .frameLocator('iframe[title="放大文章預覽"]')
            .locator('body')
            .evaluate(() => innerWidth),
        )
        .toBe(390);
    });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await tabs.getByRole('tab', { name: '正文', exact: true }).click();
    await expect(editor).toContainText('切換後仍保留這段未保存文字。');
    expect(
      await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize),
      ),
    ).toBeGreaterThanOrEqual(16);
    expect(
      await page.evaluate(() => getComputedStyle(document.body).fontFamily),
    ).toContain('Noto Sans TC');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await capture('mobile-editor.png');
    await tabs.getByRole('tab', { name: '預覽', exact: true }).click();
    await inspectSandbox('inspect the mobile preview tab', async () => {
      await expect
        .poll(() => frame.locator('body').evaluate(() => innerWidth))
        .toBe(390);
    });
    await capture('mobile-preview.png');
    expect(mutations).toEqual([]);
    expect(styleViolations).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(previewDocuments.length).toBeGreaterThan(0);
    for (const document of await Promise.all(previewDocuments)) {
      expect(document).not.toBeNull();
      expect(document).not.toMatch(/<script(?:\s|>)/iu);
    }
    if (inspectionMessages.length)
      await testInfo.attach('playwright-sandbox-inspection-messages', {
        body: JSON.stringify(inspectionMessages),
        contentType: 'application/json',
      });
    if (blockedNavigationMessages.length)
      await testInfo.attach('sandbox-blocked-preview-navigation', {
        body: JSON.stringify(blockedNavigationMessages),
        contentType: 'application/json',
      });
    if (screenshotStyleMessages.length)
      await testInfo.attach('webkit-screenshot-csp-messages', {
        body: JSON.stringify(screenshotStyleMessages),
        contentType: 'application/json',
      });
    expect(await readFile(source, 'utf8')).toBe(before);
  } finally {
    await environment.close();
  }
});
