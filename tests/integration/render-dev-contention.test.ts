import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareRenderContext } from '../../server/src/build/render/context.js';
import { acquireFileLease } from '../../server/src/runtime/lease.js';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../server/src/runtime/environment.js';
import type { RenderContextIndex } from '@foliohaven/site/registry';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];
const cancellations: AbortController[] = [];
const pending = new Set<Promise<unknown>>();
function tracked<T>(promise: Promise<T>) {
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
  return promise;
}
function closed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', () => resolve());
  });
}
async function until<T>(
  probe: () => Promise<T | null>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = await probe();
    if (value !== null) return value;
    await delay(10);
  } while (performance.now() < deadline);
  throw new Error('Isolated contention barrier was not reached');
}
afterEach(async () => {
  for (const controller of cancellations.splice(0)) controller.abort();
  await Promise.allSettled([...pending]);
  for (const child of children.splice(0)) {
    child.kill('SIGTERM');
    await closed(child);
  }
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
  seo: { description: '驗證忙碌來源鎖不會使完整預覽失效。' },
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-render-contention-'));
  roots.push(root);
  for (const path of [
    'scripts',
    'content/articles/entry',
    'content/pages',
    'media/source',
    'site/src/pages/articles',
    'site/src/pages/category',
    'site/src/pages/tag',
    'node_modules/@foliohaven',
  ])
    await mkdir(join(root, path), { recursive: true });
  await symlink(
    join(repository, 'server'),
    join(root, 'node_modules/@foliohaven/server'),
    'dir',
  );
  const files: Readonly<Record<string, string>> = {
    'package.json': JSON.stringify({ type: 'module' }),
    'content/site.json': JSON.stringify({
      siteName: '鎖等待驗收',
      siteDescription: '完整來源',
      siteUrl: 'https://example.invalid/',
      author: { name: 'Fixture' },
    }),
    'content/categories.json': JSON.stringify([
      { path: 'notes', name: '筆記', description: '來源鎖驗收' },
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
  for (const script of ['render-dev.mjs', 'workspace-paths.mjs'])
    await cp(
      join(repository, 'scripts', script),
      join(root, 'scripts', script),
    );
  const contextDirectory = join(root, '.foliohaven/dev/render');
  await prepareRenderContext({ repositoryRoot: root, contextDirectory });
  return {
    root,
    contextDirectory,
    index: join(contextDirectory, 'index.json'),
  };
}
async function writer(root: string, update = false) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import{acquireFileLease}from ${JSON.stringify(join(repository, 'server/dist/runtime/lease.js'))};
import{writeFile}from'node:fs/promises';
import{join}from'node:path';
const root=process.argv[1];
const lease=await acquireFileLease({root,name:'writer',owner:'isolated-writer'});
${update ? `await writeFile(join(root,'content/articles/entry/meta.json'),${JSON.stringify(JSON.stringify(meta('完整新版標題')))});await writeFile(join(root,'content/articles/entry/content.html'),'<h2 id="new">完整新版正文</h2>');` : ''}
process.stdin.once('data',async()=>{await lease.release();process.stdin.pause();});
process.stdout.write('ready\\n');
`,
      root,
    ],
    { stdio: ['pipe', 'pipe', 'ignore'], env: buildProcessEnvironment() },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', () =>
      reject(new Error('Isolated writer exited before barrier')),
    );
  });
  return child;
}
async function ownedWriterDescriptors(root: string): Promise<string[]> {
  const target = join(root, '.foliohaven/locks/writer.lock');
  const fds: string[] = [];
  for (const fd of await readdir(`/proc/${process.pid}/fd`)) {
    try {
      if ((await readlink(`/proc/${process.pid}/fd/${fd}`)) === target)
        fds.push(fd);
    } catch {
      // Reading /proc may race with unrelated closed descriptors.
    }
  }
  return fds;
}
async function blockedWriterHelper(root: string): Promise<number | null> {
  const ids = (
    await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  for (const id of ids) {
    try {
      const command = await readFile(`/proc/${id}/cmdline`, 'utf8');
      if (
        command.startsWith('flock\0') &&
        (await readlink(`/proc/${id}/fd/3`)) ===
          join(root, '.foliohaven/locks/writer.lock')
      )
        return Number(id);
    } catch {
      // A helper may complete while another child is inspected.
    }
  }
  return null;
}

describe('development rendering coordinates real writer contention', () => {
  it('waits beyond the unchanged ten-second lock timeout and publishes the complete new generation', async () => {
    const f = await fixture();
    const original = await readFile(f.index);
    const holder = await writer(f.root, true);
    const controller = new AbortController();
    cancellations.push(controller);
    let output = '';
    let waiting: () => void = () => undefined;
    const observed = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const started = performance.now();
    const running = tracked(
      runControlledProcess({
        command: process.execPath,
        args: ['scripts/render-dev.mjs'],
        cwd: f.root,
        env: buildProcessEnvironment(),
        timeoutMs: 30_000,
        signal: controller.signal,
        onOutput: (_stream, bytes) => {
          output += bytes.toString('utf8');
          if (output.includes('"waiting":true')) waiting();
        },
      }),
    );
    await Promise.race([
      observed,
      running.then(() => {
        throw new Error('Watcher exited without contention');
      }),
    ]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
    expect(await readFile(f.index)).toEqual(original);
    expect(holder.exitCode).toBeNull();
    expect(holder.signalCode).toBeNull();
    holder.stdin?.end('release\n');
    await closed(holder);
    const updated = await until(async () => {
      const value = await readFile(f.index, 'utf8');
      return value === original.toString('utf8')
        ? null
        : (JSON.parse(value) as RenderContextIndex);
    });
    expect(updated.status).toBe('valid');
    const article = updated.articles.find((item) => item.id === 'entry');
    expect(article).toBeDefined();
    expect(
      JSON.parse(
        await readFile(
          join(
            f.contextDirectory,
            'generations',
            updated.generation ?? '',
            article?.file ?? 'missing',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({
      meta: { title: '完整新版標題' },
      contentHtml: '<h2 id="new">完整新版正文</h2>',
    });
    expect(output).toMatch(/"code":"WORKSPACE_BUSY".*"waiting":true/u);
    expect(output).not.toMatch(
      /PROCESS_EXITED|INVALID_JSON|RENDER_PREPARE_FAILED|retryExhausted/,
    );
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'PROCESS_CANCELLED' });
  });
  it('cancels an actual blocked flock promptly, closes its handle, and leaves the foreign writer and old index intact', async () => {
    const f = await fixture();
    const original = await readFile(f.index);
    const holder = await writer(f.root);
    const controller = new AbortController();
    cancellations.push(controller);
    expect(await ownedWriterDescriptors(f.root)).toEqual([]);
    const reading = tracked(
      prepareRenderContext({
        repositoryRoot: f.root,
        contextDirectory: f.contextDirectory,
        signal: controller.signal,
      }),
    );
    const waiter = await until(() => blockedWriterHelper(f.root));
    expect(await ownedWriterDescriptors(f.root)).toHaveLength(1);
    const started = performance.now();
    controller.abort();
    await expect(reading).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await ownedWriterDescriptors(f.root)).toEqual([]);
    await expect(readFile(`/proc/${waiter}/cmdline`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(holder.exitCode).toBeNull();
    expect(holder.signalCode).toBeNull();
    expect(await readFile(f.index)).toEqual(original);
    expect(
      await acquireFileLease({
        root: f.root,
        name: 'writer',
        owner: 'non-stealing-probe',
        nonBlocking: true,
      }),
    ).toBeNull();
    holder.stdin?.end('release\n');
    await closed(holder);
    const probe = await acquireFileLease({
      root: f.root,
      name: 'writer',
      owner: 'post-cancel-probe',
      nonBlocking: true,
    });
    expect(probe).not.toBeNull();
    await probe?.release();
    expect(await ownedWriterDescriptors(f.root)).toEqual([]);
  });
});
