import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TableOfContents } from '@foliohaven/ui';
import { expect, test, type Page } from '@playwright/test';
import { transformWithEsbuild } from 'vite';

const origin = 'http://foliohaven-reading.test';
let css: string;
let controller: string;
let document: string;
const entries = Array.from({ length: 42 }, (_, index) => ({
  id: `chapter-${index}`,
  text: `章節 ${index}：可共用的閱讀工具與靜態內容`,
  level: index % 3 === 0 ? (3 as const) : (2 as const),
}));

test.beforeAll(async () => {
  css = await readFile(
    fileURLToPath(import.meta.resolve('@foliohaven/ui/styles.css')),
    'utf8',
  );
  const path = fileURLToPath(
    new URL('../../site/src/scripts/reading-controller.ts', import.meta.url),
  );
  controller = (
    await transformWithEsbuild(await readFile(path, 'utf8'), path, {
      loader: 'ts',
      target: 'es2022',
    })
  ).code;
  const toc = renderToStaticMarkup(createElement(TableOfContents, { entries }));
  const chapters = entries
    .map(
      (entry) =>
        `<section class="fixture-section"><h2 id="${entry.id}">${entry.text}</h2><p>在伺服器預先產生完整正文與目錄。</p>${entry.id === 'chapter-0' ? '<pre><code>' + Array.from({ length: 80 }, () => 'const originalText = "' + 'long-code-'.repeat(30) + '";').join('\n') + '</code></pre>' : ''}</section>`,
    )
    .join('');
  document = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>.fixture-section{min-height:540px}main{padding-top:24px}.article-grid{max-width:1100px;margin:auto}.article-body{padding-inline:24px}</style><script type="module" src="/controller.js"></script></head><body><main class="article-grid">${toc}<article class="article-body">${chapters}</article></main></body></html>`;
});

async function fixture(page: Page, gate = Promise.resolve(), enhance = true) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname === '/styles.css')
      return route.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname === '/controller.js') {
      await gate;
      return route.fulfill({
        contentType: 'text/javascript',
        body: controller,
      });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: enhance
        ? document
        : document.replace(
            '<script type="module" src="/controller.js"></script>',
            '',
          ),
    });
  });
}

test('the complete outline exists without JavaScript and remains natively collapsible', async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1100, height: 800 },
  });
  try {
    const page = await context.newPage();
    await fixture(page);
    await page.goto(origin);
    await expect(page.locator('[data-reading-toc-link]')).toHaveCount(
      entries.length,
    );
    await expect(page.locator('[data-reading-toc]')).toHaveAttribute(
      'open',
      '',
    );
    await page.getByText('文章目錄', { exact: true }).click();
    await expect(page.locator('[data-reading-toc]')).not.toHaveAttribute(
      'open',
      '',
    );
    await page.getByText('文章目錄', { exact: true }).click();
    await expect(page.locator('[data-reading-toc-link]').first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('loading the controller preserves initial outline and article geometry', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await fixture(page, gate);
  await page.goto(origin, { waitUntil: 'commit' });
  await page.waitForFunction(
    () =>
      Boolean(globalThis.document.querySelector('#chapter-0')) &&
      [...globalThis.document.styleSheets].length > 0,
  );
  const before = await page.locator('#chapter-0').boundingBox();
  expect(before).not.toBeNull();
  release();
  await page.waitForLoadState('load');
  const after = await page.locator('#chapter-0').boundingBox();
  expect(after?.y).toBe(before?.y);
  expect(after?.height).toBe(before?.height);
  await expect(page.locator('[data-reading-toc-link]').first()).toHaveAttribute(
    'aria-current',
    'location',
  );
});

test('passive section updates do not move the page or override manual outline scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await fixture(page);
  await page.goto(origin);
  const y = await page.locator('#chapter-25').evaluate((node) => {
    const top = scrollY + node.getBoundingClientRect().top + 90;
    window.scrollTo({ top, behavior: 'instant' });
    return scrollY;
  });
  await expect(page.locator('[href="#chapter-25"]')).toHaveAttribute(
    'aria-current',
    'location',
  );
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(y, 0);
  await expect
    .poll(() =>
      page
        .locator('[data-reading-toc-list]')
        .evaluate((node) => node.scrollTop),
    )
    .toBe(0);
  await page.locator('[data-reading-toc-list]').evaluate((node) => {
    node.scrollTop = 120;
  });
  await page.locator('#chapter-26').evaluate((node) =>
    window.scrollTo({
      top: scrollY + node.getBoundingClientRect().top + 80,
      behavior: 'instant',
    }),
  );
  await expect(page.locator('[href="#chapter-26"]')).toHaveAttribute(
    'aria-current',
    'location',
  );
  await expect
    .poll(() =>
      page
        .locator('[data-reading-toc-list]')
        .evaluate((node) => node.scrollTop),
    )
    .toBe(120);
});

test('opening the outline centers the current section once and leaves later gestures in control', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await fixture(page);
  await page.goto(origin);
  await page.locator('#chapter-24').evaluate((node) =>
    window.scrollTo({
      top: scrollY + node.getBoundingClientRect().top + 70,
      behavior: 'instant',
    }),
  );
  const outline = page.locator('[data-reading-toc]');
  await outline.locator('summary').click();
  await expect(outline).not.toHaveAttribute('open', '');
  await outline.locator('summary').click();
  await expect
    .poll(() =>
      page.locator('[data-reading-toc-list]').evaluate((node) => {
        const current = node.querySelector('[aria-current="location"]');
        if (!current) return Infinity;
        const viewport = node.getBoundingClientRect();
        const row = current.getBoundingClientRect();
        return Math.abs(
          row.top +
            row.height / 2 -
            (viewport.top + node.clientTop + node.clientHeight / 2),
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  await page.locator('[data-reading-toc-list]').evaluate((node) => {
    node.scrollTop = 25;
  });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await expect
    .poll(() =>
      page
        .locator('[data-reading-toc-list]')
        .evaluate((node) => node.scrollTop),
    )
    .toBe(25);
});

test('mobile code retains consistent text sizing, manual zoom and vertical scroll chaining', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await fixture(page);
  await page.goto(origin);
  const layout = await page.locator('pre').evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      x: style.overscrollBehaviorX,
      y: style.overscrollBehaviorY,
      size:
        getComputedStyle(globalThis.document.documentElement).getPropertyValue(
          '-webkit-text-size-adjust',
        ) ||
        getComputedStyle(globalThis.document.documentElement).getPropertyValue(
          'text-size-adjust',
        ),
      viewport: globalThis.document
        .querySelector('meta[name="viewport"]')
        ?.getAttribute('content'),
      supportsSizeAdjust:
        CSS.supports('text-size-adjust', '100%') ||
        CSS.supports('-webkit-text-size-adjust', '100%'),
      codeSize: Number.parseFloat(style.fontSize),
      rootSize: Number.parseFloat(
        getComputedStyle(globalThis.document.documentElement).fontSize,
      ),
    };
  });
  expect(layout.x).toBe('contain');
  expect(layout.y).toBe('auto');
  if (layout.supportsSizeAdjust) expect(layout.size.trim()).toBe('100%');
  expect(layout.codeSize).toBeCloseTo(layout.rootSize * 0.9, 1);
  expect(css).toContain('-webkit-text-size-adjust: 100%');
  expect(css).toContain('text-size-adjust: 100%');
  expect(layout.viewport).not.toContain('maximum-scale');
  expect(layout.viewport).not.toContain('user-scalable=no');
});

test('the reading controller preserves native Back and Forward behavior after a chapter fragment', async ({
  page,
}) => {
  async function settled(target: Page) {
    return target.evaluate(async () => {
      let previous = scrollY;
      let stable = 0;
      const started = performance.now();
      for (let frame = 0; frame < 180; frame++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        stable = Math.abs(previous - scrollY) < 0.5 ? stable + 1 : 0;
        previous = scrollY;
        if (stable >= 6 && performance.now() - started >= 1000) return scrollY;
      }
      throw new Error('Reading position did not settle');
    });
  }
  async function journey(target: Page, enhance: boolean) {
    await target.bringToFront();
    await target.setViewportSize({ width: 1100, height: 800 });
    await fixture(target, Promise.resolve(), enhance);
    await target.goto(origin);
    await target.locator('[href="#chapter-3"]').click();
    await expect(target).toHaveURL(`${origin}/#chapter-3`);
    await settled(target);
    await target.locator('#chapter-18').evaluate((node) =>
      window.scrollTo({
        top: scrollY + node.getBoundingClientRect().top + 90,
        behavior: 'instant',
      }),
    );
    const first = await settled(target);
    await target.goto(`${origin}/next/`);
    await target.locator('#chapter-9').evaluate((node) =>
      window.scrollTo({
        top: scrollY + node.getBoundingClientRect().top + 70,
        behavior: 'instant',
      }),
    );
    const second = await settled(target);
    await target.goBack();
    await expect(target).toHaveURL(`${origin}/#chapter-3`);
    const back = await settled(target);
    await target.goForward();
    const forward = await settled(target);
    expect(await target.evaluate(() => history.scrollRestoration)).toBe('auto');
    return {
      first,
      second,
      back,
      forward,
      backDelta: back - first,
      forwardDelta: forward - second,
    };
  }
  const native = await page.context().newPage();
  try {
    const expected = await journey(native, false);
    const actual = await journey(page, true);
    await test.info().attach('native-history-comparison.json', {
      body: JSON.stringify({ expected, actual }, null, 2),
      contentType: 'application/json',
    });
    for (const key of ['backDelta', 'forwardDelta'] as const) {
      // Some engines replay the old fragment even without our controller.
      // Enhancement must retain that native result or restore the exact saved
      // depth; it may improve native behavior but must not introduce a new jump.
      expect(Math.abs(actual[key])).toBeLessThanOrEqual(
        Math.abs(expected[key]) + 1,
      );
      expect(
        Math.abs(actual[key]) <= 1 ||
          Math.abs(actual[key] - expected[key]) <= 1,
      ).toBe(true);
    }
  } finally {
    await native.close();
  }
});
