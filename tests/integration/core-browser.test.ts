import { expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '@playwright/test';

it('Core公開入口實際打包並在瀏覽器執行，沒有Node或native依賴', async () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const parent = join(repository, '.alfred/environment-checks');
  await mkdir(parent, { recursive: true });
  const probe = await mkdtemp(join(parent, 'core-browser-'));
  let browser;
  try {
    const entry = join(probe, 'probe.ts');
    await writeFile(
      entry,
      `
import * as core from '@foliohaven/core';
const html = core.analyzeHtml('<h2 id="章節">繁體中文</h2><p>內容</p>');
document.body.dataset.toc = html.toc[0]?.text;
document.body.dataset.search = core.normalizeSearchQuery(' Ａ  工具 ');
document.body.dataset.exports = Object.keys(core).join(',');
document.body.dataset.errors = String(html.diagnostics.filter(d => d.severity === 'error').length);
`,
    );
    await build({
      configFile: false,
      root: probe,
      logLevel: 'error',
      build: {
        lib: { entry, formats: ['es'], fileName: 'probe' },
        outDir: join(probe, 'output'),
        emptyOutDir: true,
        minify: false,
        sourcemap: false,
      },
    });
    const scripts = (await readdir(join(probe, 'output'))).filter((name) =>
      /\.(?:mjs|js)$/.test(name),
    );
    expect(scripts).toHaveLength(1);
    const bundle = await readFile(
      join(probe, 'output', scripts[0] ?? ''),
      'utf8',
    );
    expect(bundle).not.toMatch(
      /node:(?:fs|path|child_process|process)|__vite-browser-external|@(?:alfred-wiki|foliohaven)\/server/,
    );
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setContent(
      '<!doctype html><html lang="zh-Hant"><body></body></html>',
    );
    await page.addScriptTag({ type: 'module', content: bundle });
    await expect
      .poll(() => page.locator('body').getAttribute('data-toc'))
      .toBe('繁體中文');
    expect(await page.locator('body').getAttribute('data-search')).toBe(
      'a 工具',
    );
    expect(await page.locator('body').getAttribute('data-errors')).toBe('0');
    expect(await page.locator('body').getAttribute('data-exports')).toContain(
      'buildSiteModel',
    );
    expect(pageErrors).toEqual([]);
    await context.close();
  } finally {
    await browser?.close();
    await rm(probe, { recursive: true, force: true });
  }
});
