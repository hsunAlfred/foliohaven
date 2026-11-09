import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JobSchema } from '@foliohaven/core';
import type { MediaResult } from '@foliohaven/core';
import { JobManager } from '../../server/src/jobs/index.js';
import type { JobContext, JobRecord } from '../../server/src/jobs/index.js';
import { ArtifactStore } from '../../server/src/build/artifacts/index.js';
import { OperationStore } from '../../server/src/operations/index.js';
import { safeMkdir, RepositoryError } from '../../server/src/files/io.js';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { acquireFileLease } from '../../server/src/runtime/lease.js';
import { FileRepository } from '../../server/src/files/index.js';
import { ContentService } from '../../server/src/content/index.js';
import { fixedPages, scanContent } from '../fixtures/jobs/content.mjs';

const roots: string[] = [];
const managers: JobManager[] = [];
const stores: OperationStore[] = [];
const children: ChildProcess[] = [];
const nativePids = new Set<number>();
const revision = createHash('sha256').update('source').digest('hex');
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('fixture value missing');
  return value;
}
async function jobRecord(root: string, id: string): Promise<JobRecord> {
  const value = JSON.parse(
    await readFile(join(root, `.foliohaven/jobs/${id}.json`), 'utf8'),
  ) as JobRecord;
  JobSchema.parse(value.job);
  return value;
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      child.kill('SIGKILL');
      await done;
    }
  for (const pid of nativePids)
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* 已結束 */
    }
  nativePids.clear();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-jobs-'));
  roots.push(root);
  const artifacts = new ArtifactStore({ repositoryRoot: root });
  const operations = new OperationStore({ repositoryRoot: root });
  stores.push(operations);
  const jobs = new JobManager({
    repositoryRoot: root,
    artifacts,
    operations,
    pollIntervalMs: 20,
  });
  managers.push(jobs);
  await jobs.initialize();
  return { root, artifacts, operations, jobs };
}
async function commit(
  root: string,
  artifacts: ArtifactStore,
  context: JobContext,
) {
  await safeMkdir(root, `.foliohaven/builds/${context.jobId}/output`);
  await writeFile(
    join(root, `.foliohaven/builds/${context.jobId}/output/index.html`),
    '<!doctype html><p>job artifact</p>',
  );
  return (
    await artifacts.promote(context.jobId, {
      snapshotRevision: revision,
      routeCount: 1,
      signal: context.signal,
    })
  ).result;
}
function worker(root: string, mode: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../fixtures/jobs/worker.mts', import.meta.url)),
      root,
      mode,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.push(child);
  let output = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    const match = /READY [a-f0-9-]+ (\d+)/.exec(output);
    if (match?.[1]) nativePids.add(Number(match[1]));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  return {
    child,
    done,
    error: () => stderr,
    ready: async () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('worker ready timeout')),
          10_000,
        );
        child.stdout.on('data', () => {
          if (output.includes('READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('close', () => {
          clearTimeout(timer);
          reject(new Error('worker closed before ready'));
        });
      }),
  };
}
describe('JOB-01：持久queue、typed handler、跨程序單build與取消', () => {
  it('重啟後retry-input只投影已結束job的必要欄位，不回revision/planId/舊retryOf', async () => {
    const { root, jobs } = await fixture();
    jobs.register('media', {
      validateSource: async () => false,
      run: async () => {
        throw new Error('stale job cannot execute');
      },
    });
    jobs.register('taxonomy', {
      validateSource: async () => false,
      run: async () => {
        throw new Error('stale job cannot execute');
      },
    });
    const sourceId = randomUUID();
    const media = await jobs.create({
      type: 'media',
      payload: { sourceId, preset: 'article-image' },
      sourceRevision: revision,
    });
    const taxonomy = await jobs.create({
      type: 'taxonomy',
      payload: {
        kind: 'tag',
        from: 'old',
        to: 'new',
        workspaceRevision: revision,
        confirmed: true,
        planId: randomUUID(),
      },
      sourceRevision: revision,
    });
    await expect(jobs.retryInput(media.id)).rejects.toMatchObject({
      code: 'JOB_NOT_RETRYABLE',
      status: 409,
    });
    await jobs.runJob(media.id);
    await jobs.runJob(taxonomy.id);
    await jobs.close();
    const restarted = new JobManager({ repositoryRoot: root });
    managers.push(restarted);
    await restarted.initialize();
    expect(await restarted.retryInput(media.id)).toEqual({
      type: 'media',
      sourceId,
      preset: 'article-image',
    });
    expect(await restarted.retryInput(taxonomy.id)).toEqual({
      type: 'taxonomy',
      kind: 'tag',
      from: 'old',
      to: 'new',
    });
    await expect(restarted.retryInput(randomUUID())).rejects.toMatchObject({
      status: 404,
    });
  });
  it('runJob只claim指定ID，不碰其他queued；terminal直接回傳、未知404、slot busy回null', async () => {
    const { root, artifacts, jobs } = await fixture();
    jobs.register('build', {
      validateSource: async () => true,
      run: (context) => commit(root, artifacts, context),
    });
    const first = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const second = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const busy = required(
      await acquireFileLease({
        root,
        name: 'build-execution',
        owner: 'job-test',
      }),
    );
    try {
      expect(await jobs.runJob(second.id)).toBeNull();
    } finally {
      await busy.release();
    }
    expect((await jobs.get(first.id)).status).toBe('queued');
    expect((await jobs.get(second.id)).status).toBe('queued');
    const result = required(await jobs.runJob(second.id));
    expect(result.status).toBe('succeeded');
    expect((await jobs.get(first.id)).status).toBe('queued');
    expect(await jobs.runJob(second.id)).toEqual(result);
    await expect(jobs.runJob(randomUUID())).rejects.toMatchObject({
      status: 404,
    });
  });
  it('同次claim遇build slot busy略過後續build，仍執行taxonomy而不飢餓', async () => {
    const { root, jobs } = await fixture();
    jobs.register('build', {
      validateSource: async () => true,
      run: async () => {
        throw new Error('busy build must not execute');
      },
    });
    jobs.register('taxonomy', {
      validateSource: async () => true,
      run: async (_context, payload) => ({
        kind: payload.kind,
        from: payload.from,
        to: payload.to,
        affectedArticleIds: [],
        changedUrls: [],
      }),
    });
    for (let index = 0; index < 10; index++)
      await jobs.create({
        type: 'build',
        payload: {},
        sourceRevision: revision,
      });
    const target = await jobs.create({
      type: 'taxonomy',
      payload: {
        kind: 'tag',
        from: 'old',
        to: 'new',
        workspaceRevision: revision,
        confirmed: true,
        planId: randomUUID(),
      },
      sourceRevision: revision,
    });
    const busy = required(
      await acquireFileLease({
        root,
        name: 'build-execution',
        owner: 'job-test',
      }),
    );
    try {
      expect(required(await jobs.runNext())).toMatchObject({
        id: target.id,
        status: 'succeeded',
      });
    } finally {
      await busy.release();
    }
    expect((await jobs.list({ type: 'build', status: 'queued' })).total).toBe(
      10,
    );
  });
  it('typed payload/result、stage/progress與真artifact提交構成succeeded', async () => {
    const { root, artifacts, jobs } = await fixture();
    jobs.register('build', {
      validateSource: async (_payload, expected) => expected === revision,
      run: async (context) => {
        await context.progress({
          stage: 'rendering',
          completed: 1,
          total: 2,
          snapshotRevision: revision,
        });
        expect(await jobs.get(context.jobId)).toMatchObject({
          status: 'running',
          progress: { completed: 1, total: 2 },
        });
        expect(await artifacts.committedProof(context.jobId)).toBeNull();
        return commit(root, artifacts, context);
      },
    });
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    expect(queued.status).toBe('queued');
    const result = required(await jobs.runNext());
    expect(result.status).toBe('succeeded');
    expect(result.progress).toEqual({ completed: 2, total: 2 });
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 2,
      total: 2,
    });
    expect((await jobs.get(queued.id)).progress).toEqual(result.progress);
    expect(JobSchema.safeParse(result).success).toBe(true);
    expect(result.result).toMatchObject({
      outputDirectory: 'dist',
      fileCount: 1,
    });
    expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toContain(
      'job artifact',
    );
    expect((await jobs.list({ status: 'succeeded' })).total).toBe(1);
    expect((await jobs.list()).items[0]?.progress).toEqual(result.progress);
  });
  it('handler僅回BuildResult而未有實際artifactCommitted proof不能冒充成功', async () => {
    const { root, jobs } = await fixture();
    jobs.register('build', {
      validateSource: async () => true,
      run: async (context) => {
        await context.progress({
          stage: 'preparing-promotion',
          completed: 4,
          total: 6,
        });
        return {
          outputDirectory: 'dist',
          snapshotRevision: revision,
          routeCount: 1,
          fileCount: 1,
          warnings: [],
        };
      },
    });
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    expect(required(await jobs.runNext())).toMatchObject({
      status: 'failed',
      progress: { completed: 4, total: 6 },
      error: { code: 'BUILD_NOT_COMMITTED' },
    });
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 4,
      total: 6,
    });
  });
  it('queue上限精確採queued+running20，超過429附RetryAfter，不新增第21筆', async () => {
    const { jobs } = await fixture();
    for (let i = 0; i < 20; i++)
      await jobs.create({
        type: 'build',
        payload: {},
        sourceRevision: revision,
      });
    await expect(
      jobs.create({ type: 'build', payload: {}, sourceRevision: revision }),
    ).rejects.toMatchObject({
      code: 'JOB_QUEUE_FULL',
      status: 429,
      retryAfter: 1,
    });
    expect((await jobs.list()).total).toBe(20);
    const first = required((await jobs.list()).items[0]);
    await jobs.cancel(first.id);
    await jobs.create({ type: 'build', payload: {}, sourceRevision: revision });
    expect((await jobs.list({ status: 'queued' })).total).toBe(20);
  });
  it('retryOf只指同type且failed/cancelled/interrupted，payload schema拒絕未知欄位', async () => {
    const { jobs } = await fixture();
    const original = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    await expect(
      jobs.create({
        type: 'build',
        payload: { retryOf: original.id },
        sourceRevision: revision,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RETRY_JOB' });
    await jobs.cancel(original.id);
    expect(
      (
        await jobs.create({
          type: 'build',
          payload: { retryOf: original.id },
          sourceRevision: revision,
        })
      ).status,
    ).toBe('queued');
    await expect(
      jobs.create({
        type: 'media',
        payload: {
          sourceId: randomUUID(),
          preset: 'article-image',
          retryOf: original.id,
        },
        sourceRevision: revision,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RETRY_JOB' });
    await expect(
      jobs.create({
        type: 'build',
        payload: { command: 'forbidden' } as unknown as { retryOf?: string },
        sourceRevision: revision,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_PAYLOAD' });
  });
  it('queued restart先驗來源，失效明確failed且從未呼叫run', async () => {
    const { root, jobs, artifacts } = await fixture();
    const original = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    let calls = 0;
    const restarted = new JobManager({ repositoryRoot: root, artifacts });
    managers.push(restarted);
    restarted.register('build', {
      validateSource: async () => false,
      run: async (context) => {
        calls++;
        return commit(root, artifacts, context);
      },
    });
    await restarted.initialize();
    expect(await restarted.get(original.id)).toMatchObject({
      status: 'failed',
      error: { code: 'JOB_SOURCE_CHANGED' },
    });
    expect(await restarted.runNext()).toBeNull();
    expect(calls).toBe(0);
  });
  it('真claim後process exit且無commit證據，重啟標interrupted不是succeeded', async () => {
    const { root, jobs, artifacts } = await fixture();
    const original = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const crashed = worker(root, 'claim-crash');
    expect(await crashed.done, crashed.error()).toBe(77);
    const restarted = new JobManager({ repositoryRoot: root, artifacts });
    managers.push(restarted);
    await restarted.initialize();
    expect(await restarted.get(original.id)).toMatchObject({
      status: 'interrupted',
      error: { code: 'JOB_INTERRUPTED' },
    });
  });
  it('跨程序build-execution只允許一個run，running計入queue上限；另一程序取消後真native結束', async () => {
    const { root, jobs, artifacts } = await fixture();
    const first = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const running = worker(root, 'hold');
    await running.ready();
    const second = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    jobs.register('build', {
      validateSource: async () => true,
      run: (context) => commit(root, artifacts, context),
    });
    expect(await jobs.runNext()).toBeNull();
    for (let i = 0; i < 18; i++)
      await jobs.create({
        type: 'build',
        payload: {},
        sourceRevision: revision,
      });
    await expect(
      jobs.create({ type: 'build', payload: {}, sourceRevision: revision }),
    ).rejects.toMatchObject({ status: 429 });
    expect((await jobs.get(first.id)).status).toBe('running');
    expect((await jobs.cancel(first.id)).httpStatus).toBe(202);
    expect(await running.done, running.error()).toBe(0);
    expect((await jobs.get(first.id)).status).toBe('cancelled');
    for (const pid of nativePids) expect(() => process.kill(pid, 0)).toThrow();
    expect((await jobs.get(second.id)).status).toBe('queued');
  });
  it('已cancelled重複取消200，queued取消不執行handler', async () => {
    const { jobs } = await fixture();
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    expect((await jobs.cancel(queued.id)).httpStatus).toBe(202);
    expect((await jobs.cancel(queued.id)).httpStatus).toBe(200);
    expect(await jobs.runNext()).toBeNull();
  });
  it('close發abort並等真正handler/native close，完成後不留running或背景worker', async () => {
    const { root, jobs } = await fixture();
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let closed = false;
    jobs.register('build', {
      validateSource: async () => true,
      run: async (context) => {
        await context.progress({ stage: 'rendering', completed: 2, total: 6 });
        try {
          started?.();
          await runControlledProcess({
            command: process.execPath,
            args: ['-e', 'setInterval(()=>{},1000)'],
            cwd: root,
            timeoutMs: 30_000,
            signal: context.signal,
          });
        } finally {
          closed = true;
        }
        throw new Error('fixture stopped');
      },
    });
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const running = jobs.runNext();
    await ready;
    await jobs.close();
    await running;
    expect(closed).toBe(true);
    expect(await jobs.get(queued.id)).toMatchObject({
      status: 'interrupted',
      progress: { completed: 2, total: 6 },
    });
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 2,
      total: 6,
    });
  });
  it('native timeout先關閉程序再標failed；原始stderr/私有路徑不入Job error', async () => {
    const { root, jobs } = await fixture();
    jobs.register('build', {
      validateSource: async () => true,
      run: async (context) => {
        await context.progress({ stage: 'rendering', completed: 2, total: 6 });
        await runControlledProcess({
          command: process.execPath,
          args: [
            '-e',
            'process.stderr.write("private-fixture-sentinel");setInterval(()=>{},1000)',
          ],
          cwd: root,
          timeoutMs: 60,
          signal: context.signal,
        });
        throw new Error(root);
      },
    });
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const failed = required(await jobs.runNext());
    expect(failed).toMatchObject({
      status: 'failed',
      progress: { completed: 2, total: 6 },
      error: { code: 'PROCESS_TIMEOUT' },
    });
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 2,
      total: 6,
    });
    expect(JSON.stringify(failed)).not.toContain(root);
    expect(JSON.stringify(failed)).not.toContain('private-fixture-sentinel');
  });
  it('不接受任意stage/錯誤progress；undefined throw也必須結束failed', async () => {
    const { jobs } = await fixture();
    jobs.register('build', {
      validateSource: async () => true,
      run: async (context) => {
        await context.progress({
          stage: '/private/path',
          completed: 2,
          total: 1,
        });
        throw undefined;
      },
    });
    await jobs.create({ type: 'build', payload: {}, sourceRevision: revision });
    expect(required(await jobs.runNext())).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_JOB_PROGRESS' },
    });
    const second = new JobManager({ repositoryRoot: roots[0] ?? '' });
    managers.push(second);
    second.register('build', {
      validateSource: async () => true,
      run: async () => {
        throw undefined;
      },
    });
    await second.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    expect(required(await second.runNext())).toMatchObject({
      status: 'failed',
      error: { code: 'JOB_FAILED' },
    });
  });
});
describe('BUILD-03／JOB-01：artifact proof與原始建立工作回應', () => {
  it('artifactCommitted之後process真exit，重啟核對proof回填succeeded，重送仍原202 queued body', async () => {
    const { root, jobs, operations, artifacts } = await fixture();
    const key = randomUUID();
    const reservation = await operations.reserve({
      key,
      kind: 'build-create',
      payload: {},
    });
    if (reservation.status !== 'reserved')
      throw new Error('fixture reservation');
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
      operation: reservation.reservation,
    });
    const crashed = worker(root, 'proof-crash');
    expect(await crashed.done, crashed.error()).toBe(77);
    // Restore the coordinator's last durable progress at the crash boundary.
    const interrupted = await jobRecord(root, queued.id);
    expect(interrupted.job.status).toBe('running');
    await writeFile(
      join(root, `.foliohaven/jobs/${queued.id}.json`),
      JSON.stringify({
        ...interrupted,
        job: { ...interrupted.job, progress: { completed: 4, total: 6 } },
      }),
    );
    const restartedOperations = new OperationStore({ repositoryRoot: root });
    stores.push(restartedOperations);
    const restarted = new JobManager({
      repositoryRoot: root,
      artifacts,
      operations: restartedOperations,
    });
    managers.push(restarted);
    await restarted.initialize();
    expect(await restarted.get(queued.id)).toMatchObject({
      status: 'succeeded',
      progress: { completed: 6, total: 6 },
    });
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 6,
      total: 6,
    });
    expect(await artifacts.committedProof(queued.id)).not.toBeNull();
    await expect(restarted.cancel(queued.id)).rejects.toMatchObject({
      code: 'JOB_ALREADY_COMMITTED',
    });
    const replay = await restartedOperations.reserve({
      key,
      kind: 'build-create',
      payload: {},
    });
    expect(replay).toEqual({
      status: 'replay',
      response: {
        httpStatus: 202,
        response: queued,
        headers: { Location: `/api/v1/jobs/${queued.id}` },
        jobUrl: `/api/v1/jobs/${queued.id}`,
      },
    });
  });
  it('job created journal後回應遺失可回填原202，不能使用同reservation再建第二個工作', async () => {
    const { root, operations, artifacts } = await fixture();
    const key = randomUUID();
    const reserved = await operations.reserve({
      key,
      kind: 'build-create',
      payload: {},
    });
    if (reserved.status !== 'reserved') throw new Error('fixture reservation');
    const failing = new JobManager({
      repositoryRoot: root,
      artifacts,
      operations,
      fault: (phase) => {
        if (phase === 'created') throw new Error('fixture response lost');
      },
    });
    managers.push(failing);
    await expect(
      failing.create({
        type: 'build',
        payload: {},
        sourceRevision: revision,
        operation: reserved.reservation,
      }),
    ).rejects.toThrow('fixture response lost');
    await operations.initialize();
    const replay = await operations.reserve({
      key,
      kind: 'build-create',
      payload: {},
    });
    expect(replay.status).toBe('replay');
    if (replay.status === 'replay')
      expect(replay.response).toMatchObject({
        httpStatus: 202,
        response: { status: 'queued' },
      });
    expect((await failing.list()).total).toBe(1);
    await expect(
      failing.create({
        type: 'build',
        payload: {},
        sourceRevision: revision,
        operation: reserved.reservation,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_RESERVED' });
  });
  it('commit完成後handler/log失敗不回滾已成功產物，取消回409且Job維持succeeded', async () => {
    const { root, jobs, artifacts } = await fixture();
    jobs.register('build', {
      validateSource: async () => true,
      run: async (context) => {
        await context.progress({
          stage: 'preparing-promotion',
          completed: 4,
          total: 6,
        });
        await commit(root, artifacts, context);
        throw new RepositoryError('OBSERVER_FAILED', '附加通知失敗。');
      },
    });
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const succeeded = required(await jobs.runNext());
    expect(succeeded).toMatchObject({
      status: 'succeeded',
      progress: { completed: 6, total: 6 },
    });
    expect(
      succeeded.type === 'build' &&
        succeeded.result?.warnings.some(
          (warning) => warning.code === 'POST_COMMIT_WARNING',
        ),
    ).toBe(true);
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 6,
      total: 6,
    });
    await expect(jobs.cancel(queued.id)).rejects.toMatchObject({
      code: 'JOB_ALREADY_COMMITTED',
    });
    expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toContain(
      'job artifact',
    );
  });
});

