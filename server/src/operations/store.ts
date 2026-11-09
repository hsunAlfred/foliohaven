import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { OperationSchema, SafeErrorSchema, UuidSchema } from '@foliohaven/core';
import type { Operation, SafeError } from '@foliohaven/core';
import type { OperationReceipt } from '../files/types.js';
import {
  privateResource,
  atomicJson,
  readJson,
  record,
  RepositoryError,
  safeMkdir,
  safePath,
  syncDirectory,
} from '../files/io.js';
import { acquireFileLease } from '../runtime/lease.js';
import type { FileLease } from '../runtime/lease.js';
import { canonicalPayloadHash, jsonValue } from './value.js';
import type {
  OperationRecord,
  OperationReservation,
  OperationStoreOptions,
  ReservationResult,
  StoredResponse,
} from './types.js';

const ttl = 7 * 86_400_000;
const utc = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export class OperationError extends RepositoryError {
  constructor(
    code: string,
    message: string,
    status: number,
    readonly operationId?: string,
  ) {
    super(code, message, status);
    this.name = 'OperationError';
  }
}
function validateResponse(value: unknown): StoredResponse {
  if (
    !record(value) ||
    !Number.isInteger(value.httpStatus) ||
    Number(value.httpStatus) < 100 ||
    Number(value.httpStatus) > 599 ||
    Object.keys(value).some(
      (key) =>
        ![
          'httpStatus',
          'response',
          'headers',
          'resourceUrl',
          'jobUrl',
        ].includes(key),
    )
  )
    throw new OperationError(
      'INVALID_OPERATION_RESPONSE',
      '操作回應格式不正確。',
      422,
    );
  for (const key of ['resourceUrl', 'jobUrl'] as const)
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' ||
        !/^\/api\/v1\/[a-z0-9/-]+$/.test(value[key]))
    )
      throw new OperationError(
        'INVALID_OPERATION_RESPONSE',
        '操作資源位置不正確。',
        422,
      );
  if (
    value.headers !== undefined &&
    (!record(value.headers) ||
      Object.keys(value.headers).some(
        (key) => !['ETag', 'Location'].includes(key),
      ) ||
      (value.headers.ETag !== undefined &&
        (typeof value.headers.ETag !== 'string' ||
          !/^"[a-f0-9]{64}"$/.test(value.headers.ETag))) ||
      (value.headers.Location !== undefined &&
        (typeof value.headers.Location !== 'string' ||
          !/^\/api\/v1\/[a-z0-9/-]+$/.test(value.headers.Location))))
  )
    throw new OperationError(
      'INVALID_OPERATION_HEADERS',
      '操作回應標頭不在允許範圍。',
      422,
    );
  if (value.response !== undefined) jsonValue(value.response);
  return value as unknown as StoredResponse;
}
function parseRecord(value: unknown): OperationRecord {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    typeof value.kind !== 'string' ||
    !record(value.reservation) ||
    !UuidSchema.safeParse(value.reservation.id).success ||
    !UuidSchema.safeParse(value.reservation.key).success ||
    !hash(value.reservation.payloadHash) ||
    !utc(value.reservation.createdAt) ||
    !utc(value.reservation.expiresAt) ||
    Date.parse(value.reservation.expiresAt) -
      Date.parse(value.reservation.createdAt) !==
      ttl
  )
    throw new OperationError(
      'OPERATION_RECOVERY_REQUIRED',
      '操作紀錄無法判讀，請保留私有資料。',
      409,
    );
  const summary = OperationSchema.safeParse(value.summary);
  if (!summary.success || summary.data.id !== value.reservation.id)
    throw new OperationError(
      'OPERATION_RECOVERY_REQUIRED',
      '操作摘要與識別不符。',
      409,
    );
  if (value.response !== null) validateResponse(value.response);
  if (value.error !== null && !SafeErrorSchema.safeParse(value.error).success)
    throw new OperationError(
      'OPERATION_RECOVERY_REQUIRED',
      '操作錯誤紀錄無法判讀。',
      409,
    );
  if (summary.data.status === 'committed' && value.response === null)
    throw new OperationError(
      'OPERATION_RECOVERY_REQUIRED',
      '成功操作缺少原始回應。',
      409,
    );
  return { ...value, summary: summary.data } as unknown as OperationRecord;
}

