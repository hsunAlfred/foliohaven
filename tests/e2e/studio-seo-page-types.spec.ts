import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { studioEnvironment } from '../fixtures/studio/environment.js';
import { chooseSettingsSection } from '../fixtures/studio/settings.js';

test.use({ viewport: { width: 1536, height: 1000 } });

test('SEO頁面類型：八個tabs保留緩衝、支援鍵盤與驗證定位，手機維持換行tabs', async ({
  page,
}, testInfo) => {
  const environment = await studioEnvironment();
  const source = join(environment.root, 'content/site.json');
  const before = await readFile(source);
  const saves: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === '/api/v1/site-settings'
    )
      saves.push(request.url());
  });
  try {
    await page.goto(`${environment.url}/#/settings`);
    const panel = await chooseSettingsSection(page, 'seo');
    const tabs = panel.getByRole('tablist', { name: '頁面類型', exact: true });
    const clear = panel.getByRole('button', {
      name: '清除此類型自訂內容',
      exact: true,
    });
    const home = tabs.getByRole('tab', { name: '首頁', exact: true });
    const article = tabs.getByRole('tab', { name: '文章頁', exact: true });
    const notFound = tabs.getByRole('tab', { name: '404', exact: true });
    await expect(tabs.getByRole('tab')).toHaveCount(8);
    await expect(panel.locator('.seo-page-type-panel')).toHaveCount(8);
    await expect(panel.locator('.seo-page-type-panel:visible')).toHaveCount(1);
    await expect(
      panel.getByRole('combobox', { name: '頁面類型', exact: true }),
    ).toHaveCount(0);
    await expect(home).toHaveAttribute('aria-selected', 'true');
    const homeTemplate = panel.locator(
      '[data-field="pageSEO.home.titleTemplate"]',
    );
    await homeTemplate.fill('首頁緩衝：{title}');
    await panel
      .locator('[data-field="pageSEO.home.descriptionSource"]')
      .selectOption('custom');
    await panel
      .locator('[data-field="pageSEO.home.description"]')
      .fill('未保存的首頁描述');
    await article.click();
    await panel
      .locator('[data-field="pageSEO.article.titleTemplateMode"]')
      .selectOption('custom');
    await panel
      .locator('[data-field="pageSEO.article.titleTemplate"]')
      .fill('文章緩衝：{title}');
    await home.click();
    await expect(homeTemplate).toHaveValue('首頁緩衝：{title}');
    await expect(
      panel.locator('[data-field="pageSEO.home.description"]'),
    ).toHaveValue('未保存的首頁描述');
    await home.focus();
    await home.press('ArrowRight');
    await expect(article).toBeFocused();
    await expect(article).toHaveAttribute('aria-selected', 'true');
    await expect(article).toHaveAttribute('tabindex', '0');
    await expect(home).toHaveAttribute('tabindex', '-1');
    await expect(
      panel.locator('[data-field="pageSEO.article.titleTemplate"]'),
    ).toHaveValue('文章緩衝：{title}');
    await article.press('End');
    await expect(notFound).toBeFocused();
    await expect(notFound).toHaveAttribute('aria-selected', 'true');
    await expect(
      panel.locator('[data-field="pageSEO.notFound.index"]'),
    ).toBeDisabled();
    await notFound.press('ArrowRight');
    await expect(home).toBeFocused();
    await home.press('ArrowLeft');
    await expect(notFound).toBeFocused();
    await notFound.press('Home');
    await expect(home).toBeFocused();
    await article.click();
    await panel
      .getByRole('button', { name: '清除此類型自訂內容', exact: true })
      .click();
    for (const key of [
      'titleTemplateMode',
      'descriptionSource',
      'index',
      'imageSource',
    ])
      await expect(
        panel.locator(`[data-field="pageSEO.article.${key}"]`),
      ).toHaveValue('inherit');
    await home.click();
    await expect(homeTemplate).toHaveValue('首頁緩衝：{title}');
    await article.click();
    await panel
      .locator('[data-field="pageSEO.article.titleTemplateMode"]')
      .selectOption('custom');
    await panel
      .locator('[data-field="pageSEO.article.titleTemplate"]')
      .fill('{unsupported}');
    await home.click();
    await page
      .getByRole('button', { name: '保存全站設定', exact: true })
      .click();
    await expect(article).toHaveAttribute('aria-selected', 'true');
    await expect(
      panel.locator('[data-field="pageSEO.article.titleTemplate"]'),
    ).toBeFocused();
    await expect(
      panel.locator('[data-field="pageSEO.article.titleTemplate"]'),
    ).toHaveAttribute('aria-invalid', 'true');
    await panel
      .getByRole('button', { name: '清除此類型自訂內容', exact: true })
      .click();
    for (const width of [1536, 1024, 640, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(tabs.getByRole('tab')).toHaveCount(8);
      await expect(panel.locator('.seo-page-type-panel:visible')).toHaveCSS(
        'border-top-width',
        '0px',
      );
      if (width > 640) {
        const tabsBox = await tabs.boundingBox();
        const clearBox = await clear.boundingBox();
        if (!tabsBox || !clearBox)
          throw new Error('Missing page-type toolbar bounds');
        expect(
          Math.abs(
            tabsBox.y + tabsBox.height / 2 - clearBox.y - clearBox.height / 2,
          ),
        ).toBeLessThanOrEqual(1);
        expect(clearBox.x).toBeGreaterThanOrEqual(tabsBox.x + tabsBox.width);
      }
      for (const tab of await tabs.getByRole('tab').all())
        await expect(tab).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (width === 375) {
        const tops = await tabs
          .getByRole('tab')
          .evaluateAll((buttons) =>
            buttons.map((button) =>
              Math.round(button.getBoundingClientRect().top),
            ),
          );
        expect(new Set(tops).size).toBeGreaterThan(1);
      }
      await panel.locator('.seo-page-type-toolbar').screenshot({
        path: testInfo.outputPath(`seo-page-type-tabs-${width}.png`),
      });
    }
    expect(saves).toEqual([]);
    expect(await readFile(source)).toEqual(before);
  } finally {
    await environment.close();
  }
});
