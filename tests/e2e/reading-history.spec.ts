import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { build } from 'vite';
import { compileReadingHistory } from '../../site/src/scripts/reading-history-head.js';

const origin = 'http://foliohaven-reading-history.test';
const iphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ipadDesktop =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const scripts = new Map<string, string>();
let historyBootstrap: string;

interface ReadingHistoryCapture {
  at: number;
  reason: string;
  complete: boolean;
  positions: number[];
}
declare global {
  interface Window {
    readingHistoryCapture?: ReadingHistoryCapture;
    fixtureLateRestores?: number;
  }
}

test.beforeAll(async () => {
  const entry = fileURLToPath(
    new URL('../../site/src/scripts/reading-controller.ts', import.meta.url),
  );
  historyBootstrap = compileReadingHistory(
    await readFile(
      new URL('../../site/src/scripts/reading-history.ts', import.meta.url),
      'utf8',
    ),
  );
  // The restoration bootstrap runs as a classic head script, before the body
  // or optional controller can load, exactly as in the production layout.
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry, formats: ['es'] },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output) =>
    'output' in output
      ? output.output.filter((file) => file.type === 'chunk')
      : [],
  );
  const controller = chunks[0];
  if (chunks.length !== 1 || !controller)
    throw new Error('Expected one bundled reading controller');
  scripts.set('/reading-controller.js', controller.code);
});

function readingDocument(path: string, delayedLoad = false) {
  const sections = Array.from(
    { length: 10 },
    (_, index) =>
      `<section id="chapter-${index}"><h2>${path} 章節 ${index}</h2><p>可獨立閱讀的文章內容。</p></section>`,
  ).join('');
  const content =
    path === '/articles/'
      ? `<div id="fixture-search" data-search-state="loading" data-search-result-state="pending" data-search-feedback="searching"><div style="height:180px">載入搜尋結果</div></div><script>setTimeout(()=>{const results=document.getElementById('fixture-search');results.innerHTML=${JSON.stringify(sections)};results.dataset.searchState='ready';results.dataset.searchResultState='ready';results.dataset.searchFeedback='idle';dispatchEvent(new Event('fixture-search-ready'));},performance.getEntriesByType('navigation')[0]?.type==='back_forward'?1250:20)</script>`
      : sections;
  return `<!doctype html><html class="site-document" lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>${historyBootstrap}</script><style>html{scroll-padding-top:24px}html[data-reading-scroll-ready=true]{scroll-behavior:smooth}body{margin:0}section{height:700px;box-sizing:border-box;padding:24px}h2{margin:0}nav{position:fixed;inset:0 0 auto;z-index:5;background:#eee}nav a{display:inline-block;padding:8px}</style><script type="module" src="/reading-controller.js"></script></head><body class="site"><nav><a data-reading-toc-link href="#chapter-2">章節二</a><a data-reading-toc-link href="#chapter-4">章節四</a><a id="next-page" href="/b/">下一篇</a><a id="fresh-page" href="/a/">文章 A</a></nav><main>${content}</main>${delayedLoad ? '<img src="/delayed.svg" width="1" height="1" alt="">' : ''}</body></html>`;
}

