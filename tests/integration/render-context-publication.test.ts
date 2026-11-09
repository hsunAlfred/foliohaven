import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UuidSchema } from '@foliohaven/core';
import type { RenderContextIndex } from '../../site/src/fixed-pages.js';
import {
  invalidateRenderContext,
  prepareRenderContext,
} from '../../server/src/build/render/context.js';

const publication = vi.hoisted(() => ({
  target: '',
  blocked: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
  fail: false,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === publication.target) {
        publication.entered?.();
        if (publication.fail)
          throw Object.assign(new Error('publication failed'), { code: 'EIO' });
        await publication.blocked;
      }
      return actual.rename(...args);
    }),
  };
});

const roots: string[] = [];
afterEach(async () => {
  publication.target = '';
  publication.blocked = undefined;
  publication.entered = undefined;
  publication.fail = false;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-context-publication-'));
  roots.push(root);
  for (const resource of [
    'content/articles/first',
    'content/pages',
    'media/source',
    'site/src/pages/articles',
    'site/src/pages/category',
    'site/src/pages/tag',
  ])
    await mkdir(join(root, resource), { recursive: true });
  const site = (name: string) => ({
    siteName: name,
    siteDescription: '呈現快照發布驗收',
    siteUrl: 'https://example.invalid/',
    author: { name: '作者' },
  });
  for (const [resource, value] of Object.entries({
    'content/site.json': JSON.stringify(site('第一代')),
    'content/categories.json': JSON.stringify([
      { path: 'notes', name: '筆記', description: '筆記分類' },
    ]),
    'content/tags.json': '[]',
    'content/articles/first/meta.json': JSON.stringify({
      status: 'published',
      title: '快照測試文章',
      slug: 'first',
      category: 'notes',
      publishedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      seo: { description: '驗證同一份公開內容的快照。' },
    }),
    'content/articles/first/content.html':
      '<h2 id="intro">快照測試</h2><p>公開內容。</p>',
    'site/src/pages/index.astro': '---\n---\n<p>home</p>',
    'site/src/pages/articles/index.astro': '---\n---\n<p>articles</p>',
    'site/src/pages/category/index.astro': '---\n---\n<p>categories</p>',
    'site/src/pages/tag/index.astro': '---\n---\n<p>tags</p>',
  }))
    await writeFile(join(root, resource), value);
  const context = join(root, '.foliohaven/render');
  return {
    root,
    context,
    prepare: () =>
      prepareRenderContext({ repositoryRoot: root, contextDirectory: context }),
    setName: (name: string) =>
      writeFile(join(root, 'content/site.json'), JSON.stringify(site(name))),
  };
}

async function index(context: string): Promise<RenderContextIndex> {
  return JSON.parse(
    await readFile(join(context, 'index.json'), 'utf8'),
  ) as RenderContextIndex;
}
async function completeGeneration(context: string, value: RenderContextIndex) {
  const generation = UuidSchema.parse(value.generation);
  const directory = join(context, 'generations', generation);
  for (const resource of [
    'index.json',
    'home.json',
    'search-index.json',
    ...value.articles.map((article) => article.file),
    ...value.lists.map((list) => list.file),
    ...Object.values(value.pages),
  ])
    expect(
      JSON.parse(await readFile(join(directory, resource), 'utf8')),
    ).toBeDefined();
  return directory;
}

describe('immutable render context publication', () => {
  it('keeps the stable root and old complete generation readable until atomic index publication, retaining every published generation', async () => {
    const f = await fixture();
    await f.prepare();
    const first = await index(f.context);
    const firstDirectory = await completeGeneration(f.context, first);
    const originalIndex = await readFile(join(f.context, 'index.json'));
    const originalHome = await readFile(join(firstDirectory, 'home.json'));
    const originalInode = (await lstat(f.context)).ino;
    await f.setName('第二代');
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      publication.entered = resolve;
    });
    publication.target = join(f.context, 'index.json');
    publication.blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.prepare();
    try {
      await entered;
      expect(await readFile(join(f.context, 'index.json'))).toEqual(
        originalIndex,
      );
      expect((await index(f.context)).site.siteName).toBe('第一代');
      expect(await readFile(join(firstDirectory, 'home.json'))).toEqual(
        originalHome,
      );
      const generations = await readdir(join(f.context, 'generations'));
      expect(generations).toHaveLength(2);
      const next = generations.find(
        (generation) => generation !== first.generation,
      );
      const candidate = await index(
        join(f.context, 'generations', next ?? 'missing'),
      );
      expect(candidate.site.siteName).toBe('第二代');
      await completeGeneration(f.context, candidate);
    } finally {
      release();
      await pending;
    }
    publication.blocked = undefined;
    const second = await index(f.context);
    expect(second.generation).not.toBe(first.generation);
    expect(second.site.siteName).toBe('第二代');
    await completeGeneration(f.context, second);
    await f.setName('第三代');
    const prepared = await f.prepare();
    expect(prepared.contextDirectory).toBe(f.context);
    const third = await index(f.context);
    expect(third.site.siteName).toBe('第三代');
    await completeGeneration(f.context, third);
    expect(await readdir(join(f.context, 'generations'))).toHaveLength(3);
    expect(await readFile(join(firstDirectory, 'home.json'))).toEqual(
      originalHome,
    );
    expect((await lstat(f.context)).ino).toBe(originalInode);
    expect(
      (await readdir(f.context)).filter(
        (name) =>
          name.startsWith('pending-') || name.startsWith('index-pending-'),
      ),
    ).toEqual([]);
  });

  it('cleans only its unpublished generation and temporary files when index publication fails', async () => {
    const f = await fixture();
    await f.prepare();
    const first = await index(f.context);
    await completeGeneration(f.context, first);
    const original = await readFile(join(f.context, 'index.json'));
    await f.setName('不應發布');
    publication.target = join(f.context, 'index.json');
    publication.fail = true;
    await expect(f.prepare()).rejects.toMatchObject({ code: 'EIO' });
    expect(await readFile(join(f.context, 'index.json'))).toEqual(original);
    expect(await readdir(join(f.context, 'generations'))).toEqual([
      first.generation,
    ]);
    await completeGeneration(f.context, first);
    expect(
      (await readdir(f.context)).filter(
        (name) =>
          name.startsWith('pending-') || name.startsWith('index-pending-'),
      ),
    ).toEqual([]);
  });

  it('publishes an invalid marker after a genuine source error and recovers only through a newly validated generation', async () => {
    const f = await fixture();
    await f.prepare();
    const first = await index(f.context);
    const original = await readFile(join(f.context, 'index.json'));
    const firstDirectory = await completeGeneration(f.context, first);
    const originalHome = await readFile(join(firstDirectory, 'home.json'));
    await writeFile(join(f.root, 'content/site.json'), 'invalid JSON');
    await expect(f.prepare()).rejects.toMatchObject({ code: 'INVALID_JSON' });
    expect(await readFile(join(f.context, 'index.json'))).toEqual(original);
    await invalidateRenderContext(f.root, f.context);
    expect(
      JSON.parse(await readFile(join(f.context, 'index.json'), 'utf8')),
    ).toEqual({
      schemaVersion: 1,
      status: 'invalid',
      code: 'SOURCE_VALIDATION_FAILED',
    });
    expect(await readFile(join(firstDirectory, 'home.json'))).toEqual(
      originalHome,
    );
    await f.setName('修正後');
    await f.prepare();
    const repaired = await index(f.context);
    expect(repaired.status).toBe('valid');
    expect(repaired.generation).not.toBe(first.generation);
    expect(repaired.site.siteName).toBe('修正後');
    await completeGeneration(f.context, repaired);
    expect(await readdir(join(f.context, 'generations'))).toHaveLength(2);
  });
});
