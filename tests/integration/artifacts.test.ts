import { afterEach, describe, expect, it } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RecoveryDetailSchema } from '@foliohaven/core';
import {
  ArtifactStore,
  scanArtifactTree,
} from '../../server/src/build/artifacts/index.js';
import type {
  ArtifactFaultPhase,
  ArtifactStoreOptions,
} from '../../server/src/build/artifacts/index.js';
import { FileRepository } from '../../server/src/files/index.js';

const roots: string[] = [];
const children = new Set<ChildProcess>();
const revision = 'a'.repeat(64);
const options = { snapshotRevision: revision, routeCount: 2 };
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      child.kill('SIGKILL');
      await done;
    }
  }
  children.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function tree(
  root: string,
  resource: string,
  content: string,
): Promise<void> {
  await mkdir(join(root, resource, 'assets/empty'), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(root, resource, 'index.html'), content);
  await writeFile(
    join(root, resource, 'assets/video.webm'),
    Buffer.from([0, 4, 7, 9, content.length]),
  );
}
async function fixture(
  config: Omit<ArtifactStoreOptions, 'repositoryRoot'> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-artifacts-'));
  roots.push(root);
  const id = randomUUID();
  await tree(root, 'dist', 'OLD_ARTIFACT');
  await tree(root, `.foliohaven/builds/${id}/output`, 'NEW_ARTIFACT');
  const store = new ArtifactStore({ repositoryRoot: root, ...config });
  return { root, id, store };
}
async function index(root: string): Promise<string | null> {
  try {
    return await readFile(join(root, 'dist/index.html'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}
async function resolveRecovery(
  store: ArtifactStore,
  id: string,
  choice: 'keep-current' | 'restore-backup' | 'apply-prepared',
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
function child(root: string, mode: string, id: string, phase = '') {
  const process = spawn(
    globalThis.process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(
        new URL('../fixtures/artifacts/worker.mts', import.meta.url),
      ),
      root,
      mode,
      id,
      phase,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.add(process);
  let stdout = '',
    stderr = '';
  process.stdout.on('data', (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  process.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const done = new Promise<number | null>((resolve, reject) => {
    process.once('error', reject);
    process.once('close', resolve);
  });
  const ready = () =>
    new Promise<void>((resolve, reject) => {
      if (stdout.includes('READY')) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () => reject(new Error('Isolated preview fixture timeout')),
        10_000,
      );
      process.stdout.on('data', () => {
        if (stdout.includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      process.once('close', () => {
        clearTimeout(timer);
        reject(new Error('Isolated preview exited before ready'));
      });
    });
  return { process, done, ready, stderr: () => stderr };
}

describe('artifact tree manifest and durable promotion', () => {
  it('hashes complete names, empty directories and bytes; rejects symlinks without following them', async () => {
    const { root, id, store } = await fixture();
    const source = `.foliohaven/builds/${id}/output`;
    const initial = await scanArtifactTree(root, source);
    expect(initial?.fileCount).toBe(2);
    await mkdir(join(root, source, 'another-empty'));
    expect((await scanArtifactTree(root, source))?.digest).not.toBe(
      initial?.digest,
    );
    await symlink('/etc/passwd', join(root, source, 'linked'));
    await expect(store.promote(id, options)).rejects.toMatchObject({
      code: 'RESOURCE_SYMLINK',
    });
    expect(await index(root)).toBe('OLD_ARTIFACT');
  });
  it('promotes actual output, keeps old backup and private manifest, and returns restart proof', async () => {
    const { root, id, store } = await fixture();
    const before = await scanArtifactTree(root, 'dist');
    const candidate = await scanArtifactTree(
      root,
      `.foliohaven/builds/${id}/output`,
    );
    const result = await store.promote(id, options);
    expect(await index(root)).toBe('NEW_ARTIFACT');
    expect(result.digest).toBe(candidate?.digest);
    expect(result.result).toMatchObject({
      outputDirectory: 'dist',
      snapshotRevision: revision,
      fileCount: 2,
    });
    expect(
      (await scanArtifactTree(root, `.foliohaven/artifacts/${id}/backup`))
        ?.digest,
    ).toBe(before?.digest);
    expect(
      JSON.parse(
        await readFile(
          join(root, `.foliohaven/artifacts/${id}/manifest.json`),
          'utf8',
        ),
      ).manifest.digest,
    ).toBe(candidate?.digest);
    const restarted = new ArtifactStore({ repositoryRoot: root });
    expect(await restarted.committedProof(id)).toEqual(result);
    expect(await restarted.recover()).toEqual({
      recoveryState: 'ready',
      currentDigest: candidate?.digest,
    });
    const recovery = await restarted.recovery(id);
    expect(RecoveryDetailSchema.safeParse(recovery.value).success).toBe(true);
    expect(recovery.value.status).toBe('available');
    expect(recovery.value.resources[0]?.resourceKey).toBe('dist');
    expect(recovery.value.resources[0]?.base.revision).toBe(before?.digest);
    expect(JSON.stringify(recovery)).not.toContain(root);
    await expect(restarted.promote(id, options)).rejects.toMatchObject({
      code: 'ARTIFACT_JOB_EXISTS',
    });
  });
  it('handles the first build without old dist and does not expose a missing/unfinished artifact', async () => {
    const { root, id, store } = await fixture();
    await rm(join(root, 'dist'), { recursive: true });
    await expect(store.withPreviewGate(async () => true)).rejects.toMatchObject(
      { code: 'DIST_NOT_AVAILABLE' },
    );
    const committed = await store.promote(id, options);
    expect(
      await store.withPreviewGate(async (artifact) => artifact.digest),
    ).toBe(committed.digest);
    expect(
      (await store.recovery(id)).value.resources[0]?.base.revision,
    ).toBeNull();
  });
  it('requires exact identifiers and keeps internal paths out of validation errors', async () => {
    const { root, store } = await fixture();
    for (const id of ['../dist', '%2e%2e', 'not-a-job']) {
      await expect(store.promote(id, options)).rejects.toMatchObject({
        code: 'INVALID_JOB_ID',
        status: 400,
      });
      try {
        await store.recovery(id);
      } catch (error) {
        expect(String(error)).not.toContain(root);
      }
    }
  });
  it('cancellation before promotion leaves old dist; cancellation after durable commit cannot undo it', async () => {
    const { root, id } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const store = new ArtifactStore({ repositoryRoot: root });
    await expect(
      store.promote(id, { ...options, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
    expect(await index(root)).toBe('OLD_ARTIFACT');
    const lateController = new AbortController();
    const later = new ArtifactStore({
      repositoryRoot: root,
      fault: (event) => {
        if (event.phase === 'artifact-committed') lateController.abort();
      },
    });
    expect(
      (await later.promote(id, { ...options, signal: lateController.signal }))
        .artifactCommitted,
    ).toBe(true);
    expect(await index(root)).toBe('NEW_ARTIFACT');
  });
  it('a post-commit notification failure still returns success and can be recovered after restart', async () => {
    const { root, id } = await fixture();
    const store = new ArtifactStore({
      repositoryRoot: root,
      fault: (event) => {
        if (event.phase === 'artifact-committed')
          throw new Error('isolated notification failure');
      },
    });
    const proof = await store.promote(id, options);
    expect(proof.artifactCommitted).toBe(true);
    expect(
      proof.result.warnings.some(
        (warning) => warning.code === 'ARTIFACT_POST_COMMIT_WARNING',
      ),
    ).toBe(true);
    expect(await index(root)).toBe('NEW_ARTIFACT');
    expect(
      await new ArtifactStore({ repositoryRoot: root }).committedProof(id),
    ).toEqual(proof);
  });
  it('keeps only the latest known backup while retaining historical success proof', async () => {
    const { root, id, store } = await fixture();
    const first = await store.promote(id, options);
    const secondId = randomUUID();
    await tree(root, `.foliohaven/builds/${secondId}/output`, 'THIRD_ARTIFACT');
    await store.promote(secondId, options);
    expect(await index(root)).toBe('THIRD_ARTIFACT');
    await expect(
      lstat(join(root, `.foliohaven/artifacts/${id}/backup`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await scanArtifactTree(root, `.foliohaven/artifacts/${secondId}/backup`))
        ?.digest,
    ).toBe(first.digest);
    expect((await store.committedProof(id))?.digest).toBe(first.digest);
  });
  it('resolved decisions do not retain extra old backup directories after the next successful build', async () => {
    const { root, id, store } = await fixture();
    await store.promote(id, options);
    await resolveRecovery(store, id, 'restore-backup');
    const next = randomUUID();
    await tree(
      root,
      `.foliohaven/builds/${next}/output`,
      'NEXT_VALID_ARTIFACT',
    );
    await store.promote(next, options);
    let backups = 0;
    for (const name of await readdir(join(root, '.foliohaven/artifacts'))) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      try {
        if (
          (
            await lstat(join(root, '.foliohaven/artifacts', name, 'backup'))
          ).isDirectory()
        )
          backups++;
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
    }
    expect(backups).toBe(1);
    expect(await index(root)).toBe('NEXT_VALID_ARTIFACT');
  });
});

describe('actual crash and filesystem failure recovery', () => {
  const phases: ArtifactFaultPhase[] = [
    'prepared-copies',
    'prepared-journal',
    'promotion-intent',
    'old-moved',
    'before-new-rename',
    'new-moved',
    'artifact-committed',
    'state-committed',
  ];
  for (const phase of phases)
    it(`a real child exits at ${phase}; restart preserves a complete known tree`, async () => {
      const { root, id } = await fixture();
      const worker = child(root, 'promote', id, phase);
      expect(await worker.done, worker.stderr()).toBe(77);
      const store = new ArtifactStore({ repositoryRoot: root });
      expect((await store.recover()).recoveryState).toBe('ready');
      const expectedNew = [
        'new-moved',
        'artifact-committed',
        'state-committed',
      ].includes(phase);
      expect(await index(root)).toBe(
        expectedNew ? 'NEW_ARTIFACT' : 'OLD_ARTIFACT',
      );
      expect((await store.committedProof(id)) !== null).toBe(expectedNew);
    });
  it('an actual failing second rename immediately restores old dist and returns a safe failure', async () => {
    const { root, id } = await fixture();
    const previous = await scanArtifactTree(root, 'dist');
    const store = new ArtifactStore({
      repositoryRoot: root,
      fault: async (event) => {
        if (event.phase === 'before-new-rename')
          await rename(
            join(root, `.foliohaven/builds/${id}/output`),
            join(root, `.foliohaven/builds/${id}/unavailable`),
          );
      },
    });
    await expect(store.promote(id, options)).rejects.toMatchObject({
      code: 'ARTIFACT_INSTALL_FAILED',
      status: 503,
    });
    expect((await scanArtifactTree(root, 'dist'))?.digest).toBe(
      previous?.digest,
    );
    expect(await store.committedProof(id)).toBeNull();
    const cleanup = new ArtifactStore({ repositoryRoot: root });
    expect(await cleanup.discardUncommitted(id)).toBe(true);
    expect(await cleanup.discardUncommitted(id)).toBe(true);
    expect((await cleanup.recover()).recoveryState).toBe('ready');
  });
  it('cleans journal-before-crash copies without touching dist or already committed work', async () => {
    const { root, id } = await fixture();
    const worker = child(root, 'promote', id, 'prepared-copies');
    expect(await worker.done, worker.stderr()).toBe(77);
    const store = new ArtifactStore({ repositoryRoot: root });
    expect(await store.discardUncommitted(id)).toBe(true);
    expect(await store.discardUncommitted(id)).toBe(true);
    expect(await index(root)).toBe('OLD_ARTIFACT');
    const next = randomUUID();
    await tree(root, `.foliohaven/builds/${next}/output`, 'COMMITTED');
    await store.promote(next, options);
    expect(await store.discardUncommitted(next)).toBe(false);
    expect(await index(root)).toBe('COMMITTED');
  });
  it('a failed rollback keeps independent old/candidate versions and blocks preview and new promotion', async () => {
    const { root, id } = await fixture();
    const store = new ArtifactStore({
      repositoryRoot: root,
      fault: async (event) => {
        if (event.phase === 'before-new-rename')
          await rename(
            join(root, `.foliohaven/builds/${id}/output`),
            join(root, `.foliohaven/builds/${id}/unavailable`),
          );
        if (event.phase === 'before-rollback-rename')
          throw Object.assign(new Error('isolated denied'), { code: 'EACCES' });
      },
    });
    await expect(store.promote(id, options)).rejects.toMatchObject({
      code: 'BUILD_RECOVERY_REQUIRED',
    });
    const reopened = new ArtifactStore({ repositoryRoot: root });
    expect((await reopened.recover()).recoveryState).toBe('recovery-required');
    await expect(
      reopened.withPreviewGate(async () => true),
    ).rejects.toMatchObject({ code: 'BUILD_RECOVERY_REQUIRED' });
    const another = randomUUID();
    await tree(root, `.foliohaven/builds/${another}/output`, 'OTHER');
    await expect(reopened.promote(another, options)).rejects.toMatchObject({
      code: 'BUILD_RECOVERY_REQUIRED',
    });
    expect(
      (await readdir(join(root, `.foliohaven/artifacts/${id}`))).sort(),
    ).toEqual(
      expect.arrayContaining(['backup', 'base', 'prepared', 'journal.json']),
    );
    await resolveRecovery(reopened, id, 'restore-backup');
    expect(await index(root)).toBe('OLD_ARTIFACT');
  });
  it('a true crash before rollback rename restores the known old backup after restart', async () => {
    const { root, id } = await fixture();
    const worker = child(root, 'rename-failure', id, 'before-rollback-rename');
    expect(await worker.done, worker.stderr()).toBe(77);
    const reopened = new ArtifactStore({ repositoryRoot: root });
    expect((await reopened.recover()).recoveryState).toBe('ready');
    expect(await index(root)).toBe('OLD_ARTIFACT');
    expect(await reopened.committedProof(id)).toBeNull();
  });
  it('an unknown old tree moved into backup remains downloadable alongside the independent known base', async () => {
    const { root, id } = await fixture();
    const store = new ArtifactStore({
      repositoryRoot: root,
      fault: async (event) => {
        if (event.phase === 'promotion-intent')
          await writeFile(
            join(root, 'dist/index.html'),
            'UNKNOWN_MOVED_BACKUP',
          );
      },
    });
    await expect(store.promote(id, options)).rejects.toMatchObject({
      code: 'BUILD_RECOVERY_REQUIRED',
    });
    const reopened = new ArtifactStore({ repositoryRoot: root });
    expect(await reopened.retainedBuildIds()).toContain(id);
    expect(await reopened.discardUncommitted(id)).toBe(false);
    const detail = await reopened.recovery(id);
    const resource = detail.value.resources.find(
      (entry) => entry.resourceKey === 'dist/index.html',
    );
    expect(resource?.base.binary).not.toBeNull();
    const attachment = resource?.preserved.find(
      (version) => version.binary !== null,
    )?.binary;
    if (!attachment)
      throw new Error('Isolated unknown backup attachment missing');
    const file = await reopened.recoveryFile(id, attachment.fileId);
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('UNKNOWN_MOVED_BACKUP');
    await resolveRecovery(reopened, id, 'restore-backup');
    expect(await index(root)).toBe('OLD_ARTIFACT');
  });
  it('a changed unknown tree is retained and every preserved file is available only by controlled attachment ID', async () => {
    const { root, id } = await fixture();
    const store = new ArtifactStore({
      repositoryRoot: root,
      fault: async (event) => {
        if (event.phase === 'new-moved') {
          await writeFile(
            join(root, 'dist/index.html'),
            'UNKNOWN_THIRD_VERSION',
          );
          await writeFile(join(root, 'dist/extra.txt'), 'EXTRA');
        }
      },
    });
    await expect(store.promote(id, options)).rejects.toMatchObject({
      code: 'BUILD_RECOVERY_REQUIRED',
    });
    const reopened = new ArtifactStore({ repositoryRoot: root });
    const detail = await reopened.recovery(id);
    expect(detail.value.status).toBe('pending');
    expect(
      detail.value.resources.some(
        (resource) => resource.resourceKey === 'dist/extra.txt',
      ),
    ).toBe(true);
    const file = detail.value.resources.find(
      (resource) => resource.resourceKey === 'dist/index.html',
    )?.current.binary;
    expect(file?.mimeType).toBe('application/octet-stream');
    if (!file) throw new Error('Isolated recovery attachment missing');
    const downloaded = await reopened.recoveryFile(id, file.fileId);
    const chunks: Buffer[] = [];
    for await (const chunk of downloaded.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('UNKNOWN_THIRD_VERSION');
    await expect(
      reopened.recoveryFile(id, '../../index.html'),
    ).rejects.toMatchObject({ code: 'RECOVERY_FILE_NOT_FOUND' });
    await resolveRecovery(reopened, id, 'apply-prepared');
    expect(await index(root)).toBe('NEW_ARTIFACT');
    const after = await reopened.recovery(id);
    expect(after.value.resources[0]?.preserved.length).toBeGreaterThan(0);
  });
});

describe('recovery preconditions, decisions, and cross-process preview gate', () => {
  it('requires a complete current tree guard, rejects stale/incomplete decisions, and does not overwrite unknown additions', async () => {
    const { root, id, store } = await fixture();
    await store.promote(id, options);
    await writeFile(join(root, 'dist/index.html'), 'UNKNOWN');
    const detail = await store.recovery(id);
    const complete = {
      choice: 'restore-backup' as const,
      revisions: detail.value.resources.map((resource) => ({
        resourceKey: resource.resourceKey,
        revision: resource.current.revision,
      })),
    };
    await expect(
      store.resolveRecovery(id, complete, undefined),
    ).rejects.toMatchObject({ status: 428 });
    await expect(
      store.resolveRecovery(id, complete, '*'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.resolveRecovery(
        id,
        { ...complete, revisions: complete.revisions.slice(1) },
        detail.etag,
      ),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_RECOVERY_REVISIONS' });
    await writeFile(join(root, 'dist/new-file.txt'), 'EXTERNAL_ADDITION');
    await expect(
      store.resolveRecovery(id, complete, detail.etag),
    ).rejects.toMatchObject({ status: 412 });
    expect(await readFile(join(root, 'dist/new-file.txt'), 'utf8')).toBe(
      'EXTERNAL_ADDITION',
    );
    await resolveRecovery(store, id, 'keep-current');
    expect((await store.recover()).recoveryState).toBe('ready');
    await expect(
      resolveRecovery(store, id, 'keep-current'),
    ).rejects.toMatchObject({ code: 'RECOVERY_ALREADY_RESOLVED' });
  });
  for (const phase of ['resolution-intent', 'resolution-committed'] as const)
    it(`an actual resolution crash at ${phase} can be resumed without repeating side effects`, async () => {
      const { root, id, store } = await fixture();
      await store.promote(id, options);
      await writeFile(join(root, 'dist/index.html'), 'UNKNOWN');
      await store.recover();
      const worker = child(root, 'resolve', id, phase);
      expect(await worker.done, worker.stderr()).toBe(77);
      const reopened = new ArtifactStore({ repositoryRoot: root });
      await reopened.recover();
      if (phase === 'resolution-intent') {
        expect((await reopened.recovery(id)).value.status).toBe('pending');
        await resolveRecovery(reopened, id, 'restore-backup');
      }
      expect((await reopened.recovery(id)).value.status).toBe('resolved');
      expect(await index(root)).toBe('OLD_ARTIFACT');
    });
  it('a real preview process holds the descriptor until response completion; SIGKILL releases it', async () => {
    const { root, id, store } = await fixture();
    await store.promote(id, options);
    const worker = child(root, 'preview', id);
    await worker.ready();
    const second = randomUUID();
    await tree(root, `.foliohaven/builds/${second}/output`, 'NEXT');
    const contender = new ArtifactStore({
      repositoryRoot: root,
      lockTimeoutMs: 40,
    });
    await expect(contender.promote(second, options)).rejects.toMatchObject({
      code: 'WORKSPACE_BUSY',
    });
    expect(await index(root)).toBe('NEW_ARTIFACT');
    worker.process.kill('SIGKILL');
    await worker.done;
    expect((await contender.promote(second, options)).artifactCommitted).toBe(
      true,
    );
    expect(await index(root)).toBe('NEXT');
  });
});

describe('prepared promotion tickets before the final writer lock', () => {
  it('finishes real large copies before the writer lock and never repeats preparation during final promotion', async () => {
    const { root, id } = await fixture();
    const large = Buffer.alloc(24 * 1024 * 1024, 0x37);
    await writeFile(join(root, 'dist/assets/large.webm'), large);
    await writeFile(
      join(root, `.foliohaven/builds/${id}/output/assets/large.webm`),
      large,
    );
    const repository = new FileRepository({ repositoryRoot: root });
    let writerHeld = false,
      preparationCount = 0;
    const store = new ArtifactStore({
      repositoryRoot: root,
      fault: async (event) => {
        if (event.phase === 'prepared-copies') {
          preparationCount++;
          expect(writerHeld).toBe(false);
          await repository.withBuildInputLock(async () => true);
        }
      },
    });
    const ticket = await store.preparePromotion(id, options);
    expect(
      (
        await lstat(
          join(root, `.foliohaven/artifacts/${id}/base/assets/large.webm`),
        )
      ).size,
    ).toBe(large.byteLength);
    expect(
      (
        await lstat(
          join(root, `.foliohaven/artifacts/${id}/prepared/assets/large.webm`),
        )
      ).size,
    ).toBe(large.byteLength);
    const preparedDigest = (
      await scanArtifactTree(root, `.foliohaven/artifacts/${id}/prepared`)
    )?.digest;
    try {
      await repository.withBuildInputLock(async () => {
        writerHeld = true;
        try {
          expect((await ticket.promote()).digest).toBe(preparedDigest);
        } finally {
          writerHeld = false;
        }
      });
    } finally {
      await ticket.release();
    }
    expect(preparationCount).toBe(1);
    expect((await scanArtifactTree(root, 'dist'))?.digest).toBe(preparedDigest);
  });
  it('returns an immutable single-use ticket and release is idempotent', async () => {
    const { id, store } = await fixture();
    const ticket = await store.preparePromotion(id, options);
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(ticket.jobId).toBe(id);
    await ticket.promote();
    await expect(ticket.promote()).rejects.toMatchObject({
      code: 'PROMOTION_TICKET_USED',
    });
    await ticket.release();
    await ticket.release();
    await expect(ticket.promote()).rejects.toMatchObject({
      code: 'PROMOTION_TICKET_CLOSED',
    });
  });
  it('releases an unused ticket as durable rollback and leaves the old dist untouched', async () => {
    const { root, id, store } = await fixture();
    const digest = (await scanArtifactTree(root, 'dist'))?.digest;
    const ticket = await store.preparePromotion(id, options);
    expect(await index(root)).toBe('OLD_ARTIFACT');
    await ticket.release();
    expect((await scanArtifactTree(root, 'dist'))?.digest).toBe(digest);
    expect(await store.committedProof(id)).toBeNull();
    expect(
      JSON.parse(
        await readFile(
          join(root, `.foliohaven/artifacts/${id}/journal.json`),
          'utf8',
        ),
      ).status,
    ).toBe('rolled-back');
  });
  it('defers cancellation cleanup until release outside the final writer lock', async () => {
    const { root, id } = await fixture();
    const controller = new AbortController();
    const store = new ArtifactStore({ repositoryRoot: root });
    const ticket = await store.preparePromotion(id, {
      ...options,
      signal: controller.signal,
    });
    const repository = new FileRepository({ repositoryRoot: root });
    try {
      await repository.withBuildInputLock(async () => {
        controller.abort();
        await expect(ticket.promote()).rejects.toMatchObject({
          code: 'BUILD_CANCELLED',
        });
        expect(
          JSON.parse(
            await readFile(
              join(root, `.foliohaven/artifacts/${id}/journal.json`),
              'utf8',
            ),
          ).status,
        ).toBe('prepared');
      });
    } finally {
      await ticket.release();
    }
    expect(
      JSON.parse(
        await readFile(
          join(root, `.foliohaven/artifacts/${id}/journal.json`),
          'utf8',
        ),
      ).status,
    ).toBe('rolled-back');
    expect(await index(root)).toBe('OLD_ARTIFACT');
  });
  for (const changed of ['dist', 'candidate'] as const)
    it(`rejects an externally changed ${changed} after preparation, retaining all versions`, async () => {
      const { root, id, store } = await fixture();
      const ticket = await store.preparePromotion(id, options);
      const changedPath =
        changed === 'dist'
          ? 'dist/index.html'
          : `.foliohaven/builds/${id}/output/index.html`;
      await writeFile(join(root, changedPath), 'EXTERNAL_AFTER_PREPARE');
      try {
        await expect(ticket.promote()).rejects.toMatchObject({
          code: 'BUILD_RECOVERY_REQUIRED',
        });
      } finally {
        await ticket.release();
      }
      expect(await readFile(join(root, changedPath), 'utf8')).toBe(
        'EXTERNAL_AFTER_PREPARE',
      );
      expect((await store.recover()).recoveryState).toBe('recovery-required');
      const detail = await store.recovery(id);
      const item = detail.value.resources.find(
        (resource) => resource.resourceKey === 'dist/index.html',
      );
      expect(item?.base.binary).not.toBeNull();
      expect(item?.prepared.binary).not.toBeNull();
      if (changed === 'candidate')
        expect(item?.preserved.length).toBeGreaterThan(0);
    });
  it('a real process crash after ticket preparation recovers as a known rollback', async () => {
    const { root, id } = await fixture();
    const worker = child(root, 'prepare', id);
    expect(await worker.done, worker.stderr()).toBe(77);
    const store = new ArtifactStore({ repositoryRoot: root });
    expect((await store.recover()).recoveryState).toBe('ready');
    expect(await index(root)).toBe('OLD_ARTIFACT');
    expect(await store.committedProof(id)).toBeNull();
  });
  it('holds the cross-process preview gate until the ticket is released', async () => {
    const { root, id, store } = await fixture();
    const ticket = await store.preparePromotion(id, options);
    const contender = new ArtifactStore({
      repositoryRoot: root,
      lockTimeoutMs: 40,
    });
    try {
      await expect(
        contender.withPreviewGate(async () => true, {
          requireCommitted: false,
        }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    } finally {
      await ticket.release();
    }
    expect(
      await contender.withPreviewGate(async () => true, {
        requireCommitted: false,
      }),
    ).toBe(true);
  });
});
