import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationReceipt } from '../../server/src/files/index.js';
import {
  OperationStore,
  canonicalPayloadHash,
} from '../../server/src/operations/index.js';
import type {
  OperationRecord,
  OperationReservation,
  ReservationResult,
  StoredResponse,
} from '../../server/src/operations/index.js';

const roots: string[] = [];
const stores: OperationStore[] = [];
const now = '2050-11-04T12:00:00.000Z';
const expiresAt = '2050-11-11T12:00:00.000Z';

afterEach(async () => {
  try {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  } finally {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  }
});

async function fixture(clock: () => Date = () => new Date(now)) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-operations-recovery-'));
  roots.push(root);
  const proofFile = join(root, 'committed-receipts.json');
  await writeFile(proofFile, '[]\n');
  const openStore = () => {
    const store = new OperationStore({
      repositoryRoot: root,
      clock,
      recoverReceipts: async () =>
        JSON.parse(await readFile(proofFile, 'utf8')) as OperationReceipt[],
    });
    stores.push(store);
    return store;
  };
  const store = openStore();
  await store.initialize();
  return {
    root,
    store,
    openStore,
    writeReceipts: (receipts: readonly OperationReceipt[]) =>
      writeFile(proofFile, `${JSON.stringify(receipts)}\n`),
  };
}

function input() {
  return {
    key: randomUUID(),
    kind: 'article-create',
    payload: { title: 'Recovery fixture', body: '<p>Original content</p>' },
  };
}

function reserved(result: ReservationResult): OperationReservation {
  if (result.status !== 'reserved')
    throw new Error('Fixture requires a new reservation');
  return result.reservation;
}

function proofReservation(
  request: ReturnType<typeof input>,
): OperationReservation {
  return {
    id: randomUUID(),
    key: request.key,
    payloadHash: canonicalPayloadHash(request.kind, request.payload),
    createdAt: now,
    expiresAt,
  };
}

function response(): StoredResponse {
  return {
    httpStatus: 201,
    response: {
      id: 'recovered-article',
      contentHtml: '<p>Original response body</p>',
      revision: 1,
    },
    headers: {
      ETag: `"${'a'.repeat(64)}"`,
      Location: '/api/v1/articles/recovered-article',
    },
    resourceUrl: '/api/v1/articles/recovered-article',
  };
}

function recordFile(root: string, reservation: OperationReservation) {
  return join(
    root,
    '.alfred/operations',
    `${reservation.id}--${reservation.key}.json`,
  );
}

async function snapshot(root: string, reservation: OperationReservation) {
  const file = recordFile(root, reservation);
  const [bytes, info] = await Promise.all([
    readFile(file),
    stat(file, { bigint: true }),
  ]);
  return { bytes, inode: info.ino, mtimeNs: info.mtimeNs };
}