describe('JOB-01：其餘type介面、proof反例與晚取消', () => {
  it('media與taxonomy具各自typed payload/result，不以build handler代替', async () => {
    const { root, jobs } = await fixture();
    const sourceId = randomUUID();
    const seen: string[] = [];
    jobs.register('media', {
      validateSource: async () => true,
      run: async (context, payload) => {
        await context.progress({
          stage: 'processing-media',
          completed: 1,
          total: 3,
        });
        seen.push(payload.preset);
        return {
          sourceId: payload.sourceId,
          asset: {
            id: payload.sourceId,
            kind: 'image',
            sourceSha256: revision,
            presetVersion: 'fixture-v1',
            tools: { sharp: 'fixture' },
            outputs: [
              {
                publicPath: `/media/${payload.sourceId}/image.webp`,
                mimeType: 'image/webp',
                width: 1,
                height: 1,
                byteSize: 1,
                sha256: revision,
              },
            ],
          },
        };
      },
    });
    jobs.register('taxonomy', {
      validateSource: async () => true,
      run: async (context, payload) => {
        await context.progress({
          stage: 'planning-migration',
          completed: 0,
          total: 1,
        });
        seen.push(payload.kind);
        return {
          kind: payload.kind,
          from: payload.from,
          to: payload.to,
          affectedArticleIds: [],
          changedUrls: [],
        };
      },
    });
    const mediaJob = await jobs.create({
      type: 'media',
      payload: { sourceId, preset: 'article-image' },
      sourceRevision: revision,
    });
    expect(required(await jobs.runNext())).toMatchObject({
      status: 'succeeded',
      progress: { completed: 3, total: 3 },
    });
    expect((await jobRecord(root, mediaJob.id)).job.progress).toEqual({
      completed: 3,
      total: 3,
    });
    const taxonomyJob = await jobs.create({
      type: 'taxonomy',
      payload: {
        kind: 'category',
        from: 'notes',
        to: 'writing',
        workspaceRevision: revision,
        confirmed: true,
        planId: randomUUID(),
      },
      sourceRevision: revision,
    });
    expect(required(await jobs.runNext())).toMatchObject({
      status: 'succeeded',
      progress: { completed: 1, total: 1 },
    });
    expect((await jobRecord(root, taxonomyJob.id)).job.progress).toEqual({
      completed: 1,
      total: 1,
    });
    expect(seen).toEqual(['article-image', 'category']);
    await expect(
      jobs.create({
        type: 'taxonomy',
        payload: {
          kind: 'category',
          from: 'notes',
          to: 'writing',
          workspaceRevision: revision,
          confirmed: false,
        },
        sourceRevision: revision,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_PAYLOAD' });
  });
  it('錯type result即failed；不存在job維持404，pageSize不能繞過上限', async () => {
    const { jobs } = await fixture();
    jobs.register('media', {
      validateSource: async () => true,
      run: async () =>
        ({
          outputDirectory: 'dist',
        }) as unknown as MediaResult,
    });
    await jobs.create({
      type: 'media',
      payload: { sourceId: randomUUID(), preset: 'article-image' },
      sourceRevision: revision,
    });
    expect(required(await jobs.runNext())).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_JOB_RESULT' },
    });
    await expect(jobs.get(randomUUID())).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
      status: 404,
    });
    await expect(jobs.list({ pageSize: 101 })).rejects.toMatchObject({
      status: 422,
    });
  });
  it('只有私有candidate HTML不代表已提交，running restart仍interrupted', async () => {
    const { root, jobs, artifacts } = await fixture();
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const crashed = worker(root, 'claim-crash');
    expect(await crashed.done, crashed.error()).toBe(77);
    const interrupted = await jobRecord(root, queued.id);
    await writeFile(
      join(root, `.foliohaven/jobs/${queued.id}.json`),
      JSON.stringify({
        ...interrupted,
        job: { ...interrupted.job, progress: { completed: 4, total: 6 } },
      }),
    );
    await safeMkdir(root, `.foliohaven/builds/${queued.id}/output`);
    await writeFile(
      join(root, `.foliohaven/builds/${queued.id}/output/index.html`),
      '<!doctype html><p>uncommitted</p>',
    );
    const restarted = new JobManager({ repositoryRoot: root, artifacts });
    managers.push(restarted);
    await restarted.initialize();
    expect(await restarted.get(queued.id)).toMatchObject({
      status: 'interrupted',
      progress: { completed: 4, total: 6 },
    });
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 4,
      total: 6,
    });
    expect(await artifacts.committedProof(queued.id)).toBeNull();
  });
  it('native執行時另一manager initialize不會把仍持鎖的running誤標interrupted', async () => {
    const { root, jobs } = await fixture();
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const running = worker(root, 'hold');
    await running.ready();
    await jobs.initialize();
    expect((await jobs.get(queued.id)).status).toBe('running');
    await jobs.cancel(queued.id);
    expect(await running.done, running.error()).toBe(0);
    expect((await jobs.get(queued.id)).status).toBe('cancelled');
  });
  it('artifact已提交但handler尚在收尾，晚取消409且完成後succeeded', async () => {
    const { root, jobs, artifacts } = await fixture();
    let committed: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jobs.register('build', {
      validateSource: async () => true,
      run: async (context) => {
        await context.progress({
          stage: 'preparing-promotion',
          completed: 4,
          total: 6,
        });
        const result = await commit(root, artifacts, context);
        committed?.();
        await gate;
        return result;
      },
    });
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const running = jobs.runNext();
    await ready;
    try {
      expect(await jobs.get(queued.id)).toMatchObject({
        status: 'running',
        progress: { completed: 4, total: 6 },
      });
      await expect(jobs.cancel(queued.id)).rejects.toMatchObject({
        code: 'JOB_ALREADY_COMMITTED',
      });
    } finally {
      release?.();
    }
    expect(required(await running)).toMatchObject({
      status: 'succeeded',
      progress: { completed: 6, total: 6 },
    });
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 6,
      total: 6,
    });
  });
});

