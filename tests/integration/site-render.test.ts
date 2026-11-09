import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import {
  BuildResultSchema,
  SafeErrorSchema,
  UuidSchema,
} from '@foliohaven/core';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../server/src/runtime/environment.js';
import type * as Renderer from '../../server/src/build/render/index.js';
import { withSiteDev } from '../fixtures/site/dev-server.js';
import {
  validateSiteOutput,
  RenderError,
  safeRenderFailure,
} from '../../server/src/build/render/index.js';
import {
  siteWorkspace,
  captureSiteWorkspaceSources,
  treeText,
  publishedImageId,
  draftImageId,
  draftSentinel,
} from '../fixtures/build/site-workspace.js';
const cleanups: (() => Promise<void>)[] = [];
let sources: Awaited<ReturnType<typeof captureSiteWorkspaceSources>>;
beforeAll(async () => {
  sources = await captureSiteWorkspaceSources();
});
afterAll(async () => {
  await sources?.cleanup();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function worker(fixture: Awaited<ReturnType<typeof siteWorkspace>>) {
  try {
    await runControlledProcess({
      command: process.execPath,
      args: ['scripts/build-worker.mjs', fixture.jobId],
      cwd: fixture.snapshot,
      env: buildProcessEnvironment({
        ALFRED_SNAPSHOT_REVISION: fixture.revision,
      }),
      keepStdinOpen: true,
      timeoutMs: 120_000,
    });
  } catch (error) {
    let safe;
    try {
      safe = SafeErrorSchema.parse(
        JSON.parse(
          await readFile(
            join(fixture.snapshot, '.foliohaven/build-failure.json'),
            'utf8',
          ),
        ).error,
      );
    } catch {
      throw error;
    }
    throw new Error(
      `Worker rejected: ${safe.code}; issues=${safe.issues.map((item) => `${item.code}:${item.path.join('.')}`).join(',')}`,
      { cause: error },
    );
  }
  return JSON.parse(
    await readFile(
      join(fixture.snapshot, '.foliohaven/build-result.json'),
      'utf8',
    ),
  ) as {
    schemaVersion: number;
    result: unknown;
    mediaPending: boolean;
    pendingLinkChecks: number;
  };
}
describe('real isolated Astro snapshot renderer', () => {
  it('renders published HTML/media/SEO/feeds, supports a registered data page, rejects broken final output, and repeats deterministically', async () => {
    const fixture = await siteWorkspace(false, sources.root);
    cleanups.push(fixture.cleanup);
    const report = await worker(fixture);
    expect(report.schemaVersion).toBe(1);
    expect(report.mediaPending).toBe(false);
    expect(report.pendingLinkChecks).toBe(0);
    const result = BuildResultSchema.parse(report.result);
    expect(result.snapshotRevision).toBe(fixture.revision);
    expect(result.outputDirectory).toBe('dist');
    const tree = await treeText(fixture.output);
    expect(result.fileCount).toBe(Object.keys(tree).length);
    const html = await readFile(
      join(fixture.output, 'notes/entry-1/index.html'),
      'utf8',
    );
    expect(html).toContain('<!-- exact SSR fixture -->\n<h2 id="章節-1">');
    expect(html).toContain('正文可在沒有 JavaScript 時閱讀。');
    expect(html).toContain('width="1000"');
    expect(/srcset=/iu.test(html)).toBe(true);
    expect(html).toContain('BlogPosting');
    expect(html).toContain('BreadcrumbList');
    expect(html).not.toContain('astro-island');
    const allText = Object.entries(tree)
      .filter(([path]) => !/\.(webp|webm)$/u.test(path))
      .map(([, value]) => Buffer.from(value, 'base64').toString('utf8'))
      .join('\n');
    expect(allText).not.toContain(draftSentinel);
    expect(allText).not.toContain(draftImageId);
    expect(allText).not.toContain('private-draft');
    expect(
      Object.keys(tree).some((path) => path.includes(publishedImageId)),
    ).toBe(true);
    expect(
      Object.keys(tree).some((path) =>
        /\.map$|(?:^|\/)(?:server|studio)\/src\/|(?:^|\/)(?:meta|package)\.json$/u.test(
          path,
        ),
      ),
    ).toBe(false);
    expect(Object.keys(tree)).toEqual(
      expect.arrayContaining([
        'category/notes/2/index.html',
        'notes/content/index.html',
        'category/tools/index.html',
        'tag/example/2/index.html',
        'category/empty/index.html',
        'tag/empty/index.html',
        'about/index.html',
        '404.html',
        'rss.xml',
        'search-index.json',
        'sitemap-index.xml',
        'robots.txt',
      ]),
    );
    expect(Object.keys(tree)).not.toContain('category/notes/1/index.html');
    const index = JSON.parse(
      await readFile(
        join(fixture.snapshot, '.foliohaven/render/index.json'),
        'utf8',
      ),
    ) as { generation: unknown; articles: { file: string }[] };
    expect(JSON.stringify(index)).not.toContain('contentHtml');
    expect(index.articles).toHaveLength(5);
    const generation = UuidSchema.parse(index.generation);
    const snapshotRenderer = (await import(
      pathToFileURL(join(fixture.snapshot, 'server/dist/build/render/index.js'))
        .href
    )) as typeof Renderer;
    await withSiteDev(fixture.snapshot, async (origin) => {
      const refreshWithReaders = async () => {
        const statuses: number[] = [];
        let observing = true;
        const reads = (async () => {
          do {
            const response = await fetch(`${origin}/`, {
              signal: AbortSignal.timeout(5_000),
            });
            statuses.push(response.status);
            const body = await response.text();
            expect(body).toContain('SSG驗收網站');
            expect(body).not.toContain('RENDER_CONTEXT_INVALID');
          } while (observing);
        })();
        try {
          await snapshotRenderer.prepareRenderContext({
            repositoryRoot: fixture.snapshot,
            contextDirectory: join(fixture.snapshot, '.foliohaven/render'),
            coordinationRoot: fixture.root,
          });
        } finally {
          observing = false;
          await reads;
        }
        expect(statuses.length).toBeGreaterThan(0);
        expect(statuses.every((status) => status === 200)).toBe(true);
      };
      const home = await fetch(`${origin}/`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(home.status).toBe(200);
      expect(await home.text()).toContain('SSG驗收網站');
      const about = await fetch(`${origin}/about/`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(about.status).toBe(200);
      const aboutHtml = await about.text();
      expect(aboutHtml).toContain('獨立介紹頁');
      expect(aboutHtml).toContain('來自 strict page schema 的資料');
      expect(aboutHtml).toContain('介紹獨立SEO');
      const style = await fetch(
        `${origin}/@fs${fixture.snapshot}/packages/ui/dist/styles/index.css?direct`,
        { signal: AbortSignal.timeout(5_000) },
      );
      expect(style.status).toBe(200);
      expect(await style.text()).toContain('focus-visible');
      for (const resource of [
        'content/site.json',
        '.foliohaven/render/index.json',
        `.foliohaven/render/generations/${generation}/home.json`,
        `.foliohaven/render/generations/${generation}/index.json`,
        'server/package.json',
        `media/source/${draftImageId}/original.png`,
      ]) {
        const response = await fetch(
          `${origin}/@fs${fixture.snapshot}/${resource}?raw`,
          { signal: AbortSignal.timeout(5_000) },
        );
        expect([403, 404]).toContain(response.status);
        const body = await response.text();
        expect(body).not.toContain(draftSentinel);
        expect(body).not.toContain('SSR完整內容與來源隔離驗收');
        expect(body).not.toContain('"mediaManifest"');
      }
      const fresh = join(fixture.snapshot, 'content/articles/fresh-entry');
      await mkdir(fresh);
      const meta = JSON.parse(
        await readFile(
          join(fixture.snapshot, 'content/articles/entry-5/meta.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      meta['slug'] = 'fresh-entry';
      meta['title'] = '新增的開發文章';
      await writeFile(join(fresh, 'meta.json'), JSON.stringify(meta));
      await writeFile(
        join(fresh, 'content.html'),
        '<h2 id="fresh-heading">新增正文</h2>',
      );
      await refreshWithReaders();
      let refreshed = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const response = await fetch(`${origin}/tools/fresh-entry/`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (
          response.status === 200 &&
          (await response.text()).includes('新增的開發文章')
        ) {
          refreshed = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      expect(refreshed).toBe(true);
      await rm(fresh, { recursive: true });
      await refreshWithReaders();
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const rss = await readFile(join(fixture.output, 'rss.xml'), 'utf8');
      const sitemap = await readFile(
        join(fixture.output, 'sitemap-0.xml'),
        'utf8',
      );
      const xml = await page.evaluate(
        ({ rss, sitemap }) => {
          const r = new DOMParser().parseFromString(rss, 'application/xml');
          const s = new DOMParser().parseFromString(sitemap, 'application/xml');
          return {
            errors:
              r.querySelectorAll('parsererror').length +
              s.querySelectorAll('parsererror').length,
            items: [...r.querySelectorAll('item')].map((item) => ({
              guids: [...item.querySelectorAll('guid')].map((guid) => ({
                value: guid.textContent,
                permalink: guid.getAttribute('isPermaLink'),
              })),
              link: item.querySelector('link')?.textContent,
            })),
            last: r.querySelector('lastBuildDate')?.textContent,
            locations: [...s.querySelectorAll('url>loc')].map(
              (item) => item.textContent,
            ),
          };
        },
        { rss, sitemap },
      );
      expect(xml.errors).toBe(0);
      expect(xml.items).toHaveLength(5);
      expect(
        xml.items.every(
          (item) =>
            item.guids.length === 1 && item.guids[0]?.permalink === 'false',
        ),
      ).toBe(true);
      expect(xml.items[0]?.guids[0]?.value).toBe('article:entry-1');
      expect(xml.last).toBe('Thu, 05 Feb 2026 02:00:00 GMT');
      expect(xml.locations).not.toContain(
        'https://example.invalid/tools/entry-4/',
      );
      expect(xml.locations).not.toContain(
        'https://example.invalid/category/empty/',
      );
      expect(xml.locations).not.toContain('https://example.invalid/404.html');
      expect(xml.locations).toContain('https://example.invalid/about/');
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 375, height: 812 },
      });
      try {
        await context.route('**/*', async (route) => {
          const path = new URL(route.request().url()).pathname;
          const key =
            path === '/'
              ? 'index.html'
              : path.endsWith('/')
                ? `${path.slice(1)}index.html`
                : path.slice(1);
          const bytes = tree[key];
          if (bytes === undefined) {
            await route.abort();
            return;
          }
          await route.fulfill({
            body: Buffer.from(bytes, 'base64'),
            contentType: key.endsWith('.css')
              ? 'text/css'
              : key.endsWith('.webp')
                ? 'image/webp'
                : 'text/html',
          });
        });
        const article = await context.newPage();
        await article.goto('https://example.invalid/notes/entry-1/');
        expect(await article.locator('main h1').textContent()).toBe(
          '測試 </script> & <SSR>',
        );
        expect(await article.locator('main').textContent()).toContain(
          '正文可在沒有 JavaScript 時閱讀。',
        );
        expect(
          await article
            .locator('meta[name="google-site-verification"]')
            .count(),
        ).toBe(0);
        await article.goto('https://example.invalid/');
        expect(
          await article
            .locator('meta[name="google-site-verification"]')
            .getAttribute('content'),
        ).toBe('safe-fixture-verification');
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
    const prepared = await snapshotRenderer.prepareRenderContext({
      repositoryRoot: fixture.snapshot,
      contextDirectory: join(fixture.snapshot, '.foliohaven/probe-render'),
      coordinationRoot: fixture.root,
    });
    const validate = () =>
      validateSiteOutput({
        outputDirectory: fixture.output,
        model: prepared.model,
        manifest: prepared.manifest,
        fixedPageSeos: prepared.fixedPageSeos,
        draftSentinels: [draftSentinel],
      });
    expect((await validate()).pendingLinkChecks).toBe(0);
    for (const [replacement, code] of [
      ['<a href="/about/#absent">壞anchor</a>', 'BROKEN_FRAGMENT'],
      [
        '<img src="/media/12345678-1234-4123-8123-123456789abc/image-2048.webp" alt="不存在"/>',
        'OUTPUT_RESOURCE_MISSING',
      ],
      [draftSentinel, 'DRAFT_OUTPUT_LEAK'],
    ] as const) {
      await writeFile(
        join(fixture.output, 'notes/entry-1/index.html'),
        html.replace('</main>', `${replacement}</main>`),
      );
      await expect(validate()).rejects.toMatchObject({
        code: 'OUTPUT_VALIDATION_FAILED',
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code }),
        ]),
      });
      await writeFile(join(fixture.output, 'notes/entry-1/index.html'), html);
    }
    await writeFile(join(fixture.output, 'source.map'), '{}');
    await expect(validate()).rejects.toMatchObject({
      code: 'OUTPUT_VALIDATION_FAILED',
    });
    await rm(join(fixture.output, 'source.map'));
    const contextEnv = {
      ALFRED_RENDER_CONTEXT: join(fixture.snapshot, '.foliohaven/render'),
      ALFRED_RENDER_OUTPUT: fixture.output,
    };
    await fixture.run(
      ['--filter', '@foliohaven/site', 'typecheck'],
      contextEnv,
    );
    await rm(fixture.output, { recursive: true });
    await rm(join(fixture.snapshot, '.foliohaven/build-result.json'));
    await worker(fixture);
    expect(await treeText(fixture.output)).toEqual(tree);
  }, 240_000);
  it('handles empty collections/all-noindex and refuses missing or invalid context, unregistered pages, and invalid source without writing live dist', async () => {
    const fixture = await siteWorkspace(true, sources.root);
    cleanups.push(fixture.cleanup);
    const report = await worker(fixture);
    expect(report.mediaPending).toBe(false);
    const rss = await readFile(join(fixture.output, 'rss.xml'), 'utf8');
    expect(rss).not.toContain('<item>');
    expect(rss).not.toContain('<lastBuildDate>');
    const index = JSON.parse(
      await readFile(join(fixture.output, 'search-index.json'), 'utf8'),
    ) as { version: number; articles: unknown[] };
    expect(index).toEqual({ version: 1, articles: [] });
    const home = await readFile(join(fixture.output, 'index.html'), 'utf8');
    expect(home).toContain('noindex,follow');
    expect(home).not.toContain('google-site-verification');
    expect(home).not.toContain(draftSentinel);
    await expect(
      fixture.run(['--filter', '@foliohaven/site', 'exec', 'astro', 'build']),
    ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
    const renderer = (await import(
      pathToFileURL(join(fixture.snapshot, 'server/dist/build/render/index.js'))
        .href
    )) as typeof Renderer;
    const context = join(fixture.snapshot, '.foliohaven/dev-probe');
    await writeFile(
      join(fixture.snapshot, 'site/src/pages/rogue.astro'),
      '---\n---\n<p>未登錄頁面</p>',
    );
    await expect(
      renderer.prepareRenderContext({
        repositoryRoot: fixture.snapshot,
        contextDirectory: context,
      }),
    ).rejects.toMatchObject({ code: 'UNREGISTERED_FIXED_ENTRY' });
    await rm(join(fixture.snapshot, 'site/src/pages/rogue.astro'));
    await renderer.prepareRenderContext({
      repositoryRoot: fixture.snapshot,
      contextDirectory: context,
      coordinationRoot: fixture.root,
    });
    await writeFile(
      join(fixture.snapshot, 'content/site.json'),
      'invalid JSON',
    );
    await expect(
      renderer.prepareRenderContext({
        repositoryRoot: fixture.snapshot,
        contextDirectory: context,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_JSON' });
    await renderer.invalidateRenderContext(fixture.snapshot, context);
    expect(
      JSON.parse(await readFile(join(context, 'index.json'), 'utf8')),
    ).toMatchObject({ status: 'invalid' });
    await expect(
      fixture.run(['--filter', '@foliohaven/site', 'exec', 'astro', 'build'], {
        ALFRED_RENDER_CONTEXT: context,
        ALFRED_RENDER_OUTPUT: join(
          fixture.snapshot,
          '.foliohaven/invalid-output',
        ),
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
    await mkdir(join(fixture.root, 'dist'), { recursive: true });
    await writeFile(join(fixture.root, 'dist/index.html'), 'previous artifact');
    await rm(fixture.output, { recursive: true });
    await rm(join(fixture.snapshot, '.foliohaven/build-result.json'));
    await expect(worker(fixture)).rejects.toThrow('INVALID_JSON');
    const failure = JSON.parse(
      await readFile(
        join(fixture.snapshot, '.foliohaven/build-failure.json'),
        'utf8',
      ),
    ) as { schemaVersion: number; error: unknown };
    expect(failure.schemaVersion).toBe(1);
    const safe = SafeErrorSchema.parse(failure.error);
    expect(safe.code).toBe('INVALID_JSON');
    expect(safe.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.arrayContaining(['content/site.json']),
        }),
      ]),
    );
    expect(JSON.stringify(failure)).not.toContain(fixture.snapshot);
    expect(JSON.stringify(failure)).not.toContain('invalid JSON');
    expect(await readFile(join(fixture.root, 'dist/index.html'), 'utf8')).toBe(
      'previous artifact',
    );
  }, 180_000);
  it('maps only validated diagnostics to fixed safe messages and bounds the private failure report', () => {
    const secret = 'PRIVATE_ORIGINAL_MESSAGE_NOT_FOR_OUTPUT';
    const diagnostic = {
      severity: 'error' as const,
      code: 'BROKEN_FRAGMENT',
      message: secret,
      articleId: 'article-one',
      field: 'contentHtml',
      line: 12,
      column: 4,
    };
    const safe = safeRenderFailure(
      new RenderError('OUTPUT_VALIDATION_FAILED', secret, [diagnostic]),
    );
    expect(safe.issues[0]?.path).toEqual([
      'articles',
      'article-one',
      'fields',
      'contentHtml',
      'line',
      12,
      'column',
      4,
    ]);
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(
      safeRenderFailure(
        Object.assign(new Error(secret), {
          code: 'CLAIMED_SAFE_ERROR',
          diagnostics: [diagnostic],
        }),
      ),
    ).toMatchObject({ code: 'BUILD_RENDER_FAILED', issues: [] });
    const truncated = safeRenderFailure(
      new RenderError(
        'CONTENT_VALIDATION_FAILED',
        secret,
        Array.from({ length: 501 }, () => diagnostic),
      ),
    );
    expect(truncated.issues).toHaveLength(500);
    expect(truncated.issues.at(-1)?.code).toBe('ADDITIONAL_DIAGNOSTICS');
    const longResource = 'folder/'.repeat(100) + 'index.html';
    const longFailure = safeRenderFailure(
      new RenderError('OUTPUT_VALIDATION_FAILED', secret, [
        {
          severity: 'error',
          code: 'OUTPUT_TITLE_INVALID',
          message: secret,
          resource: longResource,
        },
      ]),
    );
    expect(SafeErrorSchema.safeParse(longFailure).success).toBe(true);
    expect(longFailure.issues[0]?.path.slice(1).join('')).toBe(longResource);
  });
});
