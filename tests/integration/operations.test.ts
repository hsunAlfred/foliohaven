import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OperationSchema } from '@foliohaven/core';
import { FileRepository } from '../../server/src/files/index.js';
import { parseJournal } from '../../server/src/transactions/journal.js';
import { RepositoryError } from '../../server/src/files/io.js';
import { safeFailure } from '../../server/src/operations/value.js';
import {
  OperationStore,
  canonicalPayloadHash,
} from '../../server/src/operations/index.js';
import type {
  OperationReservation,
  ReservationResult,
} from '../../server/src/operations/index.js';

const roots: string[] = [];
const stores: OperationStore[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      child.kill('SIGKILL');
      await done;
    }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('fixture value required');
  return value;
}
function reserved(value: ReservationResult): OperationReservation {
  if (value.status !== 'reserved') throw new Error('fixture needs reservation');
  return value.reservation;
}
async function fixture(clock?: () => Date) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-operations-'));
  roots.push(root);
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  const store = new OperationStore({
    repositoryRoot: root,
    repository,
    ...(clock ? { clock } : {}),
  });
  stores.push(store);
  return { root, repository, store };
}
function worker(root: string, key: string, mode: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(
        new URL('../fixtures/operations/worker.mts', import.meta.url),
      ),
      root,
      key,
      mode,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.push(child);
  let output = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
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
    ready: async () => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('fixture timeout')),
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
          reject(new Error('fixture exited early'));
        });
      });
      return required(/READY ([a-f0-9-]+)/.exec(output)?.[1]);
    },
  };
}
describe('JOB-01：OperationStore冪等reservation、原始回應與重啟', () => {
  it('canonical hash依語意排序object keys，array次序與操作種類仍不同；拒絕非JSON', () => {
    expect(
      canonicalPayloadHash('article-create', { z: { b: 2, a: 1 }, a: [1, 2] }),
    ).toBe(
      canonicalPayloadHash('article-create', { a: [1, 2], z: { a: 1, b: 2 } }),
    );
    expect(canonicalPayloadHash('article-create', { a: [1, 2] })).not.toBe(
      canonicalPayloadHash('media-create', { a: [1, 2] }),
    );
    expect(canonicalPayloadHash('article-create', [1, 2])).not.toBe(
      canonicalPayloadHash('article-create', [2, 1]),
    );
    for (const payload of [
      undefined,
      Number.NaN,
      { value: undefined },
      new Date(),
      [undefined],
    ])
      expect(() => canonicalPayloadHash('article-create', payload)).toThrow();
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalPayloadHash('article-create', cycle)).toThrow();
  });
  it('副作用前真實durable reservation，同key執行中409含operationId，異payload/endpoint409', async () => {
    const { root, store } = await fixture();
    const key = randomUUID();
    const reservation = reserved(
      await store.reserve({
        key,
        kind: 'article-create',
        payload: { title: 'a' },
      }),
    );
    const names = await readdir(join(root, '.foliohaven/operations'));
    const record = JSON.parse(
      await readFile(
        join(root, '.foliohaven/operations', required(names[0])),
        'utf8',
      ),
    ) as { summary: { status: string } };
    expect(record.summary.status).toBe('reserved');
    await expect(
      store.reserve({ key, kind: 'article-create', payload: { title: 'a' } }),
    ).rejects.toMatchObject({
      code: 'REQUEST_IN_PROGRESS',
      status: 409,
      operationId: reservation.id,
    });
    await expect(
      store.reserve({ key, kind: 'article-create', payload: { title: 'b' } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      store.reserve({ key, kind: 'media-create', payload: { title: 'a' } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('完成後同payload重原status/body/ETag/Location，公開summary不含私有response', async () => {
    const { root, store } = await fixture();
    const key = randomUUID();
    const input = { key, kind: 'article-create', payload: { title: 'a' } };
    const reservation = reserved(await store.reserve(input));
    const response = {
      httpStatus: 201,
      response: { id: 'a', contentHtml: '<p>original</p>' },
      headers: { ETag: `"${'a'.repeat(64)}"`, Location: '/api/v1/articles/a' },
      resourceUrl: '/api/v1/articles/a',
    };
    await store.complete(reservation, response);
    expect(await store.reserve(input)).toEqual({ status: 'replay', response });
    const summary = await store.get(reservation.id);
    expect(OperationSchema.safeParse(summary).success).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('original');
    const restarted = new OperationStore({ repositoryRoot: root });
    stores.push(restarted);
    await restarted.initialize();
    expect(await restarted.reserve(input)).toEqual({
      status: 'replay',
      response,
    });
    await expect(
      store.complete(reservation, { ...response, response: { changed: true } }),
    ).rejects.toMatchObject({ code: 'OPERATION_RESULT_MISMATCH' });
  });
  it('只接受ETag/Location，拒絕認證、任意header及非站內Location', async () => {
    const { store } = await fixture();
    const reservation = reserved(
      await store.reserve({
        key: randomUUID(),
        kind: 'build-create',
        payload: {},
      }),
    );
    expect(() =>
      store.receipt(reservation, {
        httpStatus: 202,
        headers: { Authorization: 'fixture-should-never-save' },
      } as unknown as Parameters<OperationStore['receipt']>[1]),
    ).toThrow();
    expect(() =>
      store.receipt(reservation, {
        httpStatus: 202,
        headers: { Location: 'https://outside.invalid/' },
      }),
    ).toThrow();
    await store.fail(reservation, {
      code: 'VALIDATION_FAILED',
      message: '輸入未通過。',
      retryable: false,
      issues: [],
    });
    expect((await store.get(reservation.id)).status).toBe('failed');
  });
  it('跨程序owner存活不被restart搶走，SIGKILL後無commit證據標failed而不重做', async () => {
    const { root, store } = await fixture();
    const key = randomUUID();
    const running = worker(root, key, 'hold');
    const id = await running.ready();
    await store.initialize();
    expect((await store.get(id)).status).toBe('reserved');
    await expect(
      store.reserve({
        key,
        kind: 'article-create',
        payload: { title: 'fixture' },
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    running.child.kill('SIGKILL');
    await running.done;
    await store.initialize();
    expect((await store.get(id)).status).toBe('failed');
    await expect(
      store.reserve({
        key,
        kind: 'article-create',
        payload: { title: 'fixture' },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_INTERRUPTED' });
  });
  it('真交易commit後程序exit、response未保存，依journal receipt回原201且不再建文章', async () => {
    const { root, store } = await fixture();
    const key = randomUUID();
    const crashed = worker(root, key, 'commit-crash');
    expect(await crashed.done, crashed.error()).toBe(77);
    await store.initialize();
    const replay = await store.reserve({
      key,
      kind: 'article-create',
      payload: { title: 'fixture' },
    });
    expect(replay.status).toBe('replay');
    if (replay.status === 'replay')
      expect(replay.response).toMatchObject({
        httpStatus: 201,
        response: { id: 'created' },
        headers: { Location: '/api/v1/articles/created' },
      });
    expect(await readdir(join(root, 'content/articles'))).toEqual(['created']);
  });
  it('固定七天expiry不因restart/receipt重建延長，過期清理不刪交易備份', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const { root, store, repository } = await fixture(() => now);
    const key = randomUUID();
    const reservation = reserved(
      await store.reserve({ key, kind: 'article-create', payload: {} }),
    );
    const receipt = store.receipt(reservation, {
      httpStatus: 201,
      response: { id: 'a' },
    });
    await repository.commit({
      kind: 'create',
      changes: [
        {
          resourceKey: 'content/articles/a/meta.json',
          expectedRevision: null,
          content: Buffer.from('{"status":"draft"}'),
        },
      ],
      operation: receipt,
    });
    await store.close();
    now = new Date('2026-01-07T23:59:59Z');
    const restarted = new OperationStore({
      repositoryRoot: root,
      repository,
      clock: () => now,
    });
    stores.push(restarted);
    await restarted.initialize();
    expect(
      (await restarted.reserve({ key, kind: 'article-create', payload: {} }))
        .status,
    ).toBe('replay');
    now = new Date('2026-01-08T00:00:01Z');
    await restarted.initialize();
    expect(await restarted.prune()).toBe(1);
    await expect(restarted.get(reservation.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await readdir(join(root, '.foliohaven/transactions'))).toHaveLength(
      1,
    );
    const fresh = reserved(
      await restarted.reserve({ key, kind: 'article-create', payload: {} }),
    );
    expect(fresh.id).not.toBe(reservation.id);
  });
  it('legacy receipt沒有時間且沒有原reservation時不憑restart現在時間延長TTL', async () => {
    const { root, store } = await fixture();
    const receipt = {
      id: randomUUID(),
      key: randomUUID(),
      payloadHash: 'a'.repeat(64),
      httpStatus: 201,
      response: { id: 'legacy' },
    };
    await store.initialize([receipt]);
    expect(await readdir(join(root, '.foliohaven/operations'))).toEqual([]);
  });
});

describe('JOB-01：receipt不可改寫及跨程序expiry', () => {
  it('業務失敗保存原HTTP422，重啟不改為409也不重做副作用', async () => {
    const { store } = await fixture();
    const input = {
      key: randomUUID(),
      kind: 'article-create',
      payload: { title: 'invalid' },
    };
    const reservation = reserved(await store.reserve(input));
    await store.fail(
      reservation,
      {
        code: 'VALIDATION_FAILED',
        message: '發布欄位未完成。',
        retryable: false,
        issues: [],
      },
      422,
    );
    expect(await store.get(reservation.id)).toMatchObject({
      status: 'failed',
      httpStatus: 422,
    });
    await store.initialize();
    expect(await store.get(reservation.id)).toMatchObject({
      status: 'failed',
      httpStatus: 422,
    });
    await expect(store.reserve(input)).rejects.toMatchObject({
      code: 'OPERATION_INTERRUPTED',
      status: 409,
    });
  });
  it('安全的worker欄位診斷與retryable保留，無效錯誤detail回安全fallback', () => {
    class DetailedFailure extends RepositoryError {
      readonly retryable = true;
      readonly issues = [
        {
          path: ['meta', 'category'],
          code: 'UNKNOWN_CATEGORY',
          message: '請選擇既有分類。',
        },
      ];
    }
    const failure = new DetailedFailure(
      'CONTENT_INVALID',
      '來源尚未符合建置條件。',
      422,
    );
    expect(safeFailure(failure)).toEqual({
      code: failure.code,
      message: failure.message,
      retryable: true,
      issues: failure.issues,
    });
    const invalid = Object.assign(new RepositoryError('BROKEN', 'invalid'), {
      issues: [{ path: ['meta'], code: 'BROKEN', message: 'bad', raw: true }],
    });
    expect(safeFailure(invalid)).toMatchObject({
      code: 'JOB_FAILED',
      issues: [],
    });
  });
  it('journal只接受完整七天receipt期限及合法taxonomy completion，壞證據不被當成功', () => {
    const base = {
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'committed',
      committedAt: '2026-01-01T00:00:01.000Z',
      kind: 'taxonomy',
      generationAfter: 1,
      entries: [
        {
          resourceKey: 'content/categories.json',
          oldRevision: 'a'.repeat(64),
          newRevision: 'b'.repeat(64),
          byteSize: 2,
          installed: true,
          fileId: randomUUID(),
        },
      ],
    };
    const operation = {
      id: randomUUID(),
      key: randomUUID(),
      payloadHash: 'c'.repeat(64),
      httpStatus: 202,
      createdAt: base.createdAt,
      expiresAt: '2026-01-08T00:00:00.000Z',
    };
    const jobCompletion = {
      id: randomUUID(),
      type: 'taxonomy',
      result: {
        kind: 'category',
        from: 'old',
        to: 'new',
        affectedArticleIds: ['one'],
        changedUrls: [],
      },
    };
    expect(parseJournal({ ...base, operation, jobCompletion })).toMatchObject({
      operation,
      jobCompletion,
    });
    for (const bad of [
      { ...operation, createdAt: undefined },
      { ...operation, expiresAt: undefined },
      { ...operation, expiresAt: '2026-01-09T00:00:00.000Z' },
      { ...operation, createdAt: 'invalid' },
    ])
      expect(() => parseJournal({ ...base, operation: bad })).toThrow();
    for (const bad of [
      { ...jobCompletion, id: '../outside' },
      { ...jobCompletion, type: 'media' },
      { ...jobCompletion, result: { ...jobCompletion.result, extra: true } },
      { ...jobCompletion, command: 'unexpected' },
    ])
      expect(() => parseJournal({ ...base, jobCompletion: bad })).toThrow();
    expect(() =>
      parseJournal({ ...base, kind: 'save', jobCompletion }),
    ).toThrow();
  });
  it('互相衝突的committed receipt拒絕回填，原始response不被覆寫', async () => {
    const { store } = await fixture();
    const input = {
      key: randomUUID(),
      kind: 'article-create',
      payload: { title: 'a' },
    };
    const reservation = reserved(await store.reserve(input));
    const response = {
      httpStatus: 201,
      response: { id: 'a', title: 'original' },
    };
    await store.complete(reservation, response);
    await expect(
      store.initialize([
        store.receipt(reservation, {
          httpStatus: 201,
          response: { id: 'a', title: 'different' },
        }),
      ]),
    ).rejects.toMatchObject({ code: 'OPERATION_RECOVERY_REQUIRED' });
    expect(await store.reserve(input)).toEqual({ status: 'replay', response });
  });
  it('owner還存活時即使clock已過TTL，也不能重用同key啟動重複副作用', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const { store } = await fixture(() => now);
    const input = { key: randomUUID(), kind: 'article-create', payload: {} };
    await store.reserve(input);
    now = new Date('2026-01-10T00:00:00Z');
    await expect(store.reserve(input)).rejects.toMatchObject({
      code: 'REQUEST_IN_PROGRESS',
    });
    expect(await store.prune()).toBe(0);
  });
});
