import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type * as FileSystem from 'node:fs/promises';
import {
  invalidateRenderContext,
  prepareRenderContext,
} from '../../server/src/build/render/context.js';
import {
  loadArticlePage,
  loadFixedPage,
  loadHomePage,
  loadListPage,
  loadNotFoundPage,
  loadRenderContext,
  loadSearchIndex,
} from '../../site/src/lib/server/context.js';

interface IoBarrier {
  readonly target: string;
  readonly reached: () => void;
  readonly released: Promise<void>;
}
const io = vi.hoisted(() => ({
  publication: null as IoBarrier | null,
  payload: null as IoBarrier | null,
  indexRead: null as IoBarrier | null,
  indexHandle: null as FileSystem.FileHandle | null,
  denied: null as string | null,
}));

// Only the selected fixture syscall is paused. All content validation and all
// other filesystem operations use the real implementations.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FileSystem>();
  const renameFile: typeof actual.rename = async (from, to) => {
    const barrier = io.publication;
    if (
      barrier &&
      (to === barrier.target || to === `${barrier.target}/index.json`)
    ) {
      io.publication = null;
      barrier.reached();
      await barrier.released;
    }
    return actual.rename(from, to);
  };
  const openFile: typeof actual.open = async (path, flags, mode) => {
    if (io.denied !== null && path === io.denied)
      throw Object.assign(new Error('Synthetic permission denial'), {
        code: 'EACCES',
      });
    const barrier = io.payload;
    if (barrier && path === barrier.target) {
      io.payload = null;
      barrier.reached();
      await barrier.released;
    }
    const handle = await actual.open(path, flags, mode);
    const indexBarrier = io.indexRead;
    if (indexBarrier && path === indexBarrier.target) {
      io.indexRead = null;
      io.indexHandle = handle;
      const read = handle.readFile.bind(handle);
      vi.spyOn(handle, 'readFile').mockImplementation(async (options) => {
        indexBarrier.reached();
        await indexBarrier.released;
        return read(options);
      });
    }
    return handle;
  };
  return { ...actual, rename: renameFile, open: openFile };
});

vi.mock('@foliohaven/site/registry', async () => {
  const { z } = await import('zod');
  const { FixedPageSchema } = await import('@foliohaven/core');
  return {
    fixedPages: [
      { id: 'home', path: '/', entry: 'src/pages/index.astro', seo: {} },
      {
        id: 'articles',
        path: '/articles/',
        entry: 'src/pages/articles/index.astro',
        seo: { title: 'Articles SEO', description: 'Article collection' },
      },
      {
        id: 'about',
        path: '/about/',
        entry: 'src/pages/about/index.astro',
        seo: { description: 'Independent fixed page' },
      },
    ].map((page) => FixedPageSchema.parse(page)),
    pageSchemas: {
      about: z.strictObject({
        heading: z.string().min(1),
        description: z.string().min(1),
      }),
    },
  };
});

interface Fixture {
  readonly root: string;
  readonly context: string;
}
type ContextIndex = Awaited<ReturnType<typeof loadRenderContext>> & {
  readonly generation?: string;
};
const roots: string[] = [];
const releases: (() => void)[] = [];
const pending = new Set<Promise<unknown>>();

function tracked<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  void work.then(
    () => pending.delete(work),
    () => pending.delete(work),
  );
  return work;
}

function barrier(
  kind: 'publication' | 'payload' | 'indexRead',
  target: string,
) {
  let signalReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  io[kind] = { target, reached: signalReached, released };
  return { reached, release };
}

