import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { TaxonomyResultSchema } from '@foliohaven/core';
import type { CommitRequest, OperationReceipt } from '../files/types.js';
import { record, RepositoryError } from '../files/io.js';

export interface JournalEntry {
  resourceKey: string;
  oldRevision: string | null;
  newRevision: string | null;
  byteSize: number;
  installed: boolean;
  fileId: string;
}
export interface Journal {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  status:
    | 'prepared'
    | 'installing'
    | 'committed'
    | 'rolled-back'
    | 'recovery-required'
    | 'resolved';
  kind: 'save' | 'create' | 'delete' | 'taxonomy' | 'restore';
  generationAfter: number;
  committedAt?: string;
  entries: JournalEntry[];
  operation?: OperationReceipt;
  jobCompletion?: CommitRequest['jobCompletion'];
  trash?: { kind: 'article' | 'media'; id: string };
  directoryReservation?: {
    resourceKey: string;
    token: string;
    identity: { dev: number; ino: number } | null;
  };
  resolution?: {
    choice: string;
    transactionId?: string;
    revisions: readonly { resourceKey: string; revision: string | null }[];
  };
}
const hash = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
export function parseJournal(value: unknown): Journal {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !uuid(value.id) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    ![
      'prepared',
      'installing',
      'committed',
      'rolled-back',
      'recovery-required',
      'resolved',
    ].includes(String(value.status)) ||
    !['save', 'create', 'delete', 'taxonomy', 'restore'].includes(
      String(value.kind),
    ) ||
    !Number.isSafeInteger(value.generationAfter) ||
    Number(value.generationAfter) < 0 ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  )
    throw new RepositoryError(
      'RECOVERY_REQUIRED',
      '交易紀錄無法判讀，請保留備份並檢查復原資料。',
    );
  if (
    value.committedAt !== undefined &&
    (typeof value.committedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.committedAt)))
  )
    throw new RepositoryError('RECOVERY_REQUIRED', '交易提交時間無法判讀。');
  const entries: JournalEntry[] = value.entries.map((entry: unknown) => {
    if (
      !record(entry) ||
      typeof entry.resourceKey !== 'string' ||
      !hash(entry.oldRevision) ||
      !hash(entry.newRevision) ||
      typeof entry.installed !== 'boolean' ||
      !Number.isSafeInteger(entry.byteSize) ||
      Number(entry.byteSize) < 0 ||
      !uuid(entry.fileId)
    )
      throw new RepositoryError(
        'RECOVERY_REQUIRED',
        '交易資源紀錄無法判讀，請保留復原資料。',
      );
    return {
      resourceKey: entry.resourceKey,
      oldRevision: entry.oldRevision,
      newRevision: entry.newRevision,
      byteSize: Number(entry.byteSize),
      installed: entry.installed,
      fileId: entry.fileId,
    };
  });
  if (
    new Set(entries.map((entry) => entry.resourceKey)).size !== entries.length
  )
    throw new RepositoryError(
      'RECOVERY_REQUIRED',
      '交易資源紀錄包含重複識別。',
    );
  if (
    value.operation !== undefined &&
    (!record(value.operation) ||
      !uuid(value.operation.id) ||
      !uuid(value.operation.key) ||
      !hash(value.operation.payloadHash) ||
      value.operation.payloadHash === null ||
      !Number.isInteger(value.operation.httpStatus) ||
      Number(value.operation.httpStatus) < 100 ||
      Number(value.operation.httpStatus) > 599 ||
      (value.operation.resourceUrl !== undefined &&
        (typeof value.operation.resourceUrl !== 'string' ||
          !/^\/api\/v1\/[a-z0-9/-]+$/.test(value.operation.resourceUrl))) ||
      (value.operation.jobUrl !== undefined &&
        (typeof value.operation.jobUrl !== 'string' ||
          !/^\/api\/v1\/jobs\/[a-f0-9-]+$/.test(value.operation.jobUrl))))
  )
    throw new RepositoryError('RECOVERY_REQUIRED', '交易操作紀錄無法判讀。');
  if (
    value.trash !== undefined &&
    (!record(value.trash) ||
      !['article', 'media'].includes(String(value.trash.kind)) ||
      typeof value.trash.id !== 'string')
  )
    throw new RepositoryError('RECOVERY_REQUIRED', '回收筒紀錄無法判讀。');
  if (value.operation !== undefined && record(value.operation)) {
    if (
      (value.operation.createdAt === undefined) !==
      (value.operation.expiresAt === undefined)
    )
      throw new RepositoryError(
        'RECOVERY_REQUIRED',
        '操作保存期限必須完整保留起訖時間。',
      );
    for (const field of ['createdAt', 'expiresAt'] as const)
      if (
        value.operation[field] !== undefined &&
        (typeof value.operation[field] !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
            value.operation[field],
          ) ||
          !Number.isFinite(Date.parse(value.operation[field])))
      )
        throw new RepositoryError(
          'RECOVERY_REQUIRED',
          '操作保存期限紀錄無法判讀。',
        );
    if (
      typeof value.operation.createdAt === 'string' &&
      typeof value.operation.expiresAt === 'string' &&
      Date.parse(value.operation.expiresAt) -
        Date.parse(value.operation.createdAt) !==
        7 * 86_400_000
    )
      throw new RepositoryError(
        'RECOVERY_REQUIRED',
        '操作保存期限必須固定七天。',
      );
    if (
      value.operation.response !== undefined &&
      !jsonValue(value.operation.response)
    )
      throw new RepositoryError(
        'RECOVERY_REQUIRED',
        '交易回應紀錄不符合安全JSON格式。',
      );
    if (
      value.operation.headers !== undefined &&
      (!record(value.operation.headers) ||
        Object.keys(value.operation.headers).some(
          (key) => !['ETag', 'Location'].includes(key),
        ) ||
        (value.operation.headers.ETag !== undefined &&
          (typeof value.operation.headers.ETag !== 'string' ||
            !/^"[a-f0-9]{64}"$/.test(value.operation.headers.ETag))) ||
        (value.operation.headers.Location !== undefined &&
          (typeof value.operation.headers.Location !== 'string' ||
            !/^\/api\/v1\/[a-z0-9/-]+$/.test(
              value.operation.headers.Location,
            ))))
    )
      throw new RepositoryError(
        'RECOVERY_REQUIRED',
        '交易回應標頭不符合白名單。',
      );
  }
  if (
    value.resolution !== undefined &&
    (!record(value.resolution) ||
      ![
        'keep-current',
        'restore-backup',
        'apply-prepared',
        'restore-trash',
        'purge-trash',
      ].includes(String(value.resolution.choice)) ||
      (value.resolution.transactionId !== undefined &&
        !uuid(value.resolution.transactionId)) ||
      !Array.isArray(value.resolution.revisions) ||
      value.resolution.revisions.length !== entries.length ||
      value.resolution.revisions.some(
        (item: unknown) =>
          !record(item) ||
          typeof item.resourceKey !== 'string' ||
          !hash(item.revision),
      ))
  )
    throw new RepositoryError('RECOVERY_REQUIRED', '復原決議紀錄無法判讀。');
  if (value.directoryReservation !== undefined) {
    const reservation = value.directoryReservation;
    if (
      !record(reservation) ||
      typeof reservation.resourceKey !== 'string' ||
      !uuid(reservation.token) ||
      (reservation.identity !== null &&
        (!record(reservation.identity) ||
          !Number.isSafeInteger(reservation.identity.dev) ||
          !Number.isSafeInteger(reservation.identity.ino)))
    )
      throw new RepositoryError(
        'RECOVERY_REQUIRED',
        '復原目錄所有權紀錄無法判讀。',
      );
    const directory = reservation.resourceKey as string;
    const article = /^content\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(
      directory,
    );
    const media = /^media\/source\/([^/]+)$/.exec(directory);
    const controlledArticle =
      article?.[1] !== undefined && article[1].length <= 80;
    const controlledMedia = media?.[1] !== undefined && uuid(media[1]);
    const children = controlledArticle
      ? /^(?:content\.html|meta\.json)$/
      : /^(?:meta\.json|original\.(?:jpe?g|png|webp|avif|svg|ico|mp4|mov|webm))$/;
    if (
      value.kind !== 'restore' ||
      (!controlledArticle && !controlledMedia) ||
      entries.some(
        (entry) =>
          !entry.resourceKey.startsWith(`${directory}/`) ||
          !children.test(entry.resourceKey.slice(directory.length + 1)),
      ) ||
      Object.keys(reservation).some(
        (key) => !['resourceKey', 'token', 'identity'].includes(key),
      ) ||
      (record(reservation.identity) &&
        (Number(reservation.identity.dev) < 0 ||
          Number(reservation.identity.ino) <= 0 ||
          Object.keys(reservation.identity).some(
            (key) => !['dev', 'ino'].includes(key),
          )))
    )
      throw new RepositoryError(
        'RECOVERY_REQUIRED',
        '復原目錄所有權不符合受控交易範圍。',
      );
  }
  if (
    value.jobCompletion !== undefined &&
    (!record(value.jobCompletion) ||
      !uuid(value.jobCompletion.id) ||
      value.jobCompletion.type !== 'taxonomy' ||
      value.kind !== 'taxonomy' ||
      Object.keys(value.jobCompletion).some(
        (key) => !['id', 'type', 'result'].includes(key),
      ) ||
      !TaxonomyResultSchema.safeParse(value.jobCompletion.result).success)
  )
    throw new RepositoryError(
      'RECOVERY_REQUIRED',
      '工作提交證據不符合受控交易契約。',
    );
  return { ...value, entries } as unknown as Journal;
}
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 50) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item: unknown) => jsonValue(item, depth + 1));
  return (
    record(value) &&
    Object.values(value).every((item) => jsonValue(item, depth + 1))
  );
}
export function newEntry(
  resourceKey: string,
  oldRevision: string | null,
  newRevision: string | null,
  byteSize: number,
): JournalEntry {
  return {
    resourceKey,
    oldRevision,
    newRevision,
    byteSize,
    installed: false,
    fileId: randomUUID(),
  };
}
export function mimeType(
  resourceKey: string,
):
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/avif'
  | 'image/svg+xml'
  | 'image/x-icon'
  | 'video/mp4'
  | 'video/quicktime'
  | 'video/webm'
  | 'application/octet-stream' {
  const extension = extname(resourceKey);
  switch (extension) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}
