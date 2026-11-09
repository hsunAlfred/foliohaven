import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../server/src/build/artifacts/index.js';
import type { ArtifactProof } from '../../server/src/build/artifacts/index.js';
import { acquireFileLease } from '../../server/src/runtime/lease.js';

const copying = vi.hoisted(() => ({
  source: '',
  afterCopy: undefined as ((destination: string) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    copyFile: vi.fn(async (...args: Parameters<typeof actual.copyFile>) => {
      await actual.copyFile(...args);
      if (String(args[0]) === copying.source) {
        copying.source = '';
        await copying.afterCopy?.(String(args[1]));
      }
    }),
  };
});

const roots: string[] = [];
afterEach(async () => {
  copying.source = '';
  copying.afterCopy = undefined;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-cloudflare-capture-'));
  roots.push(root);
  return { root, store: new ArtifactStore({ repositoryRoot: root }) };
}
async function prepare(root: string, letter: string, bytes = letter) {
  const jobId = randomUUID();
  const output = join(root, '.foliohaven/builds', jobId, 'output');
  for (const path of ['', 'assets', 'media/example', 'empty'])
    await mkdir(join(output, path), { recursive: true, mode: 0o700 });
  for (const [path, value] of Object.entries({
    'index.html': bytes,
    'assets/site.css': 'body { color: black; }',
    'media/example/image.svg': '<svg/>',
    'sitemap-index.xml': '<sitemapindex/>',
    'search-index.json': '[]',
  }))
    await writeFile(join(output, path), value);
  return { jobId, snapshotRevision: letter.repeat(64), routeCount: 1 };
}
async function build(
  root: string,
  store: ArtifactStore,
  letter: string,
  bytes = letter,
) {
  const input = await prepare(root, letter, bytes);
  return store.promote(input.jobId, input);
}
function expected(proof: ArtifactProof, deploymentId = randomUUID()) {
  return {
    deploymentId,
    expectedJobId: proof.jobId,
    expectedSnapshotRevision: proof.result.snapshotRevision,
  };
}
function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

describe('Cloudflare deployment artifact capture', () => {
  it('captures the complete currently proven tree, original paths and empty directories', async () => {
    const { root, store } = await fixture();
    const proof = await build(root, store, 'a');
    const options = expected(proof);
    const captured = await store.captureCurrent(options);
    expect(captured.resource).toBe(
      `.foliohaven/deployments/${options.deploymentId}/source`,
    );
    expect(captured.proof).toEqual(proof);
    expect(captured.manifest).toEqual(proof.manifest);
    expect(captured.manifest.fileCount).toBe(5);
    for (const entry of proof.manifest.entries) {
      const copy = join(root, captured.resource, entry.path);
      if (entry.kind === 'directory')
        expect((await lstat(copy)).isDirectory()).toBe(true);
      else
        expect(await readFile(copy)).toEqual(
          await readFile(join(root, 'dist', entry.path)),
        );
    }
    expect((await lstat(join(root, captured.resource))).mode & 0o777).toBe(
      0o700,
    );
    expect((await store.current()).current?.build?.jobId).toBe(proof.jobId);
  });

  it('keeps its fixed bytes after a later successful Build without holding the artifact gate', async () => {
    const { root, store } = await fixture();
    const first = await build(root, store, 'a');
    const captured = await store.captureCurrent(expected(first));
    const later = await build(
      root,
      new ArtifactStore({ repositoryRoot: root }),
      'b',
    );
    expect(
      await readFile(join(root, captured.resource, 'index.html'), 'utf8'),
    ).toBe('a');
    expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toBe('b');
    expect((await store.current()).current?.build?.jobId).toBe(later.jobId);
  });

  it('rejects missing, unproven and recovery-required sites instead of guessing a historical proof', async () => {
    const { root, store } = await fixture();
    const unknown = {
      deploymentId: randomUUID(),
      expectedJobId: randomUUID(),
      expectedSnapshotRevision: 'a'.repeat(64),
    };
    await expect(store.captureCurrent(unknown)).rejects.toMatchObject({
      code: 'ARTIFACT_CAPTURE_UNAVAILABLE',
    });
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.html'), 'EXTERNAL');
    await expect(store.captureCurrent(unknown)).rejects.toMatchObject({
      code: 'ARTIFACT_CAPTURE_UNPROVEN',
    });
    const proof = await build(root, store, 'a');
    await writeFile(join(root, 'dist/index.html'), 'CHANGED');
    await expect(store.captureCurrent(expected(proof))).rejects.toMatchObject({
      code: 'ARTIFACT_CAPTURE_UNAVAILABLE',
    });
  });

  it('rejects another installed Build even when its output digest matches', async () => {
    const { root, store } = await fixture();
    const first = await build(root, store, 'a', 'SAME');
    const second = await build(root, store, 'b', 'SAME');
    expect(second.digest).toBe(first.digest);
    await expect(store.captureCurrent(expected(first))).rejects.toMatchObject({
      code: 'ARTIFACT_CAPTURE_REPLACED',
    });
    await expect(
      store.captureCurrent({
        ...expected(second),
        expectedSnapshotRevision: first.result.snapshotRevision,
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CAPTURE_REPLACED' });
    expect((await store.captureCurrent(expected(second))).proof.jobId).toBe(
      second.jobId,
    );
  });

  it('rejects invalid identities and revision rather than accepting a caller-selected path', async () => {
    const { root, store } = await fixture();
    const proof = await build(root, store, 'a');
    const base = expected(proof);
    for (const invalid of [
      { ...base, deploymentId: '../outside' },
      { ...base, expectedJobId: '../job' },
      { ...base, expectedSnapshotRevision: 'z'.repeat(64) },
      { ...base, expectedSnapshotRevision: '' },
    ])
      await expect(store.captureCurrent(invalid)).rejects.toMatchObject({
        code: 'ARTIFACT_CAPTURE_ARGUMENT_INVALID',
      });
    await expect(
      lstat(join(root, '.foliohaven/deployments')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites an existing deployment source', async () => {
    const { root, store } = await fixture();
    const proof = await build(root, store, 'a');
    const options = expected(proof);
    const captured = await store.captureCurrent(options);
    await writeFile(join(root, captured.resource, 'index.html'), 'KEEP');
    await expect(store.captureCurrent(options)).rejects.toMatchObject({
      code: 'ARTIFACT_TARGET_EXISTS',
    });
    expect(
      await readFile(join(root, captured.resource, 'index.html'), 'utf8'),
    ).toBe('KEEP');
  });

  it('rejects symlink destination ancestors without writing outside its private directory', async () => {
    const { root, store } = await fixture();
    const proof = await build(root, store, 'a');
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, '.foliohaven/deployments'));
    const options = expected(proof);
    await expect(store.captureCurrent(options)).rejects.toMatchObject({
      code: 'RESOURCE_SYMLINK',
    });
    await expect(
      lstat(join(outside, options.deploymentId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink in the live artifact rather than deploying its referenced content', async () => {
    const { root, store } = await fixture();
    const proof = await build(root, store, 'a');
    await rm(join(root, 'dist/index.html'));
    await writeFile(join(root, 'private.txt'), 'PRIVATE');
    await symlink(join(root, 'private.txt'), join(root, 'dist/index.html'));
    await expect(store.captureCurrent(expected(proof))).rejects.toMatchObject({
      code: expect.stringMatching(/SYMLINK|ARTIFACT|RECOVERY/),
    });
  });

  it('detects live source changes while copying and never returns a successful capture', async () => {
    const { root, store } = await fixture();
    const proof = await build(root, store, 'a');
    copying.source = join(root, 'dist/index.html');
    copying.afterCopy = async () => {
      await writeFile(join(root, 'dist/index.html'), 'CHANGED');
    };
    await expect(store.captureCurrent(expected(proof))).rejects.toMatchObject({
      code: 'BUILD_OUTPUT_CHANGED',
    });
  });

  it('detects a modified captured file even when the live source is still valid', async () => {
    const { root, store } = await fixture();
    const proof = await build(root, store, 'a');
    copying.source = join(root, 'dist/index.html');
    copying.afterCopy = async (destination) => {
      await writeFile(destination, 'CHANGED');
    };
    await expect(store.captureCurrent(expected(proof))).rejects.toMatchObject({
      code: 'BUILD_OUTPUT_CHANGED',
    });
    expect((await store.current()).current?.build?.jobId).toBe(proof.jobId);
  });

  it('honors cancellation before and during capture and releases the artifact lease', async () => {
    const { root, store } = await fixture();
    const proof = await build(root, store, 'a');
    const before = new AbortController();
    before.abort();
    const beforeOptions = expected(proof);
    await expect(
      store.captureCurrent({ ...beforeOptions, signal: before.signal }),
    ).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
    await expect(
      lstat(join(root, '.foliohaven/deployments', beforeOptions.deploymentId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const during = new AbortController();
    copying.source = join(root, 'dist/index.html');
    copying.afterCopy = async () => {
      during.abort();
    };
    await expect(
      store.captureCurrent({ ...expected(proof), signal: during.signal }),
    ).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
    expect((await store.current()).current?.build?.jobId).toBe(proof.jobId);
    expect((await store.captureCurrent(expected(proof))).manifest.digest).toBe(
      proof.digest,
    );
  });

  it('holds one gate across provenance validation and copy, then permits the next Build', async () => {
    const { root, store } = await fixture();
    const proof = await build(root, store, 'a');
    const next = await prepare(root, 'b');
    const entered = deferred();
    const release = deferred();
    copying.source = join(root, 'dist/index.html');
    copying.afterCopy = async () => {
      entered.resolve();
      await release.promise;
    };
    const capturing = store.captureCurrent(expected(proof));
    await entered.promise;
    let nextBuild: Promise<ArtifactProof> | undefined;
    try {
      const lease = await acquireFileLease({
        root,
        name: 'artifact-promotion',
        owner: 'capture-test',
        nonBlocking: true,
      });
      if (lease) await lease.release();
      expect(lease).toBeNull();
      nextBuild = new ArtifactStore({ repositoryRoot: root }).promote(
        next.jobId,
        next,
      );
    } finally {
      release.resolve();
    }
    const captured = await capturing;
    expect(captured.proof.jobId).toBe(proof.jobId);
    expect(
      await readFile(join(root, captured.resource, 'index.html'), 'utf8'),
    ).toBe('a');
    expect((await nextBuild)?.jobId).toBe(next.jobId);
    expect((await store.current()).current?.build?.jobId).toBe(next.jobId);
  });
});
