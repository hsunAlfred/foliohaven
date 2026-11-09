import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  ArticleResourceSchema,
  PreviewResponseSchema,
} from '@foliohaven/core';
import { parse } from 'parse5';
import { samplesWorkspace } from '../fixtures/samples/workspace.js';
import {
  cleanupOwnedProcesses,
  devPorts,
  ownedProcesses,
  portAvailable,
  request,
  replaceSandboxVideo,
  responds,
  startDev,
  waitUntil,
} from '../fixtures/dev/supervisor.js';

let fixture: Awaited<ReturnType<typeof samplesWorkspace>>;
let running: ReturnType<typeof startDev> | undefined;
beforeEach(async () => {
  for (const port of devPorts) expect(await portAvailable(port)).toBe(true);
  fixture = await samplesWorkspace();
});
afterEach(async () => {
  if (!fixture) return;
  try {
    if (running && !running.exited) await running.stop().catch(() => undefined);
    await cleanupOwnedProcesses(fixture.root);
  } finally {
    await fixture.cleanup();
    running = undefined;
  }
});
async function allPortsFree() {
  return (await Promise.all(devPorts.map(portAvailable))).every(Boolean);
}
async function stoppedWithoutCleanup() {
  await waitUntil(
    async () => (await ownedProcesses(fixture.root)).length === 0,
    '沒有殘留自有程序',
    20_000,
  );
  await waitUntil(allPortsFree, '釋放固定連接埠', 20_000);
}
async function responseContains(port: number, path: string, marker: string) {
  await waitUntil(async () => {
    try {
      const result = await request(port, path);
      return result.status === 200 && result.text.includes(marker);
    } catch {
      return false;
    }
  }, `HTTP可讀到${marker}`);
}

