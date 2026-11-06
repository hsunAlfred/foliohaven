import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CurrentArtifactSchema } from '@foliohaven/core';
import { ArtifactStore } from '../../server/src/build/artifacts/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-current-artifact-'));
  roots.push(root);
  return { root, store: new ArtifactStore({ repositoryRoot: root }) };
}
async function build(
  root: string,
  store: ArtifactStore,
  letter: string,
  bytes = letter,
) {
  const id = randomUUID();
  const directory = join(root, '.alfred/builds', id, 'output');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'index.html'), bytes);
  return store.promote(id, {
    snapshotRevision: letter.repeat(64),
    routeCount: 1,
  });
}
async function resolve(
  store: ArtifactStore,
  id: string,
  choice: 'restore-backup' | 'apply-prepared' | 'keep-current',
) {
  const detail = await store.recovery(id);
  return store.resolveRecovery(
    id,
    {
      choice,
      revisions: detail.value.resources.map((resource) => ({
        resourceKey: resource.resourceKey,
        revision: resource.current.revision,
      })),
    },
    detail.etag,
  );
}
async function journal(
  root: string,
  id: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(root, '.alfred/artifacts', id, 'journal.json'), 'utf8'),
  ) as Record<string, unknown>;
}
async function changeJournal(
  root: string,
  id: string,
  change: (value: Record<string, unknown>) => void,
) {
  const value = await journal(root, id);
  change(value);
  await writeFile(
    join(root, '.alfred/artifacts', id, 'journal.json'),
    JSON.stringify(value),
  );
}