afterEach(async () => {
  io.publication = null;
  io.payload = null;
  io.indexRead = null;
  io.indexHandle = null;
  io.denied = null;
  for (const release of releases.splice(0)) release();
  await Promise.allSettled([...pending]);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function atomicSource(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.pending-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

async function source(fixture: Fixture, marker: string) {
  const { root } = fixture;
  await atomicSource(join(root, 'content/site.json'), {
    siteName: `Context ${marker}`,
    siteDescription: `Site description ${marker}`,
    siteUrl: 'https://example.invalid/',
    author: { name: 'Synthetic author' },
    defaultSEO: { titleTemplate: '{title} | {siteName}' },
  });
  await atomicSource(join(root, 'content/categories.json'), [
    { path: 'notes', name: `Category ${marker}`, description: 'Notes' },
  ]);
  await atomicSource(join(root, 'content/tags.json'), [
    { slug: 'example', name: `Tag ${marker}`, description: 'Example' },
  ]);
  await atomicSource(join(root, 'content/pages/about.json'), {
    heading: `About ${marker}`,
    description: `Page data ${marker}`,
  });
  await atomicSource(join(root, 'content/articles/entry/meta.json'), {
    status: 'published',
    title: `Article ${marker}`,
    slug: 'entry',
    category: 'notes',
    tags: ['example'],
    publishedAt: '2026-10-24T09:00:00+08:00',
    updatedAt: '2026-10-24T09:00:00+08:00',
    seo: { description: `Article description ${marker}` },
  });
  await writeFile(
    join(root, 'content/articles/entry/content.html'),
    `<h2 id="body">Body ${marker}</h2><p>Complete synthetic content.</p>`,
  );
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'alfred-render-context-refresh-'));
  roots.push(root);
  const value = { root, context: join(root, '.foliohaven/dev/render') };
  for (const entry of [
    'index.astro',
    'articles/index.astro',
    'about/index.astro',
  ]) {
    const file = join(root, 'site/src/pages', entry);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '<p>Synthetic fixed entry</p>');
  }
  await source(value, 'A');
  vi.stubEnv('ALFRED_RENDER_CONTEXT', value.context);
  return value;
}

async function publish(value: Fixture, marker?: string) {
  if (marker) await source(value, marker);
  return prepareRenderContext({
    repositoryRoot: value.root,
    contextDirectory: value.context,
  });
}

async function index(value: Fixture): Promise<ContextIndex> {
  return JSON.parse(
    await readFile(join(value.context, 'index.json'), 'utf8'),
  ) as ContextIndex;
}

function payloadDirectory(value: Fixture, current: ContextIndex) {
  return current.generation
    ? join(value.context, 'generations', current.generation)
    : value.context;
}

function expectFixed(
  value: Awaited<ReturnType<typeof loadFixedPage>>,
  marker: string,
) {
  expect(value).toMatchObject({
    site: {
      siteName: `Context ${marker}`,
      rssUrl: 'https://example.invalid/rss.xml',
    },
    seo: { title: `about | Context ${marker}` },
    data: { heading: `About ${marker}`, description: `Page data ${marker}` },
  });
}

const loaders = [
  {
    name: 'home',
    file: (_index: ContextIndex) => 'home.json',
    read: loadHomePage,
    check: (value: unknown, marker: string) => {
      expect(value).toMatchObject({ site: { siteName: `Context ${marker}` } });
      expect(JSON.stringify(value)).toContain(`Article ${marker}`);
    },
  },
  {
    name: 'article',
    file: (current: ContextIndex) => {
      const file = current.articles.find(
        (article) => article.id === 'entry',
      )?.file;
      if (!file) throw new Error('Missing fixture article');
      return file;
    },
    read: () => loadArticlePage('entry'),
    check: (value: unknown, marker: string) =>
      expect(value).toMatchObject({
        site: { siteName: `Context ${marker}` },
        meta: { title: `Article ${marker}` },
      }),
  },
  {
    name: 'list',
    file: (current: ContextIndex) => {
      const file = current.lists.find(
        (list) => list.url === '/category/notes/',
      )?.file;
      if (!file) throw new Error('Missing fixture list');
      return file;
    },
    read: () => loadListPage('/category/notes/'),
    check: (value: unknown, marker: string) => {
      expect(value).toMatchObject({ site: { siteName: `Context ${marker}` } });
      expect(JSON.stringify(value)).toContain(`Article ${marker}`);
    },
  },
  {
    name: 'fixed page',
    file: (_index: ContextIndex) => 'home.json',
    read: () => loadFixedPage('about'),
    check: (value: unknown, marker: string) => {
      expect(value).toMatchObject({
        site: {
          siteName: `Context ${marker}`,
          rssUrl: 'https://example.invalid/rss.xml',
        },
        seo: { title: `about | Context ${marker}` },
        data: {
          heading: `About ${marker}`,
          description: `Page data ${marker}`,
        },
      });
    },
  },
  {
    name: '404',
    file: (_index: ContextIndex) => 'home.json',
    read: loadNotFoundPage,
    check: (value: unknown, marker: string) =>
      expect(value).toMatchObject({
        site: {
          siteName: `Context ${marker}`,
          rssUrl: 'https://example.invalid/rss.xml',
        },
        seo: {
          openGraph: { siteName: `Context ${marker}` },
          robots: 'noindex,follow',
        },
      }),
  },
  {
    name: 'search',
    file: (_index: ContextIndex) => 'search-index.json',
    read: loadSearchIndex,
    check: (value: unknown, marker: string) =>
      expect(JSON.stringify(value)).toContain(`Article ${marker}`),
  },
] as const;