describe('real development supervisor', () => {
  it('starts fresh pnpm dev with paired API and all health endpoints, applies HTML/JSON/Core/UI/CSS watches, and stops on SIGTERM', async () => {
    for (const output of [
      'packages/core/dist/index.js',
      'packages/ui/dist/index.js',
      'server/dist/index.js',
      'site/dist/registry/fixed-pages.js',
    ])
      await expect(access(join(fixture.root, output))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    running = startDev(fixture.root, 'all');
    await running.readyOrFail();
    expect(await responds(4321)).toBe(true);
    expect(await responds(5173)).toBe(true);
    expect(await responds(3001, '/api/v1/health')).toBe(true);
    const proxied = await request(5173, '/api/v1/articles');
    expect(proxied.status).toBe(200);
    expect(JSON.parse(proxied.text)).toMatchObject({ total: 5 });
    expect((await request(3001, '/api/v1/articles')).status).toBe(403);
    const articles = await request(4321, '/articles/');
    expect(articles.status).toBe(200);
    const document = parse(articles.text);
    const documentBody = document.childNodes
      .flatMap((node) => ('childNodes' in node ? node.childNodes : []))
      .find((node) => node.nodeName === 'body');
    function islandAttributes(
      node: (typeof document.childNodes)[number],
    ): ReadonlyMap<string, string> | undefined {
      if ('tagName' in node && node.tagName === 'astro-island')
        return new Map(node.attrs.map((item) => [item.name, item.value]));
      if ('childNodes' in node)
        for (const child of node.childNodes) {
          const found = islandAttributes(child);
          if (found) return found;
        }
      return undefined;
    }
    const island = documentBody && islandAttributes(documentBody);
    expect(island, '正式dev入口應產生可hydrate的搜尋島').toBeDefined();
    for (const name of ['component-url', 'renderer-url']) {
      const path = island?.get(name);
      expect(path, `${name}應由正式Astro/Vite解析`).toBeTruthy();
      if (!path) throw new Error('DEV_SEARCH_ISLAND_MODULE_MISSING');
      const diagnostic =
        path.startsWith('/@id/') || path.startsWith('/src/')
          ? JSON.stringify(path)
          : '<Astro renderer module>';
      expect((await request(4321, path)).status, `${name}: ${diagnostic}`).toBe(
        200,
      );
    }

    const body = join(
      fixture.root,
      'content/articles/sample-article-basics/content.html',
    );
    const beforePreviewBody = await readFile(body);
    const metadataPath = join(
      fixture.root,
      'content/articles/sample-article-basics/meta.json',
    );
    const beforePreviewMetadata = await readFile(metadataPath);
    const currentArticle = ArticleResourceSchema.parse(
      JSON.parse(
        (await request(5173, '/api/v1/articles/sample-article-basics')).text,
      ),
    );
    const studioOrigin = 'http://127.0.0.1:5173';
    // 真正 pnpm dev 由 tsx 載入 source server；不能以 compiled fixture 代替。
    const createdPreview = await fetch(`${studioOrigin}/api/v1/previews`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: studioOrigin,
        'x-alfred-editor-id': randomUUID(),
      },
      body: JSON.stringify({
        articleId: currentArticle.id,
        contentHtml: currentArticle.contentHtml,
        meta: currentArticle.meta,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(createdPreview.status).toBe(201);
    const preview = PreviewResponseSchema.parse(await createdPreview.json());
    const previewDocument = await fetch(
      `${studioOrigin}${preview.documentUrl}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    expect(previewDocument.status).toBe(200);
    expect(previewDocument.headers.get('Content-Type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(previewDocument.headers.get('Content-Security-Policy')).toContain(
      "script-src 'none'",
    );
    expect(previewDocument.headers.get('Content-Security-Policy')).toContain(
      'sandbox',
    );
    const previewHtml = await previewDocument.text();
    expect(previewHtml).toContain('class="page-container article-page"');
    expect(previewHtml).toContain(currentArticle.meta.title);
    expect(previewHtml).toContain('/api/v1/preview-assets/styles.css');
    const previewStyles = await fetch(
      `${studioOrigin}/api/v1/preview-assets/styles.css`,
      { signal: AbortSignal.timeout(10_000) },
    );
    expect(previewStyles.status).toBe(200);
    expect(previewStyles.headers.get('Content-Type')).toBe(
      'text/css; charset=utf-8',
    );
    expect(await previewStyles.text()).toContain('.article-grid');
    expect(await readFile(body)).toEqual(beforePreviewBody);
    expect(await readFile(metadataPath)).toEqual(beforePreviewMetadata);
    await writeFile(
      body,
      (await readFile(body, 'utf8')) +
        '\n<p id="dev-body">DEV_BODY_WATCH</p>\n',
    );
    await responseContains(4321, '/notes/article-basics/', 'DEV_BODY_WATCH');
    const metadata = join(
      fixture.root,
      'content/articles/sample-article-basics/meta.json',
    );
    const meta: Record<string, unknown> = JSON.parse(
      await readFile(metadata, 'utf8'),
    );
    await writeFile(
      metadata,
      JSON.stringify({ ...meta, title: 'DEV_META_WATCH' }),
    );
    await responseContains(4321, '/notes/article-basics/', 'DEV_META_WATCH');
    await responseContains(
      5173,
      '/api/v1/articles/sample-article-basics',
      'DEV_META_WATCH',
    );

    const core = join(fixture.root, 'packages/core/src/seo/index.ts');
    const coreSource = await readFile(core, 'utf8');
    const template =
      'const template = defaults?.titleTemplate ?? site.defaultSEO.titleTemplate;';
    expect(coreSource).toContain(template);
    await writeFile(
      core,
      coreSource.replace(
        template,
        'const template = `DEV_CORE_WATCH ${defaults?.titleTemplate ?? site.defaultSEO.titleTemplate}`;',
      ),
    );
    await responseContains(4321, '/notes/article-basics/', 'DEV_CORE_WATCH');

    const ui = join(fixture.root, 'packages/ui/src/components/SiteFooter.tsx');
    const uiSource = await readFile(ui, 'utf8');
    expect(uiSource).toContain('訂閱 RSS');
    await writeFile(ui, uiSource.replace('訂閱 RSS', 'DEV_UI_WATCH RSS'));
    await responseContains(4321, '/', 'DEV_UI_WATCH RSS');

    const css = join(fixture.root, 'packages/ui/src/styles/index.css');
    await writeFile(
      css,
      (await readFile(css, 'utf8')) + '\n:root { --dev-css-watch: 314159; }\n',
    );
    await responseContains(
      4321,
      `/@fs${join(fixture.root, 'packages/ui/dist/styles/index.css')}?direct`,
      '--dev-css-watch: 314159',
    );
    expect(
      await readFile(
        join(fixture.root, 'packages/ui/dist/styles/index.css'),
        'utf8',
      ),
    ).toContain('--dev-css-watch: 314159');
    await waitUntil(
      () => responds(5173, '/api/v1/workspace'),
      '共用套件更新後API重新載入完成',
    );
    await responseContains(
      5173,
      '/api/v1/preview-assets/styles.css',
      '--dev-css-watch: 314159',
    );

    // 無效JSON不可繼續展示舊正文，修復後同一組服務恢復。
    const validMetadata = await readFile(metadata, 'utf8');
    await writeFile(metadata, '{');
    await waitUntil(async () => {
      try {
        const index: { status?: string } = JSON.parse(
          await readFile(
            join(fixture.root, '.foliohaven/dev/render/index.json'),
            'utf8',
          ),
        );
        return index.status === 'invalid';
      } catch {
        return false;
      }
    }, '無效來源明確標記invalid');
    expect((await request(4321, '/notes/article-basics/')).status).toBe(500);
    expect((await request(5173, '/api/v1/articles')).status).toBe(422);
    await writeFile(metadata, validMetadata);
    await responseContains(4321, '/notes/article-basics/', 'DEV_META_WATCH');
    await responseContains(
      5173,
      '/api/v1/articles/sample-article-basics',
      'DEV_META_WATCH',
    );
    expect((await running.stop()).code).toBe(0);
    await stoppedWithoutCleanup();
  }, 300_000);

  it('runs every documented scoped mode, rejects a conflicting port, and cleans children when a task or the supervisor is killed', async () => {
    // 即使只執行本案例，fresh Studio也必須能讀取正式樣本，不依賴另一案例先處理媒體。
    for (const mode of ['studio', 'server', 'site'] as const) {
      running = startDev(fixture.root, mode);
      await running.readyOrFail();
      expect(await responds(4321)).toBe(mode === 'site');
      expect(await responds(5173)).toBe(mode === 'studio');
      expect(await responds(3001, '/api/v1/health')).toBe(mode !== 'site');
      if (mode === 'studio')
        expect((await request(5173, '/api/v1/articles')).status).toBe(200);
      expect((await running.stop()).code).toBe(0);
      await stoppedWithoutCleanup();
    }

    const metadata = join(
      fixture.root,
      'content/articles/sample-article-basics/meta.json',
    );
    const validMetadata = await readFile(metadata, 'utf8');
    try {
      await writeFile(metadata, '{');
      running = startDev(fixture.root, 'studio');
      await running.readyOrFail();
      expect(await responds(5173)).toBe(true);
      expect(await responds(3001, '/api/v1/health')).toBe(true);
      expect(await responds(4321)).toBe(false);
      const invalidList = await request(5173, '/api/v1/articles');
      expect(invalidList.status).toBe(422);
      expect(
        ApiErrorSchema.parse(JSON.parse(invalidList.text)).error.issues.length,
      ).toBeGreaterThan(0);
      // 管理入口可用以修復來源，修正後同一組Studio/API即可重新讀取。
      await writeFile(metadata, validMetadata);
      await waitUntil(
        () => responds(5173, '/api/v1/articles'),
        '獨立Studio在來源修正後恢復列表',
      );
      expect((await running.stop()).code).toBe(0);
      await stoppedWithoutCleanup();
    } finally {
      await writeFile(metadata, validMetadata);
    }

    const blocker = createServer();
    await new Promise<void>((ready, reject) => {
      blocker.once('error', reject);
      blocker.listen(5173, '127.0.0.1', ready);
    });
    try {
      running = startDev(fixture.root, 'studio');
      await waitUntil(
        () => running?.exited === true,
        '衝突連接埠拒絕啟動',
        15_000,
      );
      expect((await running.done).code).not.toBe(0);
      expect(running.ready).toBe(false);
      expect(running.safeCodes).toContain('DEV_FAILED');
      expect(await portAvailable(3001)).toBe(true);
      expect(await responds(4321)).toBe(false);
    } finally {
      await new Promise<void>((complete) => blocker.close(() => complete()));
    }
    await stoppedWithoutCleanup();

    // 真正中間wrapper被SIGKILL時無法自行cleanup，Root仍須清其內層compiler及整組服務。
    running = startDev(fixture.root, 'all');
    await running.readyOrFail();
    await running.killTypesTask();
    await waitUntil(
      () => running?.exited === true,
      '中間開發子程序死亡',
      20_000,
    );
    expect((await running.done).code).not.toBe(0);
    expect(running.safeCodes).toContain('DEV_UNEXPECTED_EXIT');
    await stoppedWithoutCleanup();
    running = startDev(fixture.root, 'server');
    await running.readyOrFail();
    expect((await running.stop()).code).toBe(0);
    await stoppedWithoutCleanup();

    running = startDev(fixture.root, 'all');
    await running.readyOrFail();
    await running.signal('SIGKILL');
    await waitUntil(() => running?.exited === true, '父協調器死亡', 20_000);
    expect((await running.done).code).not.toBe(0);
    await stoppedWithoutCleanup();
    // SIGKILL釋放同一workspace鎖，後續正式入口仍可正常啟動與停止。
    running = startDev(fixture.root, 'server');
    await running.readyOrFail();
    expect((await running.stop()).code).toBe(0);
    await stoppedWithoutCleanup();
  }, 240_000);

  it('cleans a killed supervisor during fresh bootstrap and a killed render watcher during real native processing', async () => {
    await expect(
      access(join(fixture.root, 'packages/core/dist/index.js')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    running = startDev(fixture.root, 'all');
    await running.killDuringBootstrap();
    expect(running.ready).toBe(false);
    await waitUntil(
      () => running?.exited === true,
      'bootstrap期間父協調器死亡',
      20_000,
    );
    expect((await running.done).code).not.toBe(0);
    await stoppedWithoutCleanup();

    // 同一副本可從中斷的bootstrap恢復，不手動刪鎖、輸出或私有狀態。
    running = startDev(fixture.root, 'site');
    await running.readyOrFail();
    expect(await responds(4321)).toBe(true);
    await replaceSandboxVideo(fixture.root);
    await running.killRenderTaskDuringTranscode();
    await waitUntil(
      () => running?.exited === true,
      'render watch wrapper死亡',
      20_000,
    );
    expect((await running.done).code).not.toBe(0);
    expect(running.safeCodes).toContain('DEV_UNEXPECTED_EXIT');
    await stoppedWithoutCleanup();
  }, 180_000);
});
