import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CurrentArtifactSchema,
  JobSchema,
  RecoveryDetailSchema,
  WorkspaceSchema,
} from '@foliohaven/core';
import {
  call,
  sandbox,
  smallBuild,
  start,
  waitFor,
} from '../fixtures/http/environment.mjs';
import type { RunningService } from '../fixtures/http/environment.mjs';

let root = '';
let running: RunningService;
const endpoint = '/api/v1/artifacts/current';
beforeEach(async () => {
  root = await sandbox();
  running = await start(root);
});
afterEach(async () => {
  await running?.service.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function build() {
  const created = await call(running, '/api/v1/build-jobs', {
    method: 'POST',
    body: {},
    headers: { 'idempotency-key': randomUUID() },
  });
  expect(created.status).toBe(202);
  const id = JobSchema.parse(created.body).id;
  const done = JobSchema.parse(
    (
      await waitFor(
        () => call(running, `/api/v1/jobs/${id}`),
        (response) =>
          !['queued', 'running'].includes(
            JobSchema.parse(response.body).status,
          ),
      )
    ).body,
  );
  expect(done.status, JSON.stringify(done)).toBe('succeeded');
  if (done.type !== 'build' || !done.result)
    throw new Error('Isolated build result missing');
  return { id, result: done.result };
}
async function changeSource() {
  const path = join(root, 'content/articles/one/content.html');
  await writeFile(path, `${await readFile(path, 'utf8')}<p>新來源版本。</p>`);
}
async function resolve(id: string, choice: 'restore-backup' | 'keep-current') {
  const response = await call(running, `/api/v1/recoveries/${id}`);
  expect(response.status).toBe(200);
  const detail = RecoveryDetailSchema.parse(response.body);
  const changed = await call(running, `/api/v1/recoveries/${id}/resolution`, {
    method: 'PUT',
    body: {
      choice,
      revisions: detail.resources.map((resource) => ({
        resourceKey: resource.resourceKey,
        revision: resource.current.revision,
      })),
    },
    headers: { 'if-match': String(response.headers.etag) },
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
}
function assertStrong(response: Awaited<ReturnType<typeof call>>) {
  expect(response.headers.etag).toBe(
    `"${createHash('sha256').update(response.bytes).digest('hex')}"`,
  );
  expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/u);
}

describe('current artifact API reports the actual installed dist source', () => {
  it('authenticates the read resource and supports canonical strong ETag / conditional reads without dist', async () => {
    expect((await call(running, endpoint, { authorized: false })).status).toBe(
      403,
    );
    const response = await call(running, endpoint);
    expect(response.status).toBe(200);
    expect(CurrentArtifactSchema.parse(response.body)).toEqual({
      recoveryState: 'ready',
      current: null,
    });
    assertStrong(response);
    for (const condition of [
      String(response.headers.etag),
      `W/${response.headers.etag}`,
      `"${'f'.repeat(64)}", W/${response.headers.etag}`,
      '*',
    ]) {
      const unchanged = await call(running, endpoint, {
        headers: { 'if-none-match': condition },
      });
      expect(unchanged.status).toBe(304);
      expect(unchanged.bytes.length).toBe(0);
      expect(unchanged.headers.etag).toBe(response.headers.etag);
      expect(unchanged.headers['content-length']).toBeUndefined();
    }
    expect(
      (
        await call(running, endpoint, {
          headers: { 'if-none-match': `"${'f'.repeat(64)}"` },
        })
      ).status,
    ).toBe(200);
    const method = await call(running, endpoint, { method: 'POST', body: {} });
    expect(method.status).toBe(405);
    expect(method.headers.allow).toBe('GET');
  });
  it('real HTTP A→B→restore A shows A after restart while historical B remains succeeded and source stays B', async () => {
    await running.service.close();
    running = await start(root, {
      buildExecution: {
        ...smallBuild,
        render: async (context) => {
          await smallBuild.render?.(context);
          await writeFile(
            join(root, '.alfred/builds', context.jobId, 'output/index.html'),
            `<p>${context.snapshotRevision}</p>`,
          );
        },
      },
    });
    const a = await build();
    const before = await call(running, endpoint);
    const aArtifact = CurrentArtifactSchema.parse(before.body);
    expect(aArtifact.current?.build?.jobId).toBe(a.id);
    await changeSource();
    const b = await build();
    expect(b.result.snapshotRevision).not.toBe(a.result.snapshotRevision);
    const newer = await call(running, endpoint);
    expect(CurrentArtifactSchema.parse(newer.body).current?.build?.jobId).toBe(
      b.id,
    );
    assertStrong(newer);
    await resolve(b.id, 'restore-backup');
    const restored = await call(running, endpoint, {
      headers: { 'if-none-match': String(newer.headers.etag) },
    });
    expect(restored.status).toBe(200);
    expect(restored.headers.etag).toBe(before.headers.etag);
    expect(restored.body).toEqual(aArtifact);
    assertStrong(restored);
    const workspace = WorkspaceSchema.parse(
      (await call(running, '/api/v1/workspace')).body,
    );
    expect(workspace.revision).toBe(b.result.snapshotRevision);
    expect(
      CurrentArtifactSchema.parse(restored.body).current?.build?.result
        .snapshotRevision,
    ).not.toBe(workspace.revision);
    await running.service.close();
    running = await start(root);
    expect((await call(running, endpoint)).body).toEqual(aArtifact);
    const historical = JobSchema.parse(
      (await call(running, `/api/v1/jobs/${b.id}`)).body,
    );
    expect(historical.status).toBe('succeeded');
    expect(historical.result).toEqual(b.result);
  });
  it('equal dist bytes from distinct source snapshots still change the representation ETag and restore exact provenance', async () => {
    const a = await build();
    const first = await call(running, endpoint);
    await changeSource();
    const b = await build();
    const second = await call(running, endpoint, {
      headers: { 'if-none-match': String(first.headers.etag) },
    });
    expect(second.status).toBe(200);
    expect(second.headers.etag).not.toBe(first.headers.etag);
    const aArtifact = CurrentArtifactSchema.parse(first.body);
    const bArtifact = CurrentArtifactSchema.parse(second.body);
    expect(bArtifact.current?.digest).toBe(aArtifact.current?.digest);
    expect(bArtifact.current?.build?.result.snapshotRevision).toBe(
      b.result.snapshotRevision,
    );
    expect(b.result.snapshotRevision).not.toBe(a.result.snapshotRevision);
    assertStrong(first);
    assertStrong(second);
    await resolve(b.id, 'restore-backup');
    const restored = await call(running, endpoint);
    expect(restored.body).toEqual(aArtifact);
    expect(restored.headers.etag).toBe(first.headers.etag);
  });
  it('unknown accepted dist never reuses historical source proof and bad proof returns only a safe error', async () => {
    const a = await build();
    await writeFile(join(root, 'dist/index.html'), '<p>外部版本。</p>');
    const pending = CurrentArtifactSchema.parse(
      (await call(running, endpoint)).body,
    );
    expect(pending.recoveryState).toBe('recovery-required');
    expect(pending.current?.build).toBeNull();
    await resolve(a.id, 'keep-current');
    const accepted = CurrentArtifactSchema.parse(
      (await call(running, endpoint)).body,
    );
    expect(accepted.recoveryState).toBe('ready');
    expect(accepted.current).not.toBeNull();
    expect(accepted.current?.build).toBeNull();
    const privatePath = join(root, '.alfred/artifacts', a.id, 'journal.json');
    const value = JSON.parse(await readFile(privatePath, 'utf8')) as Record<
      string,
      unknown
    >;
    value.preparedBuildId = '../PRIVATE_PROOF_SENTINEL';
    await writeFile(privatePath, JSON.stringify(value));
    const failure = await call(running, endpoint);
    expect(failure.status).toBe(409);
    expect(failure.body).toMatchObject({
      error: { code: 'BUILD_RECOVERY_REQUIRED' },
    });
    expect(failure.bytes.toString()).not.toContain('PRIVATE_PROOF_SENTINEL');
    expect(failure.bytes.toString()).not.toContain(root);
  });
});