describe('JOB-01：持有promotion ticket期間取消仍能先發出abort', () => {
  it('先durable flag/abort後才等待proof，避免ticket鎖阻擋取消與worker收尾', async () => {
    const { root, jobs, artifacts } = await fixture();
    let ready: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => {
      ready = resolve;
    });
    jobs.register('build', {
      validateSource: async () => true,
      run: async (context) => {
        await context.progress({
          stage: 'preparing-promotion',
          completed: 4,
          total: 6,
        });
        await safeMkdir(root, `.foliohaven/builds/${context.jobId}/output`);
        await writeFile(
          join(root, `.foliohaven/builds/${context.jobId}/output/index.html`),
          '<!doctype html><p>prepared</p>',
        );
        const ticket = await artifacts.preparePromotion(context.jobId, {
          snapshotRevision: revision,
          routeCount: 1,
          signal: context.signal,
        });
        ready?.();
        try {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          throw context.signal.reason;
        } finally {
          await ticket.release();
        }
      },
    });
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    const running = jobs.runNext();
    await prepared;
    expect((await jobs.cancel(queued.id)).httpStatus).toBe(202);
    expect(required(await running)).toMatchObject({
      status: 'cancelled',
      progress: { completed: 4, total: 6 },
    });
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 4,
      total: 6,
    });
    expect(await artifacts.committedProof(queued.id)).toBeNull();
  });
});