describe('currently installed artifact provenance', () => {
  it('dist absence and an untracked actual tree are distinct from a proven build', async () => {
    const { root, store } = await fixture();
    expect(CurrentArtifactSchema.parse(await store.current())).toEqual({
      recoveryState: 'ready',
      current: null,
    });
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.html'), 'EXTERNAL');
    expect(await store.current()).toEqual({
      recoveryState: 'ready',
      current: {
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        build: null,
      },
    });
    const a = await build(root, store, 'a');
    expect((await store.current()).current?.build).toEqual({
      jobId: a.jobId,
      committedAt: a.committedAt,
      result: a.result,
    });
  });
  it('A→B→restore A retains exact original provenance through restart and pruning of large copies', async () => {
    const { root, store } = await fixture();
    const a = await build(root, store, 'a');
    const b = await build(root, store, 'b');
    expect((await journal(root, b.jobId)).baseBuildId).toBe(a.jobId);
    await resolve(store, b.jobId, 'restore-backup');
    const reopened = new ArtifactStore({ repositoryRoot: root });
    expect(await reopened.current()).toEqual({
      recoveryState: 'ready',
      current: {
        digest: a.digest,
        build: { jobId: a.jobId, committedAt: a.committedAt, result: a.result },
      },
    });
    expect(await reopened.committedProof(b.jobId)).toEqual(b);
    const c = await build(root, reopened, 'c');
    expect((await journal(root, c.jobId)).baseBuildId).toBe(a.jobId);
    await expect(
      lstat(join(root, '.alfred/artifacts', a.jobId, 'prepared')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await reopened.committedProof(a.jobId)).toEqual(a);
    await resolve(reopened, c.jobId, 'restore-backup');
    expect(
      (await new ArtifactStore({ repositoryRoot: root }).current()).current
        ?.build?.jobId,
    ).toBe(a.jobId);
    expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toBe('a');
  });
  it('identical bytes from different source revisions retain their selected build identity', async () => {
    const { root, store } = await fixture();
    const a = await build(root, store, 'a', 'SAME OUTPUT');
    const b = await build(root, store, 'b', 'SAME OUTPUT');
    expect(b.digest).toBe(a.digest);
    expect(
      (await store.current()).current?.build?.result.snapshotRevision,
    ).toBe('b'.repeat(64));
    await resolve(store, b.jobId, 'restore-backup');
    expect(
      (await store.current()).current?.build?.result.snapshotRevision,
    ).toBe('a'.repeat(64));
    expect((await store.current()).current?.build?.jobId).toBe(a.jobId);
  });
  it('apply-prepared follows the original committed build while keep-current remains explicitly unknown', async () => {
    const { root, store } = await fixture();
    const a = await build(root, store, 'a');
    await writeFile(join(root, 'dist/index.html'), 'UNKNOWN');
    expect((await store.current()).recoveryState).toBe('recovery-required');
    expect((await store.current()).current?.build).toBeNull();
    await resolve(store, a.jobId, 'apply-prepared');
    expect((await store.current()).current?.build?.jobId).toBe(a.jobId);
    const b = await build(root, store, 'b');
    // Exact old bytes do not authorize guessing an old build after an explicit acceptance.
    await writeFile(join(root, 'dist/index.html'), 'a');
    await store.recover();
    await resolve(store, b.jobId, 'keep-current');
    expect(await store.current()).toEqual({
      recoveryState: 'ready',
      current: { digest: a.digest, build: null },
    });
    expect(await store.committedProof(b.jobId)).toEqual(b);
  });
  it('restoring the absent base of the first build removes dist without inventing an artifact', async () => {
    const { root, store } = await fixture();
    const a = await build(root, store, 'a');
    await resolve(store, a.jobId, 'restore-backup');
    expect(await store.current()).toEqual({
      recoveryState: 'ready',
      current: null,
    });
    expect(await store.committedProof(a.jobId)).toEqual(a);
  });
  it('legacy builds prove only themselves; legacy missing base provenance never selects a matching digest', async () => {
    const { root, store } = await fixture();
    const a = await build(root, store, 'a');
    const b = await build(root, store, 'b');
    await changeJournal(root, b.jobId, (value) => {
      delete value.baseBuildId;
      delete value.preparedBuildId;
    });
    expect((await store.current()).current?.build?.jobId).toBe(b.jobId);
    await resolve(store, b.jobId, 'restore-backup');
    expect((await store.current()).current).toEqual({
      digest: a.digest,
      build: null,
    });
  });
  it.each(['missing', 'mismatched'] as const)(
    'a %s referenced build proof becomes unknown and never falls back to latest successful job',
    async (kind) => {
      const { root, store } = await fixture();
      const a = await build(root, store, 'a');
      const b = await build(root, store, 'b');
      await resolve(store, b.jobId, 'restore-backup');
      if (kind === 'missing')
        await rm(join(root, '.alfred/artifacts', a.jobId, 'journal.json'));
      else {
        const state = JSON.parse(
          await readFile(join(root, '.alfred/artifacts/state.json'), 'utf8'),
        ) as { currentJournalId: string };
        await changeJournal(root, state.currentJournalId, (value) => {
          value.preparedBuildId = b.jobId;
        });
      }
      expect((await store.current()).current).toEqual({
        digest: a.digest,
        build: null,
      });
      expect(await store.committedProof(b.jobId)).toEqual(b);
    },
  );
  it.each(['invalid-id', 'bad-proof'] as const)(
    'a %s journal is safely rejected without exposing malformed private data',
    async (kind) => {
      const { root, store } = await fixture();
      const a = await build(root, store, 'a');
      await changeJournal(root, a.jobId, (value) => {
        if (kind === 'invalid-id') value.preparedBuildId = '../private';
        else value.result = { ...a.result, fileCount: 999 };
      });
      await expect(store.current()).rejects.toMatchObject({
        code: 'BUILD_RECOVERY_REQUIRED',
      });
      expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toBe('a');
    },
  );
  for (const phase of ['resolution-intent', 'resolution-committed'] as const)
    it(`a real resolution crash at ${phase} preserves the selected source proof`, async () => {
      const { root, store } = await fixture();
      const a = await build(root, store, 'a');
      const b = await build(root, store, 'b');
      const worker = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL('../fixtures/artifacts/worker.mts', import.meta.url),
          ),
          root,
          'resolve',
          b.jobId,
          phase,
        ],
        { stdio: 'ignore', timeout: 15_000, killSignal: 'SIGKILL' },
      );
      const exit = await new Promise<number | null>((resolveExit, reject) => {
        worker.once('error', reject);
        worker.once('close', resolveExit);
      });
      expect(exit).toBe(77);
      const reopened = new ArtifactStore({ repositoryRoot: root });
      await reopened.recover();
      if (phase === 'resolution-intent')
        await resolve(reopened, b.jobId, 'restore-backup');
      expect((await reopened.current()).current).toEqual({
        digest: a.digest,
        build: { jobId: a.jobId, committedAt: a.committedAt, result: a.result },
      });
      expect(await reopened.committedProof(b.jobId)).toEqual(b);
    });
});