async function readingPage(
  browser: Browser,
  options: {
    ipad?: boolean;
    blockedStorage?: boolean;
    controllerDelay?: number;
    loadDelay?: number;
    lateReset?: { delay: number; target: 'top' | 'fragment' };
  } = {},
) {
  const context = await browser.newContext({
    userAgent: options.ipad ? ipadDesktop : iphone,
    viewport: options.ipad
      ? { width: 1024, height: 768 }
      : { width: 393, height: 852 },
    hasTouch: true,
  });
  const page = await context.newPage();
  if (options.ipad)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    });
  if (options.blockedStorage)
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        get() {
          throw new DOMException('Storage disabled', 'SecurityError');
        },
      });
    });
  await page.addInitScript((lateReset) => {
    let generation = 0;
    addEventListener('pagehide', () => generation++);
    function record(event: Event) {
      const current = ++generation;
      const capture: ReadingHistoryCapture = {
        at: Date.now(),
        reason: event.type,
        complete: false,
        positions: [],
      };
      window.readingHistoryCapture = capture;
      const start = performance.now();
      function sample(now: number) {
        if (current !== generation) return;
        capture.positions.push(scrollY);
        if (now - start >= 1000) capture.complete = true;
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }
    addEventListener('pageshow', record);
    addEventListener('popstate', record);
    addEventListener('fixture-search-ready', record);
    addEventListener('pageshow', (event) => {
      if (
        !lateReset ||
        (!(event as PageTransitionEvent).persisted &&
          (
            performance.getEntriesByType('navigation')[0] as
              PerformanceNavigationTiming | undefined
          )?.type !== 'back_forward')
      )
        return;
      setTimeout(() => {
        window.fixtureLateRestores = (window.fixtureLateRestores ?? 0) + 1;
        if (lateReset.target === 'fragment' && location.hash)
          document
            .getElementById(decodeURIComponent(location.hash.slice(1)))
            ?.scrollIntoView({ behavior: 'instant' });
        else window.scrollTo({ top: 0, behavior: 'instant' });
      }, lateReset.delay);
    });
  }, options.lateReset);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname === '/delayed.svg') {
      await new Promise((resolve) => setTimeout(resolve, options.loadDelay));
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      });
    }
    const script = scripts.get(url.pathname);
    if (script !== undefined) {
      if (options.controllerDelay)
        await new Promise((resolve) =>
          setTimeout(resolve, options.controllerDelay),
        );
      return route.fulfill({ contentType: 'text/javascript', body: script });
    }
    if (['/a/', '/b/', '/articles/'].includes(url.pathname))
      return route.fulfill({
        contentType: 'text/html',
        body: readingDocument(url.pathname, Boolean(options.loadDelay)),
      });
    return route.abort('blockedbyclient');
  });
  return { page, close: () => context.close() };
}

async function settle(page: Page) {
  return page.evaluate(async () => {
    for (let frame = 0; frame < 5; frame++)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    return scrollY;
  });
}

async function readAt(page: Page, chapter: number, offset = 137) {
  await page.locator(`#chapter-${chapter}`).evaluate((node, offset) => {
    window.scrollTo({
      top: scrollY + node.getBoundingClientRect().top + offset,
      behavior: 'instant',
    });
  }, offset);
  return settle(page);
}

async function expectReadingPosition(page: Page, position: number) {
  await expect
    .poll(() => page.evaluate(() => scrollY))
    .toBeCloseTo(position, 0);
}

async function expectStillAfterReturn(
  page: Page,
  expected: number,
  after: number,
) {
  await expect
    .poll(() =>
      page.evaluate((after) => {
        return Boolean(
          window.readingHistoryCapture?.complete &&
          window.readingHistoryCapture.at >= after,
        );
      }, after),
    )
    .toBe(true);
  const positions = await page.evaluate(() => {
    return window.readingHistoryCapture?.positions ?? [];
  });
  expect(positions.length).toBeGreaterThan(2);
  for (const position of positions)
    expect(Math.abs(position - expected)).toBeLessThanOrEqual(1);
  await expectReadingPosition(page, expected);
}