async function taxonomyFixture(root: string) {
  await safeMkdir(root, 'content/articles/example');
  await writeFile(
    join(root, 'content/site.json'),
    JSON.stringify({
      siteName: 'Job taxonomy fixture',
      siteDescription: '完整來源交易測試',
      siteUrl: 'https://example.invalid/',
      author: { name: 'fixture' },
    }),
  );
  await writeFile(
    join(root, 'content/categories.json'),
    JSON.stringify([{ path: 'notes', name: '筆記', description: 'fixture' }]),
  );
  await writeFile(join(root, 'content/tags.json'), '[]');
  await writeFile(
    join(root, 'content/articles/example/meta.json'),
    JSON.stringify({ status: 'draft', category: 'notes', title: 'fixture' }),
  );
  await writeFile(
    join(root, 'content/articles/example/content.html'),
    '<p>draft</p>',
  );
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  const service = new ContentService({
    repository,
    fixedPages,
    scanInputs: () => scanContent(root),
  });
  return { repository, service };
}
describe('JOB-01／TAX-02：taxonomy同journal job completion proof', () => {
  it('真migration source commit後process exit，restart由同journal證據回填succeeded且原202不變', async () => {
    const { root, operations, artifacts } = await fixture();
    const { repository } = await taxonomyFixture(root);
    const sourceRevision = await scanContent(root);
    const manager = new JobManager({
      repositoryRoot: root,
      repository,
      operations,
      artifacts,
    });
    managers.push(manager);
    const payload = {
      kind: 'category' as const,
      from: 'notes',
      to: 'writing',
      workspaceRevision: sourceRevision,
      confirmed: true,
      planId: randomUUID(),
    };
    const key = randomUUID();
    const reservation = await operations.reserve({
      key,
      kind: 'taxonomy-create',
      payload,
    });
    if (reservation.status !== 'reserved')
      throw new Error('fixture reservation');
    const queued = await manager.create({
      type: 'taxonomy',
      payload,
      sourceRevision,
      operation: reservation.reservation,
    });
    const crashed = worker(root, 'taxonomy-crash');
    expect(await crashed.done, crashed.error()).toBe(77);
    const interrupted = await jobRecord(root, queued.id);
    await writeFile(
      join(root, `.foliohaven/jobs/${queued.id}.json`),
      JSON.stringify({
        ...interrupted,
        job: { ...interrupted.job, progress: { completed: 0, total: 1 } },
      }),
    );
    const restartedOperations = new OperationStore({
      repositoryRoot: root,
      repository,
    });
    stores.push(restartedOperations);
    const restarted = new JobManager({
      repositoryRoot: root,
      repository,
      operations: restartedOperations,
      artifacts,
    });
    managers.push(restarted);
    await restarted.initialize();
    expect(await restarted.get(queued.id)).toMatchObject({
      status: 'succeeded',
      progress: { completed: 1, total: 1 },
      result: {
        kind: 'category',
        from: 'notes',
        to: 'writing',
        affectedArticleIds: ['example'],
      },
    });
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 1,
      total: 1,
    });
    expect(
      JSON.parse(
        await readFile(
          join(root, 'content/articles/example/meta.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ category: 'writing' });
    expect((await repository.listCommittedJobResults())[0]).toMatchObject({
      id: queued.id,
      type: 'taxonomy',
    });
    await expect(restarted.cancel(queued.id)).rejects.toMatchObject({
      code: 'JOB_ALREADY_COMMITTED',
    });
    expect(
      await restartedOperations.reserve({
        key,
        kind: 'taxonomy-create',
        payload,
      }),
    ).toEqual({
      status: 'replay',
      response: {
        httpStatus: 202,
        response: queued,
        headers: { Location: `/api/v1/jobs/${queued.id}` },
        jobUrl: `/api/v1/jobs/${queued.id}`,
      },
    });
  });
  it('migration已完成但handler未回，晚cancel409且不得把完整來源交易報cancelled', async () => {
    const { root, operations, artifacts } = await fixture();
    const { repository, service } = await taxonomyFixture(root);
    const sourceRevision = await scanContent(root);
    const descriptor = {
      kind: 'category' as const,
      from: 'notes',
      to: 'writing',
      workspaceRevision: sourceRevision,
    };
    const plan = await service.planMigration(descriptor);
    const manager = new JobManager({
      repositoryRoot: root,
      repository,
      operations,
      artifacts,
    });
    managers.push(manager);
    let ready: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    manager.register('taxonomy', {
      validateSource: async () => true,
      run: async (context) => {
        const result = await service.executeMigration(
          { ...descriptor, planId: plan.planId },
          { jobId: context.jobId },
        );
        ready?.();
        await gate;
        return result.value;
      },
    });
    const queued = await manager.create({
      type: 'taxonomy',
      payload: { ...descriptor, planId: plan.planId, confirmed: true },
      sourceRevision,
    });
    const running = manager.runNext();
    await committed;
    await expect(manager.cancel(queued.id)).rejects.toMatchObject({
      code: 'JOB_ALREADY_COMMITTED',
    });
    release?.();
    expect(required(await running).status).toBe('succeeded');
    const proof = required(
      (await repository.listCommittedJobResults()).find(
        (item) => item.id === queued.id,
      ),
    );
    const recovery = await repository.recovery(proof.transactionId);
    await repository.resolveRecovery(
      proof.transactionId,
      {
        choice: 'restore-backup',
        revisions: recovery.value.resources.map((item) => ({
          resourceKey: item.resourceKey,
          revision: item.current.revision,
        })),
      },
      recovery.etag,
    );
    expect(
      (await repository.listCommittedJobResults()).find(
        (item) => item.id === queued.id,
      ),
    ).toEqual(proof);
  });
});

describe('JOB-01：成功進度與歷史紀錄相容性', () => {
  it('已成功歷史進度由get/list/runJob及重啟唯讀投影，不覆寫原始紀錄', async () => {
    const { root, jobs, artifacts } = await fixture();
    jobs.register('build', {
      validateSource: async () => true,
      run: async (context) => {
        await context.progress({
          stage: 'preparing-promotion',
          completed: 4,
          total: 6,
        });
        return commit(root, artifacts, context);
      },
    });
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: revision,
    });
    expect(required(await jobs.runNext()).progress).toEqual({
      completed: 6,
      total: 6,
    });
    const persisted = await jobRecord(root, queued.id);
    const legacy = {
      ...persisted,
      job: { ...persisted.job, progress: { completed: 4, total: 6 } },
    };
    const path = join(root, `.foliohaven/jobs/${queued.id}.json`);
    await writeFile(path, JSON.stringify(legacy));
    const before = await readFile(path);
    const expected = { ...legacy.job, progress: { completed: 6, total: 6 } };
    expect(await jobs.get(queued.id)).toEqual(expected);
    expect((await jobs.list({ status: 'succeeded' })).items).toEqual([
      expected,
    ]);
    expect(await jobs.runJob(queued.id)).toEqual(expected);
    expect(await readFile(path)).toEqual(before);

    const restarted = new JobManager({ repositoryRoot: root, artifacts });
    managers.push(restarted);
    await restarted.initialize();
    expect(await restarted.get(queued.id)).toEqual(expected);
    expect((await restarted.list()).items).toEqual([expected]);
    expect(await readFile(path)).toEqual(before);
    expect((await jobRecord(root, queued.id)).job.progress).toEqual({
      completed: 4,
      total: 6,
    });
  });

  it.each([
    { completed: 2, total: null },
    { completed: 0, total: 0 },
  ])('成功不捏造未知總數或零總數：%j', async (progress) => {
    const { root, jobs } = await fixture();
    jobs.register('taxonomy', {
      validateSource: async () => true,
      run: async (context, payload) => {
        await context.progress({ stage: 'planning-migration', ...progress });
        return {
          kind: payload.kind,
          from: payload.from,
          to: payload.to,
          affectedArticleIds: [],
          changedUrls: [],
        };
      },
    });
    const queued = await jobs.create({
      type: 'taxonomy',
      payload: {
        kind: 'category',
        from: 'notes',
        to: 'writing',
        workspaceRevision: revision,
        confirmed: true,
        planId: randomUUID(),
      },
      sourceRevision: revision,
    });
    expect(required(await jobs.runNext())).toMatchObject({
      status: 'succeeded',
      progress,
    });
    expect((await jobRecord(root, queued.id)).job.progress).toEqual(progress);
    expect((await jobs.get(queued.id)).progress).toEqual(progress);
    expect((await jobs.list()).items[0]?.progress).toEqual(progress);
  });
});