describe('render context refresh publication and loader consistency', () => {
  it('reads one opened index inode across publication even when unlink changes its ctime', async () => {
    const value = await fixture();
    await publish(value);
    const paused = barrier('indexRead', join(value.context, 'index.json'));
    const reading = tracked(loadHomePage());
    await Promise.race([
      paused.reached,
      reading.then(() => {
        throw new Error(
          'Reader finished without reaching its index read barrier',
        );
      }),
    ]);
    const handle = io.indexHandle;
    if (!handle) throw new Error('The index handle was not captured');
    try {
      const before = await handle.stat({ bigint: true });
      await publish(value, 'B');
      const after = await handle.stat({ bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.ctimeNs).not.toBe(before.ctimeNs);
    } finally {
      paused.release();
    }
    expect(await reading).toMatchObject({ site: { siteName: 'Context A' } });
    expect(await loadHomePage()).toMatchObject({
      site: { siteName: 'Context B' },
    });
  });

  it('keeps a valid context readable while a complete replacement waits to publish', async () => {
    const value = await fixture();
    await publish(value);
    const before = await index(value);
    const beforeBytes = await readFile(join(value.context, 'index.json'));
    expect(before.generation).toMatch(/^[0-9a-f-]{36}$/u);
    const paused = barrier('publication', value.context);
    const refreshing = tracked(publish(value, 'B'));
    await Promise.race([
      paused.reached,
      refreshing.then(() => {
        throw new Error('Publisher finished without reaching its barrier');
      }),
    ]);
    try {
      expect(await readFile(join(value.context, 'index.json'))).toEqual(
        beforeBytes,
      );
      for (const loader of loaders) loader.check(await loader.read(), 'A');
      expectFixed(await loadFixedPage('about'), 'A');
    } finally {
      paused.release();
      await refreshing;
    }
    const after = await index(value);
    expect(after.generation).toMatch(/^[0-9a-f-]{36}$/u);
    expect(after.generation).not.toBe(before.generation);
    for (const loader of loaders) loader.check(await loader.read(), 'B');
    expectFixed(await loadFixedPage('about'), 'B');
  });

  it.each(loaders)(
    'pins one immutable generation for the $name loader across B/C publication',
    async (loader) => {
      const value = await fixture();
      await publish(value);
      const first = await index(value);
      const directory = payloadDirectory(value, first);
      const paused = barrier('payload', join(directory, loader.file(first)));
      const reading = tracked(loader.read());
      await Promise.race([
        paused.reached,
        reading.then(() => {
          throw new Error(
            'Reader finished without reaching its payload barrier',
          );
        }),
      ]);
      try {
        await publish(value, 'B');
        await publish(value, 'C');
        expect((await readdir(join(value.context, 'generations'))).length).toBe(
          3,
        );
        expect(
          await readFile(join(directory, loader.file(first))),
        ).not.toHaveLength(0);
      } finally {
        paused.release();
      }
      loader.check(await reading, 'A');
      loader.check(await loader.read(), 'C');
    },
  );

  it('rejects every new loader after actual source validation fails and recovers without restarting', async () => {
    const value = await fixture();
    await publish(value);
    const old = await index(value);
    for (const loader of loaders) loader.check(await loader.read(), 'A');
    await writeFile(join(value.root, 'content/site.json'), '{');
    await expect(publish(value)).rejects.toMatchObject({
      code: 'INVALID_JSON',
    });
    await invalidateRenderContext(value.root, value.context);
    expect(await index(value)).toMatchObject({ status: 'invalid' });
    await expect(loadRenderContext()).rejects.toThrow('RENDER_CONTEXT_INVALID');
    for (const loader of loaders)
      await expect(loader.read()).rejects.toThrow('RENDER_CONTEXT_INVALID');
    expect(
      await readFile(join(payloadDirectory(value, old), 'home.json')),
    ).not.toHaveLength(0);
    await publish(value, 'D');
    for (const loader of loaders) loader.check(await loader.read(), 'D');
    expectFixed(await loadFixedPage('about'), 'D');
  });

  it('reads legacy flat contexts without rewriting them and upgrades to a generation on publish', async () => {
    const value = await fixture();
    await publish(value);
    const current = await index(value);
    const directory = payloadDirectory(value, current);
    for (const file of await readdir(directory))
      await cp(join(directory, file), join(value.context, file), {
        recursive: true,
      });
    const legacy = { ...current };
    delete legacy.generation;
    await atomicSource(join(value.context, 'index.json'), legacy);
    const bytes = await readFile(join(value.context, 'index.json'));
    for (const loader of loaders) loader.check(await loader.read(), 'A');
    expectFixed(await loadFixedPage('about'), 'A');
    expect(await readFile(join(value.context, 'index.json'))).toEqual(bytes);
    await publish(value, 'B');
    expect((await index(value)).generation).toMatch(/^[0-9a-f-]{36}$/u);
    expectFixed(await loadFixedPage('about'), 'B');
  });

  it.each([
    '../escape',
    '/absolute',
    'not-a-uuid',
    'generations/child',
    '..\\escape',
  ])(
    'rejects an invalid generation reference %j without falling back',
    async (generation) => {
      const value = await fixture();
      await publish(value);
      await atomicSource(join(value.context, 'index.json'), {
        ...(await index(value)),
        generation,
      });
      await expect(loadHomePage()).rejects.toThrow('RENDER_CONTEXT_INVALID');
    },
  );

  it.each([
    'missing',
    'malformed',
    'permission',
    'leaf-symlink',
    'generation-symlink',
    'parent-symlink',
  ])(
    'rejects %s payload storage even with a readable legacy copy',
    async (kind) => {
      const value = await fixture();
      await publish(value);
      const current = await index(value);
      const directory = payloadDirectory(value, current);
      const home = join(directory, 'home.json');
      await cp(home, join(value.context, 'home.json'));
      await loadHomePage(); // Warm the index cache before changing the filesystem.
      if (kind === 'missing') await rm(home);
      else if (kind === 'malformed') await writeFile(home, '{');
      else if (kind === 'permission') io.denied = home;
      else if (kind === 'leaf-symlink') {
        const target = join(directory, 'another-home.json');
        await rename(home, target);
        await symlink(target, home);
      } else if (kind === 'generation-symlink') {
        const target = join(value.root, '.foliohaven/retained-generation');
        await rename(directory, target);
        await symlink(target, directory, 'dir');
      } else {
        const generations = join(value.context, 'generations');
        const target = join(value.root, '.foliohaven/retained-generations');
        await rename(generations, target);
        await symlink(target, generations, 'dir');
      }
      await expect(loadHomePage()).rejects.toThrow('RENDER_CONTEXT_INVALID');
    },
  );

  it('rejects an internal article-directory symlink and malformed top-level JSON', async () => {
    const value = await fixture();
    await publish(value);
    const current = await index(value);
    const directory = payloadDirectory(value, current);
    const articles = join(directory, 'articles');
    const target = join(directory, 'redirected-articles');
    await rename(articles, target);
    await symlink(target, articles, 'dir');
    await expect(loadArticlePage('entry')).rejects.toThrow(
      'RENDER_CONTEXT_INVALID',
    );
    await writeFile(join(value.context, 'index.json'), '{');
    await expect(loadRenderContext()).rejects.toThrow('RENDER_CONTEXT_INVALID');
  });
});