test.describe('iOS reading history', () => {
  test.skip(({ browserName }) => browserName !== 'webkit');

  for (const ipad of [false, true]) {
    test(`Back and Forward restore saved reading depth on ${ipad ? 'iPad desktop identity' : 'iPhone'}`, async ({
      browser,
    }) => {
      const { page, close } = await readingPage(browser, { ipad });
      try {
        await page.goto(`${origin}/a/#chapter-2`);
        await expectReadingPosition(page, 1376);
        const aPosition = await readAt(page, 6);
        await page.locator('#next-page').click();
        await expect(page).toHaveURL(`${origin}/b/`);
        const bPosition = await readAt(page, 4, 173);
        const backStarted = Date.now();
        await page.goBack({ waitUntil: 'load' });
        await expect(page).toHaveURL(`${origin}/a/#chapter-2`);
        await expectStillAfterReturn(page, aPosition, backStarted);
        const forwardStarted = Date.now();
        await page.goForward({ waitUntil: 'load' });
        await expect(page).toHaveURL(`${origin}/b/`);
        await expectStillAfterReturn(page, bPosition, forwardStarted);
      } finally {
        await close();
      }
    });
  }

  test('same-document chapter history keeps each entry’s reading position', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser);
    try {
      await page.goto(`${origin}/a/`);
      await page.evaluate(() => {
        history.replaceState(
          { ...history.state, fixturePreserved: { value: 'keep' } },
          '',
        );
      });
      await page.locator('[href="#chapter-2"]').click();
      await expect(page).toHaveURL(`${origin}/a/#chapter-2`);
      await expectReadingPosition(page, 1376);
      expect(await page.evaluate(() => history.state.fixturePreserved)).toEqual(
        {
          value: 'keep',
        },
      );
      const first = await readAt(page, 5, 193);
      await page.locator('[href="#chapter-4"]').click();
      await expect(page).toHaveURL(`${origin}/a/#chapter-4`);
      await expectReadingPosition(page, 2776);
      const second = await readAt(page, 7, 113);
      const backStarted = Date.now();
      await page.goBack();
      await expect(page).toHaveURL(`${origin}/a/#chapter-2`);
      await expectStillAfterReturn(page, first, backStarted);
      const forwardStarted = Date.now();
      await page.goForward();
      await expect(page).toHaveURL(`${origin}/a/#chapter-4`);
      await expectStillAfterReturn(page, second, forwardStarted);
      expect(await page.evaluate(() => history.state.fixturePreserved)).toEqual(
        {
          value: 'keep',
        },
      );
    } finally {
      await close();
    }
  });

  test('revisiting the same URL creates a fresh entry and preserves earlier visits independently', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser);
    try {
      await page.goto(`${origin}/a/#chapter-2`);
      await expectReadingPosition(page, 1376);
      const first = await readAt(page, 6, 97);
      await page.locator('#next-page').click();
      await page.locator('#fresh-page').evaluate((link) => {
        link.setAttribute('href', '/a/#chapter-2');
      });
      await page.locator('#fresh-page').click();
      await expect(page).toHaveURL(`${origin}/a/#chapter-2`);
      // A new visit must use its requested chapter, not the last saved offset.
      await expectReadingPosition(page, 1376);
      const second = await readAt(page, 4, 73);
      await page.locator('#next-page').click();
      const secondBack = Date.now();
      await page.goBack({ waitUntil: 'load' });
      await expectStillAfterReturn(page, second, secondBack);
      await page.goBack({ waitUntil: 'load' });
      await expect(page).toHaveURL(`${origin}/b/`);
      const firstBack = Date.now();
      await page.goBack({ waitUntil: 'load' });
      await expect(page).toHaveURL(`${origin}/a/#chapter-2`);
      await expectStillAfterReturn(page, first, firstBack);
      await page.goForward({ waitUntil: 'load' });
      const secondForward = Date.now();
      await page.goForward({ waitUntil: 'load' });
      await expect(page).toHaveURL(`${origin}/a/#chapter-2`);
      await expectStillAfterReturn(page, second, secondForward);
    } finally {
      await close();
    }
  });

  test('blocked storage retains native anchors without breaking page interaction', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser, {
      blockedStorage: true,
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}/a/#chapter-2`);
      await expectReadingPosition(page, 1376);
      await expect(
        page.evaluate(() => history.scrollRestoration),
      ).resolves.toBe('auto');
      await page.locator('[href="#chapter-4"]').click();
      await expect(page).toHaveURL(`${origin}/a/#chapter-4`);
      await expectReadingPosition(page, 2776);
      await page.locator('#next-page').click();
      await expect(page).toHaveURL(`${origin}/b/`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test('a fixed modal background does not replace the saved reading depth with zero', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser);
    try {
      await page.goto(`${origin}/a/#chapter-2`);
      await expectReadingPosition(page, 1376);
      const reading = await readAt(page, 6, 93);
      await page.evaluate(() => {
        const reading = scrollY;
        document.documentElement.classList.add('site-directory-modal-open');
        document.body.style.position = 'fixed';
        document.body.style.top = `-${reading}px`;
        document.body.style.width = '100%';
      });
      await expectReadingPosition(page, 0);
      await page.evaluate(() => {
        location.href = '/b/';
      });
      await expect(page).toHaveURL(`${origin}/b/`);
      const backStarted = Date.now();
      await page.goBack({ waitUntil: 'load' });
      await expect(page).toHaveURL(`${origin}/a/#chapter-2`);
      await expectStillAfterReturn(page, reading, backStarted);
    } finally {
      await close();
    }
  });

  test('search-style query navigation restores its own depth without losing the earlier chapter entry', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser);
    try {
      await page.goto(`${origin}/a/#chapter-2`);
      await expectReadingPosition(page, 1376);
      const chapterPosition = await readAt(page, 6, 113);
      await page.evaluate(() => {
        history.pushState(null, '', '/a/?q=rust');
        dispatchEvent(new PopStateEvent('popstate'));
      });
      await expect(page).toHaveURL(`${origin}/a/?q=rust`);
      expect(await page.evaluate(() => history.scrollRestoration)).toBe(
        'manual',
      );
      const queryPosition = await readAt(page, 4, 153);
      await page.locator('#next-page').click();
      await expect(page).toHaveURL(`${origin}/b/`);
      const queryBack = Date.now();
      await page.goBack({ waitUntil: 'load' });
      await expect(page).toHaveURL(`${origin}/a/?q=rust`);
      expect(await page.evaluate(() => history.scrollRestoration)).toBe(
        'manual',
      );
      await expectStillAfterReturn(page, queryPosition, queryBack);
      const chapterBack = Date.now();
      await page.goBack();
      await expect(page).toHaveURL(`${origin}/a/#chapter-2`);
      await expectStillAfterReturn(page, chapterPosition, chapterBack);
    } finally {
      await close();
    }
  });

  test('restoration is installed in the head before the optional controller loads', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser, {
      controllerDelay: 700,
    });
    try {
      await page.goto(`${origin}/a/`, { waitUntil: 'commit' });
      await page.locator('#chapter-0').waitFor();
      expect(await page.evaluate(() => history.scrollRestoration)).toBe(
        'manual',
      );
      expect(await page.evaluate(() => document.readyState)).not.toBe(
        'complete',
      );
      await page.waitForLoadState('load');
    } finally {
      await close();
    }
  });

  test('reloading a URL without a fragment preserves its reading depth', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser);
    try {
      await page.goto(`${origin}/a/`);
      const saved = await readAt(page, 6, 127);
      const reloadStarted = Date.now();
      await page.reload({ waitUntil: 'load' });
      await expect(page).toHaveURL(`${origin}/a/`);
      await expectStillAfterReturn(page, saved, reloadStarted);
    } finally {
      await close();
    }
  });

  for (const reset of [
    { hash: false, delay: 250, target: 'top' as const },
    { hash: true, delay: 650, target: 'fragment' as const },
  ]) {
    test(`${reset.hash ? 'a chapter URL' : 'a URL without a fragment'} survives a delayed ${reset.delay}ms browser restoration without losing its snapshot`, async ({
      browser,
    }) => {
      const { page, close } = await readingPage(browser, {
        lateReset: { delay: reset.delay, target: reset.target },
      });
      try {
        const path = `${origin}/a/${reset.hash ? '#chapter-2' : ''}`;
        await page.goto(path);
        const aPosition = await readAt(page, 6, 117);
        await page.locator('#next-page').click();
        const bPosition = await readAt(page, 4, 167);
        const backStarted = Date.now();
        await page.goBack({ waitUntil: 'load' });
        await expect(page).toHaveURL(path);
        await expectStillAfterReturn(page, aPosition, backStarted);
        expect(await page.evaluate(() => window.fixtureLateRestores)).toBe(1);
        const forwardStarted = Date.now();
        await page.goForward({ waitUntil: 'load' });
        await expectStillAfterReturn(page, bPosition, forwardStarted);
        expect(await page.evaluate(() => window.fixtureLateRestores)).toBe(1);
        // A second return also proves the late reset never overwrote the good
        // snapshot after the restoration guard finished.
        const secondBackStarted = Date.now();
        await page.goBack({ waitUntil: 'load' });
        await expectStillAfterReturn(page, aPosition, secondBackStarted);
      } finally {
        await close();
      }
    });
  }

  test('persisted lifecycle flushes the cached reading point before a swipe reset and restores the active entry', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser);
    try {
      await page.goto(`${origin}/a/`);
      await page.locator('[href="#chapter-2"]').click();
      await expectReadingPosition(page, 1376);
      const firstPosition = await readAt(page, 5, 137);
      const firstState: unknown = await page.evaluate(() => history.state);
      await page.locator('[href="#chapter-4"]').click();
      await expectReadingPosition(page, 2776);
      const secondPosition = await readAt(page, 7, 133);
      // WebKit can reset the live viewport before pagehide dispatch. Keep the
      // reset and lifecycle event in one task, before another scroll event can
      // replace the last reading coordinate.
      await page.evaluate(() => {
        scrollTo({ top: 0, behavior: 'instant' });
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      });
      const resumed = Date.now();
      await page.evaluate(() => {
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await expectStillAfterReturn(page, secondPosition, resumed);

      // A BFCache heap may retain the newer chapter key while the browser has
      // activated an older entry. This state transition intentionally emits
      // pageshow without a helping popstate first.
      await page.evaluate((state) => {
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        history.replaceState(state, '', '/a/#chapter-2');
      }, firstState);
      const olderEntryResumed = Date.now();
      await page.evaluate(() => {
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await expectStillAfterReturn(page, firstPosition, olderEntryResumed);
    } finally {
      await close();
    }
  });

  test('a fresh reader gesture immediately cancels restoration corrections', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser);
    try {
      await page.goto(`${origin}/a/`);
      const saved = await readAt(page, 5, 113);
      await page.locator('#next-page').click();
      await page.goBack({ waitUntil: 'load' });
      await expectReadingPosition(page, saved);
      // A trusted touch begins before the 1000ms guard expires. The helper
      // must hand control back rather than snapping to its saved coordinate.
      await page.touchscreen.tap(200, 500);
      const chosen = await readAt(page, 7, 177);
      expect(Math.abs(chosen - saved)).toBeGreaterThan(500);
      await page.waitForTimeout(950);
      await expectReadingPosition(page, chosen);
    } finally {
      await close();
    }
  });

  test('reader input before pageshow keeps control when a slow asset finishes loading', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser, { loadDelay: 900 });
    try {
      await page.goto(`${origin}/a/`);
      const saved = await readAt(page, 5, 117);
      await page.locator('#next-page').click();
      await page.waitForLoadState('load');
      const backStarted = Date.now();
      await page.goBack({ waitUntil: 'commit' });
      await page.locator('#chapter-5').waitFor();
      await expectReadingPosition(page, saved);
      expect(await page.evaluate(() => document.readyState)).not.toBe(
        'complete',
      );
      await page.touchscreen.tap(200, 500);
      const chosen = await readAt(page, 7, 171);
      expect(Math.abs(chosen - saved)).toBeGreaterThan(500);
      await page.waitForLoadState('load');
      await expectStillAfterReturn(page, chosen, backStarted);
    } finally {
      await close();
    }
  });

  test('returning to asynchronous search waits for its result height before restoring and saving', async ({
    browser,
  }) => {
    const { page, close } = await readingPage(browser, {
      lateReset: { delay: 250, target: 'top' },
    });
    try {
      await page.goto(`${origin}/articles/?q=rust`);
      await expect(page.locator('#fixture-search')).toHaveAttribute(
        'data-search-state',
        'ready',
      );
      const saved = await readAt(page, 6, 173);
      await page.locator('#next-page').click();
      const backStarted = Date.now();
      await page.goBack({ waitUntil: 'load' });
      await expect(page.locator('#fixture-search')).toHaveAttribute(
        'data-search-state',
        'ready',
      );
      expect(
        await page.evaluate(() => window.readingHistoryCapture?.reason),
      ).toBe('fixture-search-ready');
      await expectStillAfterReturn(page, saved, backStarted);
      const forwardStarted = Date.now();
      await page.goForward({ waitUntil: 'load' });
      await expectStillAfterReturn(page, 0, forwardStarted);
      const secondBackStarted = Date.now();
      await page.goBack({ waitUntil: 'load' });
      await expect(page.locator('#fixture-search')).toHaveAttribute(
        'data-search-state',
        'ready',
      );
      await expectStillAfterReturn(page, saved, secondBackStarted);
    } finally {
      await close();
    }
  });
});
