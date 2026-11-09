import { afterEach, it, expect, vi } from 'vitest';
import {
  lstat,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { ArtifactStore } from '../../server/src/build/artifacts/index.js';
import { parseArtifactJournal } from '../../server/src/build/artifacts/journal.js';
import * as artifactTree from '../../server/src/build/artifacts/tree.js';
import { acquireFileLease } from '../../server/src/runtime/lease.js';
import { createStaticPreview } from '../../server/src/static-preview/index.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const revision = 'a'.repeat(64);
async function fixture(large = false) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-static-preview-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore({ repositoryRoot: root });
  const id = randomUUID();
  const output = `.foliohaven/builds/${id}/output`;
  await mkdir(join(root, output, 'notes'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, output, 'assets'), { mode: 0o700 });
  for (const [path, value] of Object.entries({
    'index.html': '<!doctype html><title>Previous success</title>',
    'notes/index.html': '<!doctype html><title>Notes</title>',
    '404.html': '<!doctype html><title>Missing page</title>',
    'assets/style.css': 'body{color:#123}',
    'assets/app.js': 'export const value=1;',
  }))
    await writeFile(join(root, output, path), value);
  const video = large
    ? Buffer.alloc(32 * 1024 * 1024, 7)
    : Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
  await writeFile(join(root, output, 'assets/video.webm'), video);
  await artifacts.promote(id, { snapshotRevision: revision, routeCount: 2 });
  const preview = createStaticPreview({ repositoryRoot: root });
  const address = await preview.listen({ port: 0 });
  cleanups.push(() => preview.close());
  return { root, id, artifacts, preview, url: address.url, video };
}
async function expectBlockedPreview(f: { root: string; url: string }) {
  const response = await fetch(f.url + '/');
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain(f.root);
}
it('serves committed HTML, trailing slash, 404, correct MIME, HEAD, ETag and actual video ranges', async () => {
  const f = await fixture();
  const page = await fetch(f.url + '/?q=anything');
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('Previous success');
  expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
  const etag = page.headers.get('etag');
  if (!etag) throw new Error('Static ETag missing');
  expect(
    (await fetch(f.url + '/', { headers: { 'If-None-Match': etag } })).status,
  ).toBe(304);
  const head = await fetch(f.url + '/', { method: 'HEAD' });
  expect(await head.text()).toBe('');
  expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
  const redirect = await fetch(f.url + '/notes?q=one', { redirect: 'manual' });
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get('location')).toBe('/notes/?q=one');
  const missing = await fetch(f.url + '/missing/');
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain('Missing page');
  expect(
    (await fetch(f.url + '/assets/style.css')).headers.get('content-type'),
  ).toBe('text/css; charset=utf-8');
  expect(
    (await fetch(f.url + '/assets/app.js')).headers.get('content-type'),
  ).toBe('text/javascript; charset=utf-8');
  const part = await fetch(f.url + '/assets/video.webm', {
    headers: { Range: 'bytes=2-5' },
  });
  expect(part.status).toBe(206);
  expect(part.headers.get('content-range')).toBe('bytes 2-5/8');
  expect(Buffer.from(await part.arrayBuffer())).toEqual(f.video.subarray(2, 6));
  const suffix = await fetch(f.url + '/assets/video.webm', {
    headers: { Range: 'bytes=-3' },
  });
  expect(Buffer.from(await suffix.arrayBuffer())).toEqual(f.video.subarray(5));
  const invalid = await fetch(f.url + '/assets/video.webm', {
    headers: { Range: 'bytes=99-' },
  });
  expect(invalid.status).toBe(416);
  expect(invalid.headers.get('content-range')).toBe('bytes */8');
  await invalid.arrayBuffer();
  const full = await fetch(f.url + '/assets/video.webm', {
    headers: { Range: 'bytes=2-5', 'If-Range': '"old-version"' },
  });
  expect(full.status).toBe(200);
  expect(Buffer.from(await full.arrayBuffer())).toEqual(f.video);
  expect((await fetch(f.url + '/', { method: 'POST' })).status).toBe(405);
  expect((await fetch(f.url + '/.foliohaven/jobs/')).status).toBe(404);
  expect((await fetch(f.url + '/%2Fserver/')).status).toBe(400);
  for (const encoded of ['%00', '%0a', '%7f'])
    expect((await fetch(f.url + '/' + encoded)).status).toBe(400);
  await Promise.all([f.preview.close(), f.preview.close()]);
});
it('reuses verified output for GET, HEAD, conditional and range requests without rehashing the tree', async () => {
  const scan = vi.spyOn(artifactTree, 'scanArtifactTree');
  const f = await fixture();
  expect(scan).toHaveBeenCalled();
  scan.mockClear();
  // Freshly promoted files may share coarse timestamp ticks. Validate their
  // bytes first, then warm the observation cache after the safety window.
  const recent = await fetch(f.url + '/');
  expect(recent.status).toBe(200);
  await recent.arrayBuffer();
  expect(scan).toHaveBeenCalled();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const warm = await fetch(f.url + '/');
  expect(warm.status).toBe(200);
  await warm.arrayBuffer();
  scan.mockClear();
  const page = await fetch(f.url + '/');
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('Previous success');
  const etag = page.headers.get('etag');
  if (!etag) throw new Error('Static ETag missing');
  const head = await fetch(f.url + '/', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  const unchanged = await fetch(f.url + '/', {
    headers: { 'If-None-Match': etag },
  });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe('');
  const part = await fetch(f.url + '/assets/video.webm', {
    headers: { Range: 'bytes=2-5' },
  });
  expect(part.status).toBe(206);
  expect(Buffer.from(await part.arrayBuffer())).toEqual(f.video.subarray(2, 6));
  expect(scan).not.toHaveBeenCalled();
});
it('rejects same-size external edits even when the original modification time is restored', async () => {
  const f = await fixture();
  const path = join(f.root, 'dist/index.html');
  const original = await readFile(path, 'utf8');
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  await utimes(path, timestamp, timestamp);
  const warm = await fetch(f.url + '/');
  expect(warm.status).toBe(200);
  expect(await warm.text()).toBe(original);
  const before = await lstat(path, { bigint: true });
  await writeFile(path, original.replace('Previous', 'Tampered'));
  await utimes(path, timestamp, timestamp);
  const after = await lstat(path, { bigint: true });
  expect(after.size).toBe(before.size);
  expect(after.mtimeNs).toBe(before.mtimeNs);
  await expectBlockedPreview(f);
});
it.each(['addition', 'deletion', 'rename', 'symlink'] as const)(
  'invalidates verified output after an external dist %s',
  async (change) => {
    const f = await fixture();
    const dist = join(f.root, 'dist');
    if (change === 'addition')
      await writeFile(join(dist, 'unexpected.html'), 'external addition');
    else if (change === 'deletion') await rm(join(dist, 'assets/style.css'));
    else if (change === 'rename')
      await rename(join(dist, 'notes'), join(dist, 'renamed-notes'));
    else
      await symlink(
        join(f.root, '.foliohaven/artifacts/state.json'),
        join(dist, 'assets/private-link'),
      );
    await expectBlockedPreview(f);
  },
);
it('refreshes content and ETags after another store promotes and restores output', async () => {
  const f = await fixture();
  const first = await fetch(f.url + '/');
  const original = await first.text();
  const firstEtag = first.headers.get('etag');
  if (!firstEtag) throw new Error('Static ETag missing');
  const artifacts = new ArtifactStore({ repositoryRoot: f.root });
  const id = randomUUID();
  const output = join(f.root, '.foliohaven/builds', id, 'output');
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(
    join(output, 'index.html'),
    '<!doctype html><title>Next success</title>',
  );
  await artifacts.promote(id, { snapshotRevision: revision, routeCount: 1 });
  const next = await fetch(f.url + '/', {
    headers: { 'If-None-Match': firstEtag },
  });
  expect(next.status).toBe(200);
  expect(await next.text()).toContain('Next success');
  const nextEtag = next.headers.get('etag');
  if (!nextEtag) throw new Error('Static ETag missing');
  expect(nextEtag).not.toBe(firstEtag);
  const detail = await artifacts.recovery(id);
  await artifacts.resolveRecovery(
    id,
    {
      choice: 'restore-backup',
      revisions: detail.value.resources.map((resource) => ({
        resourceKey: resource.resourceKey,
        revision: resource.current.revision,
      })),
    },
    detail.etag,
  );
  const restored = await fetch(f.url + '/', {
    headers: { 'If-None-Match': nextEtag },
  });
  expect(restored.status).toBe(200);
  expect(await restored.text()).toBe(original);
  expect(restored.headers.get('etag')).toBe(firstEtag);
});
it.each(['state', 'journal'] as const)(
  'rejects cached output after the %s becomes malformed',
  async (control) => {
    const f = await fixture();
    const path = control === 'state' ? 'state.json' : `${f.id}/journal.json`;
    await writeFile(join(f.root, '.foliohaven/artifacts', path), '{');
    await expectBlockedPreview(f);
  },
);
it('rejects cached output when a new journal requires recovery', async () => {
  const f = await fixture();
  const journal = parseArtifactJournal(
    JSON.parse(
      await readFile(
        join(f.root, '.foliohaven/artifacts', f.id, 'journal.json'),
        'utf8',
      ),
    ),
  );
  const id = randomUUID();
  const directory = join(f.root, '.foliohaven/artifacts', id);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(
    join(directory, 'journal.json'),
    JSON.stringify({
      ...journal,
      id,
      sequence: journal.sequence + 1,
      status: 'recovery-required',
      preparedBuildId: id,
      artifactCommittedAt: null,
    }),
  );
  await expectBlockedPreview(f);
});
it('does not start on missing, uncommitted or unknown externally changed output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alfred-unverified-preview-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const preview = createStaticPreview({ repositoryRoot: root });
  await expect(preview.listen({ port: 0 })).rejects.toMatchObject({
    code: 'DIST_NOT_AVAILABLE',
  });
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.html'), 'not committed');
  await expect(preview.listen({ port: 0 })).rejects.toMatchObject({
    code: 'DIST_NOT_VERIFIED',
  });
  await preview.close();
  const f = await fixture();
  await writeFile(join(f.root, 'dist/index.html'), 'UNKNOWN_EXTERNAL_EDIT');
  const response = await fetch(f.url + '/');
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain(f.root);
  expect(await readFile(join(f.root, 'dist/index.html'), 'utf8')).toBe(
    'UNKNOWN_EXTERNAL_EDIT',
  );
});
it('holds the artifact lease through a paused real HTTP stream, then allows complete promotion', async () => {
  const f = await fixture(true);
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpGet(f.url + '/assets/video.webm', resolve);
    req.on('error', reject);
  });
  response.pause();
  try {
    const probe = await acquireFileLease({
      root: f.root,
      name: 'artifact-promotion',
      owner: 'preview-test',
      nonBlocking: true,
    });
    if (probe) await probe.release();
    expect(probe).toBeNull();
    const id = randomUUID();
    const output = `.foliohaven/builds/${id}/output`;
    await mkdir(join(f.root, output), { recursive: true, mode: 0o700 });
    await writeFile(
      join(f.root, output, 'index.html'),
      '<!doctype html><title>Next success</title>',
    );
    let prepared = false;
    const waiting = f.artifacts
      .preparePromotion(id, { snapshotRevision: revision, routeCount: 1 })
      .then((ticket) => {
        prepared = true;
        return ticket;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(prepared).toBe(false);
    response.destroy();
    const ticket = await waiting;
    try {
      await ticket.promote();
    } finally {
      await ticket.release();
    }
    const next = await fetch(f.url + '/');
    expect(next.status).toBe(200);
    expect(await next.text()).toContain('Next success');
  } finally {
    response.destroy();
  }
});
it('stops a startup waiting for the artifact gate without leaving a listening server', async () => {
  const f = await fixture();
  const lease = await acquireFileLease({
    root: f.root,
    name: 'artifact-promotion',
    owner: 'blocked-startup-test',
  });
  if (!lease) throw new Error('Gate lease missing');
  const pending = createStaticPreview({ repositoryRoot: f.root });
  cleanups.push(() => pending.close());
  const startup = pending.listen({ port: 0 });
  const rejected = expect(startup).rejects.toBeInstanceOf(Error);
  try {
    await Promise.all([pending.close(), rejected]);
    await expect(pending.listen({ port: 0 })).rejects.toMatchObject({
      code: 'INVALID_PREVIEW_OPTIONS',
    });
  } finally {
    await lease.release();
  }
});