export class OperationStore {
  readonly #options: OperationStoreOptions;
  readonly #root: string;
  readonly #leases = new Map<string, FileLease>();
  readonly #receiptSources = new Set<
    () => Promise<readonly OperationReceipt[]>
  >();
  constructor(options: OperationStoreOptions) {
    this.#options = options;
    this.#root = options.repositoryRoot;
  }
  #now(): number {
    return (this.#options.clock?.() ?? new Date()).getTime();
  }
  #file(reservation: OperationReservation): string {
    return privateResource(
      this.#root,
      `operations/${reservation.id}--${reservation.key}.json`,
    );
  }
  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    const lease = await acquireFileLease({
      root: this.#root,
      name: 'operations-state',
      owner: 'operations',
    });
    if (!lease)
      throw new OperationError(
        'OPERATION_BUSY',
        '操作紀錄正由其他程序使用。',
        409,
      );
    try {
      await safeMkdir(this.#root, privateResource(this.#root, 'operations'));
      return await fn();
    } finally {
      await lease.release();
    }
  }
  async #files(): Promise<readonly string[]> {
    const names = await readdir(
      await safePath(this.#root, privateResource(this.#root, 'operations')),
    );
    return names
      .filter((name) => !name.endsWith('.tmp'))
      .map((name) => {
        const parts = /^([a-f0-9-]{36})--([a-f0-9-]{36})\.json$/.exec(name);
        if (
          !parts?.[1] ||
          !parts[2] ||
          !UuidSchema.safeParse(parts[1]).success ||
          !UuidSchema.safeParse(parts[2]).success
        )
          throw new OperationError(
            'OPERATION_RECOVERY_REQUIRED',
            '操作目錄包含無效項目。',
            409,
          );
        return name;
      });
  }
  async #read(name: string): Promise<OperationRecord> {
    const value = parseRecord(
      await readJson(
        this.#root,
        privateResource(this.#root, `operations/${name}`),
      ),
    );
    if (
      this.#file(value.reservation) !==
      privateResource(this.#root, `operations/${name}`)
    )
      throw new OperationError(
        'OPERATION_RECOVERY_REQUIRED',
        '操作識別與檔名不符。',
        409,
      );
    return value;
  }
  async #save(value: OperationRecord): Promise<void> {
    parseRecord(value);
    await atomicJson(this.#root, this.#file(value.reservation), value);
  }
  async #sources(): Promise<readonly OperationReceipt[]> {
    const receipts = [
      ...((await this.#options.repository?.listCommittedOperations()) ?? []),
      ...((await this.#options.recoverReceipts?.()) ?? []),
    ];
    for (const source of this.#receiptSources)
      receipts.push(...(await source()));
    return receipts;
  }
  addReceiptSource(source: () => Promise<readonly OperationReceipt[]>): void {
    this.#receiptSources.add(source);
  }
  async #release(id: string): Promise<void> {
    const lease = this.#leases.get(id);
    this.#leases.delete(id);
    await lease?.release();
  }
  #same(
    reservation: OperationReservation,
    expected: OperationReservation,
  ): void {
    if (
      (['id', 'key', 'payloadHash', 'createdAt', 'expiresAt'] as const).some(
        (key) => reservation[key] !== expected[key],
      )
    )
      throw new OperationError(
        'OPERATION_RESERVATION_MISMATCH',
        '操作保留版本不符。',
        409,
      );
  }
  #receiptRecord(
    receipt: OperationReceipt,
    existing?: OperationRecord,
  ): OperationRecord | null {
    const createdAt = receipt.createdAt ?? existing?.reservation.createdAt;
    const expiresAt = receipt.expiresAt ?? existing?.reservation.expiresAt;
    if (
      !createdAt ||
      !expiresAt ||
      !utc(createdAt) ||
      !utc(expiresAt) ||
      Date.parse(expiresAt) - Date.parse(createdAt) !== ttl ||
      Date.parse(expiresAt) <= this.#now()
    )
      return null;
    if (
      !UuidSchema.safeParse(receipt.id).success ||
      !UuidSchema.safeParse(receipt.key).success ||
      !hash(receipt.payloadHash)
    )
      throw new OperationError(
        'OPERATION_RECOVERY_REQUIRED',
        '成功操作證據格式不正確。',
        409,
      );
    if (
      existing &&
      (existing.reservation.id !== receipt.id ||
        existing.reservation.key !== receipt.key ||
        existing.reservation.payloadHash !== receipt.payloadHash ||
        existing.reservation.createdAt !== createdAt ||
        existing.reservation.expiresAt !== expiresAt)
    )
      throw new OperationError(
        'OPERATION_RECOVERY_REQUIRED',
        '成功操作證據與reservation不符。',
        409,
      );
    const response = validateResponse({
      httpStatus: receipt.httpStatus,
      ...(receipt.response !== undefined ? { response: receipt.response } : {}),
      ...(receipt.headers ? { headers: receipt.headers } : {}),
      ...(receipt.resourceUrl ? { resourceUrl: receipt.resourceUrl } : {}),
      ...(receipt.jobUrl ? { jobUrl: receipt.jobUrl } : {}),
    });
    if (existing?.summary.status === 'committed') {
      if (
        JSON.stringify(jsonValue(existing.response)) !==
        JSON.stringify(jsonValue(response))
      )
        throw new OperationError(
          'OPERATION_RECOVERY_REQUIRED',
          '成功操作證據與已保存原始回應不符，請保留資料。',
          409,
        );
      return existing;
    }
    return {
      schemaVersion: 1,
      kind: existing?.kind ?? 'recovered',
      reservation: {
        id: receipt.id,
        key: receipt.key,
        payloadHash: receipt.payloadHash,
        createdAt,
        expiresAt,
      },
      summary: {
        id: receipt.id,
        status: 'committed',
        resourceUrl: response.resourceUrl ?? null,
        jobUrl: response.jobUrl ?? null,
        httpStatus: response.httpStatus,
        error: null,
      },
      response,
      error: null,
    };
  }
  async initialize(
    additional: readonly OperationReceipt[] = [],
  ): Promise<void> {
    const receipts = [...(await this.#sources()), ...additional];
    await this.#locked(async () => {
      const names = await this.#files();
      const filesByKey = new Map<string, string>();
      for (const name of names) {
        // #files has already validated the UUID--UUID.json filename.
        const key = name.slice(name.indexOf('--') + 2, -5);
        if (filesByKey.has(key))
          throw new OperationError(
            'OPERATION_RECOVERY_REQUIRED',
            '同一操作識別包含多份紀錄，請保留私有資料。',
            409,
          );
        filesByKey.set(key, name);
      }
      for (const receipt of receipts) {
        const filename = filesByKey.get(receipt.key);
        const existing = filename ? await this.#read(filename) : undefined;
        const restored = this.#receiptRecord(receipt, existing);
        if (restored) {
          // A matching committed receipt returns the validated record itself.
          // Rewriting it would fsync all successful history on every request.
          if (restored !== existing) {
            await this.#save(restored);
            filesByKey.set(
              restored.reservation.key,
              `${restored.reservation.id}--${restored.reservation.key}.json`,
            );
          }
          await this.#release(restored.reservation.id);
        }
      }
      for (const name of await this.#files()) {
        const value = await this.#read(name);
        if (
          value.summary.status !== 'reserved' ||
          this.#leases.has(value.reservation.id)
        )
          continue;
        const lease = await acquireFileLease({
          root: this.#root,
          name: `operation-${value.reservation.id}`,
          owner: 'operations',
          nonBlocking: true,
        });
        if (!lease) continue;
        try {
          const error: SafeError = {
            code: 'OPERATION_INTERRUPTED',
            message: '操作中斷且沒有完成證據，請查看來源後使用新操作識別重試。',
            retryable: false,
            issues: [],
          };
          await this.#save({
            ...value,
            summary: {
              ...value.summary,
              status: 'failed',
              httpStatus: 409,
              error,
            },
            error,
          });
        } finally {
          await lease.release();
        }
      }
    });
  }
  async reserve(input: {
    readonly key: string;
    readonly kind: string;
    readonly payload: unknown;
  }): Promise<ReservationResult> {
    if (!UuidSchema.safeParse(input.key).success)
      throw new OperationError(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key必須是小寫UUID。',
        422,
      );
    const payloadHash = canonicalPayloadHash(input.kind, input.payload);
    await this.initialize();
    return this.#locked(async () => {
      const filename = (await this.#files()).find((name) =>
        name.endsWith(`--${input.key}.json`),
      );
      if (filename) {
        const existing = await this.#read(filename);
        if (Date.parse(existing.reservation.expiresAt) > this.#now()) {
          if (existing.reservation.payloadHash !== payloadHash)
            throw new OperationError(
              'IDEMPOTENCY_KEY_REUSED',
              '此操作識別已用於不同內容或不同種類。',
              409,
              existing.reservation.id,
            );
          if (existing.summary.status === 'committed' && existing.response)
            return { status: 'replay', response: existing.response };
          throw new OperationError(
            existing.summary.status === 'reserved'
              ? 'REQUEST_IN_PROGRESS'
              : 'OPERATION_INTERRUPTED',
            existing.summary.status === 'reserved'
              ? '操作仍在執行，可使用operationId查詢。'
              : '操作沒有完成證據，不會自動重做副作用。',
            409,
            existing.reservation.id,
          );
        }
        const lease = await acquireFileLease({
          root: this.#root,
          name: `operation-${existing.reservation.id}`,
          owner: 'operations',
          nonBlocking: true,
        });
        if (!lease)
          throw new OperationError(
            'REQUEST_IN_PROGRESS',
            '操作仍在執行，不能重用識別。',
            409,
            existing.reservation.id,
          );
        try {
          await rm(
            await safePath(
              this.#root,
              privateResource(this.#root, `operations/${filename}`),
            ),
          );
        } finally {
          await lease.release();
        }
        await syncDirectory(
          await safePath(this.#root, privateResource(this.#root, 'operations')),
        );
      }
      const id = randomUUID();
      const lease = await acquireFileLease({
        root: this.#root,
        name: `operation-${id}`,
        owner: 'operations',
      });
      if (!lease)
        throw new OperationError('OPERATION_BUSY', '無法保留操作。', 409);
      const createdAt = new Date(this.#now()).toISOString();
      const reservation: OperationReservation = {
        id,
        key: input.key,
        payloadHash,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + ttl).toISOString(),
      };
      try {
        await this.#save({
          schemaVersion: 1,
          kind: input.kind,
          reservation,
          summary: {
            id,
            status: 'reserved',
            resourceUrl: null,
            jobUrl: null,
            httpStatus: null,
            error: null,
          },
          response: null,
          error: null,
        });
        this.#leases.set(id, lease);
        await this.#options.fault?.('reserved', id);
        return { status: 'reserved', reservation };
      } catch (error) {
        await lease.release();
        this.#leases.delete(id);
        throw error;
      }
    });
  }
  receipt(
    reservation: OperationReservation,
    response: StoredResponse,
  ): OperationReceipt {
    const parsed = validateResponse(response);
    return { ...reservation, ...parsed };
  }
  async assertReserved(reservation: OperationReservation): Promise<void> {
    await this.#locked(async () => {
      const value = await this.#read(
        `${reservation.id}--${reservation.key}.json`,
      );
      this.#same(reservation, value.reservation);
      if (
        value.summary.status !== 'reserved' ||
        Date.parse(value.reservation.expiresAt) <= this.#now()
      )
        throw new OperationError(
          'OPERATION_NOT_RESERVED',
          '操作沒有有效的保留紀錄。',
          409,
          reservation.id,
        );
    });
  }
  async complete(
    reservation: OperationReservation,
    response: StoredResponse,
  ): Promise<void> {
    const receipt = this.receipt(reservation, response);
    try {
      await this.#locked(async () => {
        const existing = await this.#read(
          `${reservation.id}--${reservation.key}.json`,
        );
        this.#same(reservation, existing.reservation);
        if (
          existing.summary.status === 'committed' &&
          JSON.stringify(jsonValue(existing.response)) !==
            JSON.stringify(jsonValue(response))
        )
          throw new OperationError(
            'OPERATION_RESULT_MISMATCH',
            '操作已完成，不能改寫原始回應。',
            409,
            reservation.id,
          );
        const committed = this.#receiptRecord(receipt, existing);
        if (!committed)
          throw new OperationError(
            'OPERATION_EXPIRED',
            '操作重送期限已過。',
            409,
            reservation.id,
          );
        if (
          existing.summary.status === 'committed' &&
          JSON.stringify(existing.response) !==
            JSON.stringify(committed.response)
        )
          throw new OperationError(
            'OPERATION_RESULT_MISMATCH',
            '操作已完成，不能改寫原始回應。',
            409,
            reservation.id,
          );
        if (committed !== existing) await this.#save(committed);
        await this.#options.fault?.('committed', reservation.id);
      });
    } finally {
      await this.#release(reservation.id);
    }
  }
  async fail(
    reservation: OperationReservation,
    failure: SafeError,
    httpStatus = 409,
  ): Promise<void> {
    const error = SafeErrorSchema.parse(failure);
    if (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599)
      throw new OperationError(
        'INVALID_OPERATION_STATUS',
        '失敗操作必須提供安全的HTTP錯誤狀態。',
        500,
      );
    try {
      await this.#locked(async () => {
        const existing = await this.#read(
          `${reservation.id}--${reservation.key}.json`,
        );
        this.#same(reservation, existing.reservation);
        if (existing.summary.status === 'committed') return;
        await this.#save({
          ...existing,
          summary: {
            ...existing.summary,
            status: 'failed',
            httpStatus,
            error,
          },
          error,
        });
      });
    } finally {
      await this.#release(reservation.id);
    }
  }
  async get(id: string): Promise<Operation> {
    if (!UuidSchema.safeParse(id).success)
      throw new OperationError('OPERATION_NOT_FOUND', '操作不存在。', 404);
    return this.#locked(async () => {
      const file = (await this.#files()).find((name) =>
        name.startsWith(`${id}--`),
      );
      if (!file)
        throw new OperationError('OPERATION_NOT_FOUND', '操作不存在。', 404);
      const value = await this.#read(file);
      if (Date.parse(value.reservation.expiresAt) <= this.#now())
        throw new OperationError(
          'OPERATION_NOT_FOUND',
          '操作已超過保存期限。',
          404,
        );
      return value.summary;
    });
  }
  async prune(): Promise<number> {
    return this.#locked(async () => {
      let removed = 0;
      for (const file of await this.#files()) {
        const value = await this.#read(file);
        if (
          Date.parse(value.reservation.expiresAt) > this.#now() ||
          this.#leases.has(value.reservation.id)
        )
          continue;
        const lease = await acquireFileLease({
          root: this.#root,
          name: `operation-${value.reservation.id}`,
          owner: 'operations',
          nonBlocking: true,
        });
        if (!lease) continue;
        try {
          await rm(
            await safePath(
              this.#root,
              privateResource(this.#root, `operations/${file}`),
            ),
          );
          removed++;
        } finally {
          await lease.release();
        }
      }
      if (removed)
        await syncDirectory(
          await safePath(this.#root, privateResource(this.#root, 'operations')),
        );
      return removed;
    });
  }
  async close(): Promise<void> {
    await Promise.all([...this.#leases.keys()].map((id) => this.#release(id)));
  }
}