describe('OperationStore receipt recovery without rewriting committed records', () => {
  it('keeps committed bytes, inode and mtime across duplicate complete, initialize and replay', async () => {
    const { root, store, writeReceipts } = await fixture();
    const request = input();
    const reservation = reserved(await store.reserve(request));
    const original = response();
    await store.complete(reservation, original);
    const saved = await snapshot(root, reservation);

    // A job and its HTTP handler can both complete the same reservation.
    for (let attempt = 0; attempt < 2; attempt++) {
      await store.complete(reservation, original);
      expect(await snapshot(root, reservation)).toEqual(saved);
    }

    const receipt = store.receipt(reservation, original);
    await store.initialize([receipt, receipt]);
    expect(await snapshot(root, reservation)).toEqual(saved);
    await writeReceipts([receipt]);
    for (let attempt = 0; attempt < 3; attempt++) {
      await store.initialize();
      expect(await snapshot(root, reservation)).toEqual(saved);
      expect(await store.reserve(request)).toEqual({
        status: 'replay',
        response: original,
      });
      expect(await snapshot(root, reservation)).toEqual(saved);
    }
  });

  it('reads new commit proofs after initialization and recovers the exact HTTP response on reserve', async () => {
    const { root, store, writeReceipts } = await fixture();
    const request = input();
    const reservation = proofReservation(request);
    const jobId = randomUUID();
    const original: StoredResponse = {
      httpStatus: 202,
      response: { id: jobId, status: 'queued', result: null },
      headers: {
        ETag: `"${'b'.repeat(64)}"`,
        Location: `/api/v1/jobs/${jobId}`,
      },
      jobUrl: `/api/v1/jobs/${jobId}`,
    };
    await expect(store.get(reservation.id)).rejects.toMatchObject({
      code: 'OPERATION_NOT_FOUND',
    });

    await writeReceipts([store.receipt(reservation, original)]);
    expect(await store.reserve(request)).toEqual({
      status: 'replay',
      response: original,
    });
    expect(await store.get(reservation.id)).toMatchObject({
      status: 'committed',
      httpStatus: 202,
      jobUrl: original.jobUrl,
      error: null,
    });

    const nextRequest = input();
    const nextReservation = proofReservation(nextRequest);
    const nextResponse = response();
    await writeReceipts([
      store.receipt(reservation, original),
      store.receipt(nextReservation, nextResponse),
    ]);
    expect(await store.reserve(nextRequest)).toEqual({
      status: 'replay',
      response: nextResponse,
    });
    expect(await readdir(join(root, '.alfred/operations'))).toHaveLength(2);
  });

  it('preserves the original seven-day deadline as the clock advances and prunes expired recovery records', async () => {
    let current = new Date(now);
    const { root, store, writeReceipts } = await fixture(() => current);
    const request = input();
    const reservation = reserved(await store.reserve(request));
    const original = response();
    await store.complete(reservation, original);
    await writeReceipts([store.receipt(reservation, original)]);
    const saved = await snapshot(root, reservation);
    expect(reservation).toMatchObject({ createdAt: now, expiresAt });

    current = new Date(Date.parse(now) + 6 * 86_400_000);
    await store.initialize();
    expect(await store.reserve(request)).toEqual({
      status: 'replay',
      response: original,
    });
    const beforeExpiry = await snapshot(root, reservation);
    expect(beforeExpiry).toEqual(saved);
    expect(
      (JSON.parse(beforeExpiry.bytes.toString('utf8')) as OperationRecord)
        .reservation,
    ).toMatchObject({ createdAt: now, expiresAt });

    current = new Date(Date.parse(now) + 8 * 86_400_000);
    await store.initialize();
    expect(await snapshot(root, reservation)).toEqual(saved);
    await expect(store.get(reservation.id)).rejects.toMatchObject({
      code: 'OPERATION_NOT_FOUND',
      status: 404,
    });
    expect(await store.prune()).toBe(1);
    expect(await readdir(join(root, '.alfred/operations'))).toEqual([]);
  });

  it.each(['failed', 'interrupted'] as const)(
    'recovers a previously %s operation when a later commit proof arrives',
    async (state) => {
      const { store: owner, openStore, writeReceipts } = await fixture();
      const request = input();
      const reservation = reserved(await owner.reserve(request));
      const original = response();
      const receipt = owner.receipt(reservation, original);
      let store = owner;
      if (state === 'failed') {
        await owner.fail(
          reservation,
          {
            code: 'VALIDATION_FAILED',
            message: 'Fixture validation failed.',
            retryable: false,
            issues: [],
          },
          422,
        );
      } else {
        await owner.close();
        store = openStore();
        await store.initialize();
      }
      expect(await store.get(reservation.id)).toMatchObject({
        status: 'failed',
        httpStatus: state === 'failed' ? 422 : 409,
        error: {
          code:
            state === 'failed' ? 'VALIDATION_FAILED' : 'OPERATION_INTERRUPTED',
        },
      });
      await expect(store.reserve(request)).rejects.toMatchObject({
        code: 'OPERATION_INTERRUPTED',
      });

      await writeReceipts([receipt]);
      expect(await store.reserve(request)).toEqual({
        status: 'replay',
        response: original,
      });
      expect(await store.get(reservation.id)).toMatchObject({
        status: 'committed',
        httpStatus: 201,
        error: null,
      });
    },
  );

  it.each(['body', 'http-status', 'identity'] as const)(
    'rejects a newly discovered conflicting %s receipt without changing the committed file',
    async (conflict) => {
      const { root, store, writeReceipts } = await fixture();
      const request = input();
      const reservation = reserved(await store.reserve(request));
      const original = response();
      await store.complete(reservation, original);
      const receipt = store.receipt(reservation, original);
      await writeReceipts([receipt]);
      await store.initialize();
      const saved = await snapshot(root, reservation);
      const changed: OperationReceipt =
        conflict === 'body'
          ? { ...receipt, response: { id: 'different' } }
          : conflict === 'http-status'
            ? { ...receipt, httpStatus: 202 }
            : { ...receipt, id: randomUUID() };

      await writeReceipts([changed]);
      await expect(store.reserve(request)).rejects.toMatchObject({
        code: 'OPERATION_RECOVERY_REQUIRED',
        status: 409,
      });
      expect(await snapshot(root, reservation)).toEqual(saved);

      await writeReceipts([receipt]);
      expect(await store.reserve(request)).toEqual({
        status: 'replay',
        response: original,
      });
      expect(await snapshot(root, reservation)).toEqual(saved);
    },
  );

  it("retains another store's live lease and does not repeat its side effect", async () => {
    const { root, store: owner, openStore } = await fixture();
    const request = input();
    const sideEffectFile = join(root, 'side-effects.log');
    const execute = async (store: OperationStore) => {
      const result = await store.reserve(request);
      if (result.status === 'reserved')
        await appendFile(sideEffectFile, `${result.reservation.id}\n`);
      return result;
    };
    const reservation = reserved(await execute(owner));
    const saved = await snapshot(root, reservation);
    const contender = openStore();
    await contender.initialize();

    expect(await contender.get(reservation.id)).toMatchObject({
      status: 'reserved',
      error: null,
    });
    await expect(execute(contender)).rejects.toMatchObject({
      code: 'REQUEST_IN_PROGRESS',
      status: 409,
      operationId: reservation.id,
    });
    await expect(owner.assertReserved(reservation)).resolves.toBeUndefined();
    expect(await readFile(sideEffectFile, 'utf8')).toBe(`${reservation.id}\n`);
    expect(await snapshot(root, reservation)).toEqual(saved);
  });

  it.each(['different-id', 'different-response'] as const)(
    'rejects same-key %s proofs within one additional batch after restoring the first proof',
    async (conflict) => {
      const { root, store } = await fixture();
      const request = input();
      const reservation = proofReservation(request);
      const original = response();
      const first = store.receipt(reservation, original);
      const second: OperationReceipt =
        conflict === 'different-id'
          ? { ...first, id: randomUUID() }
          : { ...first, response: { id: 'conflicting-result' } };

      await expect(store.initialize([first, second])).rejects.toMatchObject({
        code: 'OPERATION_RECOVERY_REQUIRED',
        status: 409,
      });
      expect(await readdir(join(root, '.alfred/operations'))).toEqual([
        `${reservation.id}--${reservation.key}.json`,
      ]);
      expect(await store.reserve(request)).toEqual({
        status: 'replay',
        response: original,
      });
    },
  );

  it('rejects two operation files with the same key without altering either record', async () => {
    const { root, store } = await fixture();
    const request = input();
    const reservation = reserved(await store.reserve(request));
    await store.complete(reservation, response());
    const original = await snapshot(root, reservation);
    const record = JSON.parse(
      original.bytes.toString('utf8'),
    ) as OperationRecord;
    const duplicateId = randomUUID();
    const duplicate: OperationRecord = {
      ...record,
      reservation: { ...record.reservation, id: duplicateId },
      summary: { ...record.summary, id: duplicateId },
    };
    await writeFile(
      recordFile(root, duplicate.reservation),
      `${JSON.stringify(duplicate)}\n`,
    );
    const duplicateSaved = await snapshot(root, duplicate.reservation);

    await expect(store.initialize()).rejects.toMatchObject({
      code: 'OPERATION_RECOVERY_REQUIRED',
      status: 409,
    });
    expect(await snapshot(root, reservation)).toEqual(original);
    expect(await snapshot(root, duplicate.reservation)).toEqual(duplicateSaved);
  });
});
