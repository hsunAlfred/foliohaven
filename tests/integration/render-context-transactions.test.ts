import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContent } from '@foliohaven/core/node';
import type { RenderContextIndex } from '@foliohaven/site/registry';
import { FileRepository } from '../../server/src/files/repository.js';
import type { FaultPhase } from '../../server/src/files/types.js';
import {
  invalidateRenderContext,
  prepareRenderContext,
} from '../../server/src/build/render/context.js';
import { loadRenderContext } from '../../site/src/lib/server/context.js';
import type * as Lock from '../../server/src/files/lock.js';

const observation = vi.hoisted(() => ({
  requested: null as (() => void) | null,
}));
vi.mock('../../server/src/files/lock.js', async (original) => {
  const actual = await original<typeof Lock>();
  return {
    ...actual,
    acquireRepositoryLock: async (
      ...args: Parameters<typeof actual.acquireRepositoryLock>
    ) => {
      observation.requested?.();
      return actual.acquireRepositoryLock(...args);
    },
  };
});
const roots: string[] = [];
const releases: (() => void)[] = [];
const pending = new Set<Promise<unknown>>();
function tracked<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
  return promise;
}
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  observation.requested = null;
  for (const release of releases.splice(0)) release();
  await Promise.allSettled([...pending]);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const meta = (title: string) => ({
  status: 'published',
  title,
  slug: 'entry',
  category: 'notes',
  publishedAt: '2026-10-25T00:00:00+08:00',
  updatedAt: '2026-10-25T00:00:00+08:00',
  seo: { description: '驗證合法交易與呈現來源的一致讀取。' },
});
const digest = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-context-transaction-'));
  roots.push(root);
  for (const path of [
    'content/articles/entry',
    'content/pages',
    'media/source',
    'site/src/pages/articles',
    'site/src/pages/category',
    'site/src/pages/tag',
  ])
    await mkdir(join(root, path), { recursive: true });
  const files: Readonly<Record<string, string>> = {
    'content/site.json': JSON.stringify({
      siteName: '交易驗收',
      siteDescription: '一致來源讀取',
      siteUrl: 'https://example.invalid/',
      author: { name: 'Fixture' },
    }),
    'content/categories.json': JSON.stringify([
      { path: 'notes', name: '筆記', description: '合法來源' },
    ]),
    'content/tags.json': '[]',
    'content/articles/entry/meta.json': JSON.stringify(meta('完整舊標題')),
    'content/articles/entry/content.html': '<h2 id="old">完整舊正文</h2>',
    'site/src/pages/index.astro': '<p>home</p>',
    'site/src/pages/articles/index.astro': '<p>articles</p>',
    'site/src/pages/category/index.astro': '<p>categories</p>',
    'site/src/pages/tag/index.astro': '<p>tags</p>',
  };
  for (const [path, value] of Object.entries(files))
    await writeFile(join(root, path), value);
  const context = join(root, '.foliohaven/dev/render');
  return {
    root,
    context,
    prepare: () =>
      prepareRenderContext({ repositoryRoot: root, contextDirectory: context }),
  };
}
async function observedRead(f: Awaited<ReturnType<typeof fixture>>) {
  const requested = deferred();
  observation.requested = requested.resolve;
  let completed = false;
  const reading = tracked(
    f.prepare().then((value) => {
      completed = true;
      return value;
    }),
  );
  await Promise.race([
    requested.promise,
    reading.then(() => {
      throw new Error('render completed without the writer gate');
    }),
  ]);
  expect(completed).toBe(false);
  observation.requested = null;
  return { reading };
}
async function index(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<RenderContextIndex> {
  return JSON.parse(
    await readFile(join(f.context, 'index.json'), 'utf8'),
  ) as RenderContextIndex;
}
async function article(f: Awaited<ReturnType<typeof fixture>>, id = 'entry') {
  const current = await index(f);
  const item = current.articles.find((value) => value.id === id);
  expect(item).toBeDefined();
  return JSON.parse(
    await readFile(
      join(
        f.context,
        'generations',
        current.generation ?? '',
        item?.file ?? 'missing',
      ),
      'utf8',
    ),
  ) as { meta: { title: string }; contentHtml: string };
}

describe('render context waits for complete managed transactions', () => {
  it.each(['before-install-link', 'after-install'] as const)(
    'waits across a newly created article at %s instead of invalidating partial files',
    async (phase) => {
      const f = await fixture();
      await f.prepare();
      const old = await readFile(join(f.context, 'index.json'));
      const entered = deferred(),
        gate = deferred();
      releases.push(gate.resolve);
      const htmlKey = 'content/articles/created/content.html';
      const metaKey = 'content/articles/created/meta.json';
      const writer = new FileRepository({
        repositoryRoot: f.root,
        fault: async (event) => {
          if (event.phase === phase && event.resourceKey === htmlKey) {
            entered.resolve();
            await gate.promise;
          }
        },
      });
      const saving = tracked(
        writer.commit({
          kind: 'create',
          changes: [
            {
              resourceKey: htmlKey,
              expectedRevision: null,
              content: Buffer.from('<h2 id="new">完整新增正文</h2>'),
            },
            {
              resourceKey: metaKey,
              expectedRevision: null,
              content: Buffer.from(
                JSON.stringify({ ...meta('完整新增文章'), slug: 'created' }),
              ),
            },
          ],
        }),
      );
      await Promise.race([
        entered.promise,
        saving.then(() => {
          throw new Error('writer completed before barrier');
        }),
      ]);
      const { reading } = await observedRead(f);
      await expect(
        loadContent(f.root, { mode: 'public' }),
      ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
      expect(await readFile(join(f.context, 'index.json'))).toEqual(old);
      gate.resolve();
      await saving;
      await reading;
      expect((await index(f)).status).toBe('valid');
      expect(await article(f, 'created')).toMatchObject({
        meta: { title: '完整新增文章' },
        contentHtml: '<h2 id="new">完整新增正文</h2>',
      });
    },
  );
  it.each(['after-displace', 'after-install'] as const)(
    'waits for both body and metadata of an update at %s',
    async (phase) => {
      const f = await fixture();
      await f.prepare();
      const old = await readFile(join(f.context, 'index.json'));
      const entered = deferred(),
        gate = deferred();
      releases.push(gate.resolve);
      const keys = [
        'content/articles/entry/content.html',
        'content/articles/entry/meta.json',
      ] as const;
      const writer = new FileRepository({
        repositoryRoot: f.root,
        fault: async (event) => {
          if (event.phase === phase && event.resourceKey === keys[1]) {
            entered.resolve();
            await gate.promise;
          }
        },
      });
      const before = await Promise.all(
        keys.map((key) => readFile(join(f.root, key))),
      );
      const values = [
        '<h2 id="new">完整新版正文</h2>',
        JSON.stringify(meta('完整新版標題')),
      ];
      const precondition = await writer.withConsistentRead(async (session) => ({
        ifMatch: await session.etag(keys),
        resourceKeys: keys,
      }));
      const saving = tracked(
        writer.commit({
          kind: 'save',
          precondition,
          changes: keys.map((resourceKey, i) => ({
            resourceKey,
            expectedRevision: digest(before[i] ?? Buffer.alloc(0)),
            content: Buffer.from(values[i] ?? ''),
          })),
        }),
      );
      await Promise.race([
        entered.promise,
        saving.then(() => {
          throw new Error('writer completed before barrier');
        }),
      ]);
      const { reading } = await observedRead(f);
      if (phase === 'after-displace')
        await expect(
          loadContent(f.root, { mode: 'public' }),
        ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
      expect(await readFile(join(f.context, 'index.json'))).toEqual(old);
      gate.resolve();
      await saving;
      await reading;
      expect(await article(f)).toMatchObject({
        meta: { title: '完整新版標題' },
        contentHtml: '<h2 id="new">完整新版正文</h2>',
      });
    },
  );
  it('reads the complete original after a prepared transaction fails and rolls back', async () => {
    const f = await fixture();
    await f.prepare();
    const beforeIndex = await readFile(join(f.context, 'index.json'));
    const entered = deferred(),
      gate = deferred();
    releases.push(gate.resolve);
    const phase: FaultPhase = 'prepared-journal';
    const key = 'content/articles/entry/meta.json';
    const before = await readFile(join(f.root, key));
    const writer = new FileRepository({
      repositoryRoot: f.root,
      fault: async (event) => {
        if (event.phase === phase) {
          entered.resolve();
          await gate.promise;
          throw Object.assign(new Error('fixture prepared write failed'), {
            code: 'ENOSPC',
          });
        }
      },
    });
    const precondition = await writer.withConsistentRead(async (session) => ({
      ifMatch: await session.etag([key]),
      resourceKeys: [key],
    }));
    const saving = tracked(
      writer.commit({
        kind: 'save',
        precondition,
        changes: [
          {
            resourceKey: key,
            expectedRevision: digest(before),
            content: Buffer.from(JSON.stringify(meta('不可發布候選'))),
          },
        ],
      }),
    );
    const failure = expect(saving).rejects.toMatchObject({ code: 'ENOSPC' });
    await Promise.race([
      entered.promise,
      saving.then(() => {
        throw new Error('writer completed before barrier');
      }),
    ]);
    const { reading } = await observedRead(f);
    expect(await readFile(join(f.context, 'index.json'))).toEqual(beforeIndex);
    gate.resolve();
    await failure;
    await reading;
    expect(await readFile(join(f.root, key))).toEqual(before);
    expect(await article(f)).toMatchObject({
      meta: { title: '完整舊標題' },
      contentHtml: '<h2 id="old">完整舊正文</h2>',
    });
    expect((await writer.initialize()).recoveryState).toBe('ready');
  });
  it('still rejects genuinely invalid committed source and only recovers after validation succeeds', async () => {
    const f = await fixture();
    await f.prepare();
    const original = await index(f);
    const key = join(f.root, 'content/articles/entry/meta.json');
    await writeFile(key, '{ invalid JSON');
    await expect(f.prepare()).rejects.toMatchObject({ code: 'INVALID_JSON' });
    await invalidateRenderContext(f.root, f.context);
    vi.stubEnv('ALFRED_RENDER_CONTEXT', f.context);
    await expect(loadRenderContext()).rejects.toThrow('RENDER_CONTEXT_INVALID');
    await writeFile(key, JSON.stringify(meta('已修復標題')));
    await f.prepare();
    expect((await index(f)).generation).not.toBe(original.generation);
    expect((await loadRenderContext()).status).toBe('valid');
    expect(await article(f)).toMatchObject({ meta: { title: '已修復標題' } });
  });
});
