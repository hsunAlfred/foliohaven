import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { freemem } from 'node:os';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { CloudflareError, cancelled } from './errors.mjs';
import {
  availableBytes,
  fileBody,
  inspectFile,
  localPath,
  safeKey,
  saveBackup,
} from './r2-files.mjs';

const MIB = 1024 ** 2;
const MAX_OBJECT = 5 * 1024 ** 4 - 5 * 1024 ** 3;
const MAX_PART = 5 * 1024 ** 3 - 5 * MIB;
const CACHE = 'public, max-age=0, must-revalidate';
const SHA = /^[a-f0-9]{64}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const HTTP_FIELDS = [
  'ContentType',
  'CacheControl',
  'ContentDisposition',
  'ContentEncoding',
  'ContentLanguage',
  'Expires',
];
const MUTATING_STATES = new Set([
  'intent',
  'creating',
  'uploading',
  'completing',
  'unknown',
]);

function fail(code, message, options) {
  return new CloudflareError(code, message, options);
}
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(',')}}`;
}
function fingerprint(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}
function httpStatus(error) {
  return error?.$metadata?.httpStatusCode;
}
function absent(error) {
  return (
    httpStatus(error) === 404 || ['NoSuchKey', 'NotFound'].includes(error?.name)
  );
}
function transient(error) {
  return (
    !httpStatus(error) ||
    [408, 429].includes(httpStatus(error)) ||
    httpStatus(error) >= 500
  );
}
function definite(error) {
  return (
    httpStatus(error) >= 400 &&
    httpStatus(error) < 500 &&
    ![408, 429].includes(httpStatus(error))
  );
}

export function multipartSizing(
  byteSize,
  memoryBytes = process.availableMemory?.() ?? freemem(),
) {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > MAX_OBJECT)
    throw fail('R2_OBJECT_TOO_LARGE', '媒體輸出超過 R2 可接受的物件大小。');
  if (byteSize <= 64 * MIB)
    return {
      multipart: false,
      partSize: 0,
      queueSize: 1,
      memoryBudget: 2 * MIB,
    };
  const partSize = Math.max(8 * MIB, Math.ceil(byteSize / 10000 / MIB) * MIB);
  const budget = Math.max(0, memoryBytes - 128 * MIB);
  const queueSize = partSize * 2 + 32 * MIB <= budget ? 2 : 1;
  const memoryBudget = partSize * queueSize + 32 * MIB;
  if (
    partSize > MAX_PART ||
    Math.ceil(byteSize / partSize) > 10000 ||
    memoryBudget > budget
  )
    throw fail(
      'R2_MEMORY_LIMIT',
      '分段上傳所需記憶體不足，請使用可用記憶體較多的環境。',
    );
  return { multipart: true, partSize, queueSize, memoryBudget };
}

function snapshot(response, sha256 = null) {
  const etag = response.ETag;
  const byteSize = response.ContentLength;
  if (
    typeof etag !== 'string' ||
    !etag ||
    etag.startsWith('W/') ||
    /[\r\n]/u.test(etag) ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    byteSize > MAX_OBJECT
  )
    throw fail(
      'R2_REMOTE_INVALID',
      '遠端媒體缺少有效大小或原始強 ETag，無法安全處理。',
    );
  const metadata = {};
  for (const [key, value] of Object.entries(response.Metadata ?? {})) {
    if (typeof value !== 'string')
      throw fail('R2_REMOTE_INVALID', '遠端媒體 metadata 無法判讀。');
    metadata[key.toLowerCase()] = value;
  }
  if (Buffer.byteLength(stable(metadata)) > 8192)
    throw fail('R2_REMOTE_INVALID', '遠端媒體 metadata 超過可接受大小。');
  const headers = {};
  for (const field of HTTP_FIELDS) {
    const value = response[field];
    if (value !== undefined && value !== null)
      headers[field] =
        value instanceof Date ? value.toISOString() : String(value);
  }
  const result = { etag, byteSize, metadata, headers, sha256 };
  result.fingerprint = fingerprint({ etag, byteSize, metadata, headers });
  return result;
}
function managedMetadata(remote) {
  if (!remote) return null;
  const groups = [];
  for (const prefix of ['foliohaven', 'alfred']) {
    const keys = ['sha256', 'byte-size', 'deployment-id'].map(
      (suffix) => `${prefix}-${suffix}`,
    );
    if (!keys.some((key) => Object.hasOwn(remote.metadata, key))) continue;
    const sha256 = remote.metadata[`${prefix}-sha256`];
    const byteSize = remote.metadata[`${prefix}-byte-size`];
    const deploymentId = remote.metadata[`${prefix}-deployment-id`];
    if (
      !SHA.test(sha256 ?? '') ||
      byteSize !== String(remote.byteSize) ||
      !UUID.test(deploymentId ?? '')
    )
      throw fail(
        'R2_METADATA_INVALID',
        'R2 管理標記缺漏或無效，請保留部署紀錄並檢查物件 metadata。',
      );
    groups.push({ sha256, byteSize, deploymentId });
  }
  if (!groups.length) return null;
  if (groups.length === 2 && stable(groups[0]) !== stable(groups[1]))
    throw fail(
      'R2_METADATA_CONFLICT',
      'R2 新舊管理標記不一致，未繼續上傳或還原。',
    );
  return { ...groups[0], fieldCount: groups.length * 3 };
}
function managedSha(remote) {
  return managedMetadata(remote)?.sha256 ?? null;
}
function desired(record, deploymentId) {
  return {
    ContentType: record.mime,
    CacheControl: CACHE,
    Metadata: {
      'foliohaven-sha256': record.sha256,
      'foliohaven-byte-size': String(record.byteSize),
      'foliohaven-deployment-id': deploymentId,
    },
  };
}
function desiredMatches(remote, record, deploymentId, allowPrevious = false) {
  const metadata = managedMetadata(remote);
  return (
    remote?.byteSize === record.byteSize &&
    remote.sha256 === record.sha256 &&
    metadata?.sha256 === record.sha256 &&
    remote.headers.ContentType === record.mime &&
    remote.headers.CacheControl === CACHE &&
    Object.keys(remote.headers).length === 2 &&
    Object.keys(remote.metadata).length === metadata?.fieldCount &&
    (allowPrevious || metadata?.deploymentId === deploymentId)
  );
}
function sameRemote(a, b) {
  return a === null
    ? b === null
    : b !== null && a.fingerprint === b.fingerprint;
}
function originalMatches(remote, original) {
  return (
    remote &&
    original &&
    remote.byteSize === original.byteSize &&
    remote.sha256 === original.sha256 &&
    stable(remote.metadata) === stable(original.metadata) &&
    stable(remote.headers) === stable(original.headers)
  );
}

/** All credentials stay inside this short-lived adapter. No endpoint is accepted from project settings. */
export function createR2({
  config,
  credentials,
  signal,
  onProgress,
  client,
  retryDelayMs = 250,
  timeout = {},
}) {
  const bucket = config.bucketName;
  const ownedClient = !client;
  const s3 =
    client ??
    new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: credentials.R2_ACCESS_KEY_ID,
        secretAccessKey: credentials.R2_SECRET_ACCESS_KEY,
      },
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  const timeouts = {
    read: 30000,
    request: 300000,
    idle: 120000,
    file: 7200000,
    ...timeout,
  };
  let saves = Promise.resolve();
  const persist = (context) => {
    const next = saves.then(() => context.save());
    saves = next.catch(() => undefined);
    return next;
  };
  function progress(context, record, stage, values = {}) {
    (context?.onProgress ?? onProgress)?.({
      service: 'r2',
      path: record?.path,
      stage,
      byteSize: record?.byteSize,
      ...values,
    });
  }
  async function request(
    makeCommand,
    {
      retry = false,
      transfer = false,
      context,
      mark,
      requestSignal = signal,
    } = {},
    consume,
  ) {
    for (let attempt = 1; ; attempt++) {
      cancelled(requestSignal);
      const controller = new AbortController();
      const signals = [
        controller.signal,
        AbortSignal.timeout(transfer ? timeouts.request : timeouts.read),
      ];
      if (requestSignal) signals.push(requestSignal);
      const combined = AbortSignal.any(signals);
      let idleTimer;
      const tick = (bytes = 0) => {
        if (transfer) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => controller.abort(), timeouts.idle);
          idleTimer.unref();
        }
        mark?.(bytes);
      };
      tick();
      try {
        const response = await s3.send(makeCommand(tick), {
          abortSignal: combined,
        });
        const abortBody = () =>
          response.Body?.destroy?.(
            fail('R2_TRANSFER_TIMEOUT', 'R2 傳輸逾時或停滯，請依紀錄重試。', {
              retryable: true,
            }),
          );
        if (response.Body)
          combined.addEventListener('abort', abortBody, { once: true });
        try {
          return consume ? await consume(response, tick, combined) : response;
        } finally {
          combined.removeEventListener('abort', abortBody);
        }
      } catch (error) {
        if (requestSignal?.aborted)
          throw fail('CLOUDFLARE_CANCELLED', '操作已取消。');
        if (
          !retry ||
          !transient(error) ||
          error instanceof CloudflareError ||
          attempt >= 3
        )
          throw error;
        const retryAfter = Number(error?.$response?.headers?.['retry-after']);
        const milliseconds =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : retryDelayMs * 2 ** (attempt - 1);
        if (milliseconds > 60000)
          throw fail(
            'R2_RETRY_LATER',
            'Cloudflare 要求較長等待時間，請稍後依紀錄重試。',
            { retryable: true },
          );
        progress(context, null, 'retry', { attempt });
        await delay(
          milliseconds,
          undefined,
          requestSignal ? { signal: requestSignal } : undefined,
        );
      } finally {
        clearTimeout(idleTimer);
      }
    }
  }
  async function head(path, requestSignal = signal) {
    try {
      const remote = snapshot(
        await request(
          () => new HeadObjectCommand({ Bucket: bucket, Key: path }),
          { retry: true, requestSignal },
        ),
      );
      remote.sha256 = managedSha(remote);
      return remote;
    } catch (error) {
      if (absent(error)) return null;
      if (error instanceof CloudflareError) throw error;
      throw fail(
        'R2_READ_FAILED',
        '無法讀取 R2 媒體狀態，請檢查權限或稍後重試。',
        { retryable: transient(error) },
      );
    }
  }
  async function readHash(path, remote, requestSignal = signal) {
    const hash = await request(
      () =>
        new GetObjectCommand({
          Bucket: bucket,
          Key: path,
          IfMatch: remote.etag,
        }),
      { retry: true, transfer: true, requestSignal },
      async (response, tick, combined) => {
        const digest = createHash('sha256');
        let size = 0;
        if (!response.Body || !response.Body[Symbol.asyncIterator])
          throw fail('R2_REMOTE_INVALID', '遠端媒體沒有可讀取內容。');
        try {
          for await (const part of response.Body) {
            cancelled(combined);
            size += part.length;
            if (size > remote.byteSize)
              throw fail('R2_REMOTE_CHANGED', '遠端媒體在讀取期間改變。');
            digest.update(part);
            tick(part.length);
          }
        } finally {
          response.Body.destroy?.();
        }
        if (size !== remote.byteSize)
          throw fail('R2_REMOTE_CHANGED', '遠端媒體大小與狀態不符。');
        return digest.digest('hex');
      },
    );
    if (!sameRemote(await head(path, requestSignal), remote))
      throw fail('R2_REMOTE_CHANGED', '遠端媒體或 metadata 在讀取期間改變。');
    return hash;
  }
  async function observe(path, verify = false, requestSignal = signal) {
    const remote = await head(path, requestSignal);
    if (remote && (verify || !remote.sha256))
      remote.sha256 = await readHash(path, remote, requestSignal);
    return remote;
  }
  function validate(context, requirePrepared = true) {
    if (
      !UUID.test(context.deploymentId ?? '') ||
      !Array.isArray(context.manifest)
    )
      throw fail('R2_JOURNAL_INVALID', '部署識別或媒體清單無效。');
    const files = context.manifest.filter((file) => file.target === 'r2');
    const paths = new Set();
    for (const file of files) {
      if (
        !safeKey(file.path) ||
        paths.has(file.path) ||
        !Number.isSafeInteger(file.byteSize) ||
        file.byteSize < 0 ||
        !SHA.test(file.sha256 ?? '') ||
        typeof file.mime !== 'string' ||
        !file.mime ||
        /[\r\n]/u.test(file.mime)
      )
        throw fail(
          'R2_MANIFEST_INVALID',
          'R2 清單含無效、重複或不受管理的媒體路徑。',
        );
      paths.add(file.path);
      multipartSizing(file.byteSize);
    }
    if (!requirePrepared) return files;
    const state = context.journal.r2;
    if (
      state?.schemaVersion !== 1 ||
      state.bucketName !== bucket ||
      state.prepared !== true ||
      !Array.isArray(state.records) ||
      state.records.length !== files.length
    )
      throw fail(
        'R2_JOURNAL_INVALID',
        'R2 上傳紀錄缺漏或 bucket 不符，請保留紀錄。',
      );
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const record = state.records[index];
      if (
        record.path !== file.path ||
        record.byteSize !== file.byteSize ||
        record.sha256 !== file.sha256 ||
        record.mime !== file.mime ||
        !['create', 'skip', 'overwrite'].includes(record.action) ||
        typeof record.status !== 'string'
      )
        throw fail('R2_JOURNAL_INVALID', 'R2 紀錄與固定產物清單不符。');
      if (record.backup && record.backup.path !== `backups/r2/${record.path}`)
        throw fail('R2_JOURNAL_INVALID', 'R2 備份位置不符合固定路徑。');
      if (
        record.before &&
        (!SHA.test(record.before.sha256 ?? '') ||
          typeof record.before.etag !== 'string' ||
          typeof record.before.fingerprint !== 'string')
      )
        throw fail('R2_JOURNAL_INVALID', 'R2 原始版本證據無效。');
    }
    return state.records;
  }
  async function checkBucket() {
    try {
      await request(() => new HeadBucketCommand({ Bucket: bucket }), {
        retry: true,
      });
    } catch (error) {
      if (error instanceof CloudflareError) throw error;
      throw fail(
        'R2_BUCKET_UNAVAILABLE',
        '無法存取指定 R2 bucket；請確認已建立、採預設 jurisdiction，且憑證有該 bucket 權限。',
        { retryable: transient(error) },
      );
    }
  }
  async function prepare(context) {
    const files = validate(context, false);
    if (context.journal.r2)
      throw fail(
        'R2_ALREADY_PREPARED',
        '此部署已有 R2 紀錄，請先查詢狀態，不重建備份基底。',
      );
    context.journal.r2 = {
      schemaVersion: 1,
      bucketName: bucket,
      prepared: false,
      records: [],
    };
    await persist(context);
    const records = context.journal.r2.records;
    for (const file of files) {
      cancelled(context.signal ?? signal);
      const inspected = await inspectFile(
        context.root,
        `source/${file.path}`,
        context.signal ?? signal,
      );
      if (
        inspected.sha256 !== file.sha256 ||
        inspected.byteSize !== file.byteSize
      )
        throw fail(
          'R2_LOCAL_FILE_CHANGED',
          '媒體副本與固定清單不符，未開始上傳。',
        );
      const before = await observe(file.path, false, context.signal ?? signal);
      const action = desiredMatches(before, file, context.deploymentId, true)
        ? 'skip'
        : before
          ? 'overwrite'
          : 'create';
      records.push({
        path: file.path,
        byteSize: file.byteSize,
        sha256: file.sha256,
        mime: file.mime,
        action,
        status: action === 'skip' ? 'skipped' : 'planned',
        before,
        after: null,
        backup: null,
        upload: null,
        restore: null,
      });
      progress(context, file, 'planned', { action });
    }
    const backupBytes = records.reduce(
      (total, record) =>
        total +
        (record.action === 'overwrite' ? BigInt(record.before.byteSize) : 0n),
      0n,
    );
    if ((await availableBytes(context.root)) < backupBytes + 16n * BigInt(MIB))
      throw fail(
        'R2_BACKUP_SPACE',
        '可用磁碟不足以完整備份所有將覆寫的媒體，未開始上傳。',
      );
    await persist(context);
    for (const record of records.filter(
      (item) => item.action === 'overwrite',
    )) {
      const requestSignal = context.signal ?? signal;
      record.backup = await request(
        () =>
          new GetObjectCommand({
            Bucket: bucket,
            Key: record.path,
            IfMatch: record.before.etag,
          }),
        { retry: true, transfer: true, requestSignal },
        async (response, tick, combined) => {
          if (!response.Body || !response.Body[Symbol.asyncIterator])
            throw fail('R2_REMOTE_INVALID', '媒體備份回應沒有可讀取內容。');
          try {
            return await saveBackup(
              context.root,
              `backups/r2/${record.path}`,
              response.Body,
              record.before,
              tick,
              combined,
            );
          } finally {
            response.Body.destroy?.();
          }
        },
      );
      if (!sameRemote(await head(record.path, requestSignal), record.before))
        throw fail(
          'R2_REMOTE_CHANGED',
          '備份期間遠端媒體或 metadata 已改變，未開始上傳。',
        );
      await persist(context);
      progress(context, record, 'backed-up', {
        confirmedBytes: record.before.byteSize,
      });
    }
    // Check every base after the complete backup barrier, including skipped and new objects.
    for (const record of records)
      if (
        !sameRemote(
          await head(record.path, context.signal ?? signal),
          record.before,
        )
      )
        throw fail(
          'R2_REMOTE_CHANGED',
          '媒體在規劃與備份期間已改變，未開始上傳。',
        );
    context.journal.r2.prepared = true;
    await persist(context);
    return records;
  }
  async function reconcileMutation(
    context,
    record,
    error,
    expected,
    restore = false,
  ) {
    let remote;
    try {
      remote = await observe(
        record.path,
        restore || error?.code === 'R2_LOCAL_FILE_CHANGED',
        signal,
      );
    } catch {
      /* An unreadable result remains unknown. */
    }
    if (
      restore
        ? originalMatches(remote, expected)
        : desiredMatches(remote, record, context.deploymentId)
    )
      return remote;
    if (definite(error)) {
      if (restore) record.restore.status = 'conflict';
      else record.status = 'conflict';
      await persist(context);
      throw fail(
        'R2_WRITE_REJECTED',
        'R2 拒絕寫入或遠端已改變；未自動覆蓋，請先查詢部署狀態。',
      );
    }
    if (restore) record.restore.status = 'unknown';
    else record.status = 'unknown';
    await persist(context);
    throw fail(
      'R2_RESULT_UNKNOWN',
      'R2 寫入結果尚未確認；請先查詢狀態，不要重新發布或還原。',
      { unknown: true },
    );
  }
  async function multipart(
    context,
    record,
    relative,
    expected,
    content,
    base,
    restore,
    requestSignal,
  ) {
    const sizing = multipartSizing(expected.byteSize);
    const transfer = {
      phase: 'creating',
      uploadId: null,
      parts: [],
      partSize: sizing.partSize,
      queueSize: sizing.queueSize,
      memoryBudget: sizing.memoryBudget,
    };
    if (restore) record.restore.upload = transfer;
    else record.upload = transfer;
    await persist(context);
    let completing = false;
    let handle;
    const pending = new Set();
    const partController = new AbortController();
    const partSignal = requestSignal
      ? AbortSignal.any([requestSignal, partController.signal])
      : partController.signal;
    try {
      const created = await request(
        () =>
          new CreateMultipartUploadCommand({
            Bucket: bucket,
            Key: record.path,
            ...content,
          }),
        { requestSignal, context },
      );
      if (typeof created.UploadId !== 'string' || !created.UploadId)
        throw fail(
          'R2_RESULT_UNKNOWN',
          'R2 未回傳有效分段識別，請先查詢狀態。',
          { unknown: true },
        );
      transfer.uploadId = created.UploadId;
      transfer.phase = 'uploading';
      await persist(context);
      handle = await open(
        await localPath(context.root, relative),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const beforeFile = await handle.stat({ bigint: true });
      if (!beforeFile.isFile() || beforeFile.size !== BigInt(expected.byteSize))
        throw fail('R2_LOCAL_FILE_CHANGED', '分段媒體副本已改變。');
      const hash = createHash('sha256');
      let offset = 0;
      let number = 0;
      let partError;
      while (offset < expected.byteSize) {
        cancelled(requestSignal);
        if (pending.size >= sizing.queueSize) await Promise.race(pending);
        if (partError) throw partError;
        const buffer = Buffer.alloc(
          Math.min(sizing.partSize, expected.byteSize - offset),
        );
        let filled = 0;
        while (filled < buffer.length) {
          const read = await handle.read(
            buffer,
            filled,
            buffer.length - filled,
            offset + filled,
          );
          if (!read.bytesRead)
            throw fail('R2_LOCAL_FILE_CHANGED', '媒體副本在分段期間縮短。');
          filled += read.bytesRead;
        }
        hash.update(buffer);
        offset += filled;
        number++;
        const partNumber = number;
        const md5 = createHash('md5').update(buffer).digest('base64');
        let task;
        task = request(
          (tick) =>
            new UploadPartCommand({
              Bucket: bucket,
              Key: record.path,
              UploadId: transfer.uploadId,
              PartNumber: partNumber,
              ContentLength: buffer.length,
              ContentMD5: md5,
              Body: Readable.from(
                (function* () {
                  for (let start = 0; start < buffer.length; start += 65536) {
                    const chunk = buffer.subarray(start, start + 65536);
                    tick(chunk.length);
                    yield chunk;
                  }
                })(),
              ),
            }),
          { retry: true, transfer: true, requestSignal: partSignal, context },
          async (response) => {
            if (typeof response.ETag !== 'string' || !response.ETag)
              throw fail('R2_PART_INVALID', 'R2 分段回應缺少 ETag。');
            transfer.parts.push({
              PartNumber: partNumber,
              ETag: response.ETag,
              byteSize: buffer.length,
            });
            await persist(context);
            progress(context, record, 'part-complete', {
              confirmedBytes: transfer.parts.reduce(
                (total, part) => total + part.byteSize,
                0,
              ),
              partNumber,
            });
          },
        )
          .catch((error) => {
            partError ??= error;
            partController.abort();
          })
          .finally(() => pending.delete(task));
        pending.add(task);
      }
      await Promise.all(pending);
      if (partError) throw partError;
      const afterFile = await handle.stat({ bigint: true });
      if (
        hash.digest('hex') !== expected.sha256 ||
        ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(
          (field) => beforeFile[field] !== afterFile[field],
        )
      )
        throw fail('R2_LOCAL_FILE_CHANGED', '媒體副本在分段期間改變。');
      if (!sameRemote(await head(record.path, requestSignal), base))
        throw fail(
          'R2_REMOTE_CHANGED',
          '分段上傳期間遠端基底已改變，未完成覆寫。',
        );
      transfer.phase = 'completing';
      await persist(context);
      completing = true;
      await request(
        () =>
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: record.path,
            UploadId: transfer.uploadId,
            MultipartUpload: {
              Parts: transfer.parts
                .sort((a, b) => a.PartNumber - b.PartNumber)
                .map(({ ETag, PartNumber }) => ({ ETag, PartNumber })),
            },
          }),
        { transfer: true, requestSignal, context },
      );
      transfer.phase = 'complete';
      await persist(context);
    } catch (error) {
      partController.abort();
      await Promise.all(pending);
      if (!completing && transfer.uploadId) {
        try {
          await request(
            () =>
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: record.path,
                UploadId: transfer.uploadId,
              }),
            { requestSignal: AbortSignal.timeout(timeouts.read) },
          );
          transfer.phase = 'aborted';
          await persist(context);
        } catch {
          transfer.phase = 'abort-unknown';
          await persist(context);
        }
        throw error;
      }
      return await reconcileMutation(context, record, error, expected, restore);
    } finally {
      await handle?.close();
    }
  }
  async function sendFile(
    context,
    record,
    relative,
    expected,
    content,
    base,
    restore = false,
  ) {
    const signals = [AbortSignal.timeout(timeouts.file)];
    if (context.signal ?? signal) signals.push(context.signal ?? signal);
    const fileSignal = AbortSignal.any(signals);
    const sizing = multipartSizing(expected.byteSize);
    progress(context, record, restore ? 'restoring' : 'uploading', {
      confirmedBytes: 0,
      memoryBudget: sizing.memoryBudget,
    });
    if (sizing.multipart)
      await multipart(
        context,
        record,
        relative,
        expected,
        content,
        base,
        restore,
        fileSignal,
      );
    else {
      const inspected = await inspectFile(context.root, relative, fileSignal);
      if (
        inspected.sha256 !== expected.sha256 ||
        inspected.byteSize !== expected.byteSize
      )
        throw fail('R2_LOCAL_FILE_CHANGED', '媒體副本與固定清單不符。');
      let body;
      try {
        let mark = () => undefined;
        let readBytes = 0;
        body = await fileBody(
          context.root,
          relative,
          expected,
          (bytes) => {
            readBytes += bytes;
            mark(bytes);
            progress(context, record, 'reading', { readBytes });
          },
          fileSignal,
        );
        await request(
          (tick) => {
            mark = tick;
            return new PutObjectCommand({
              Bucket: bucket,
              Key: record.path,
              ...content,
              ContentLength: expected.byteSize,
              ContentMD5: inspected.md5,
              Body: body.stream,
              ...(base ? { IfMatch: base.etag } : { IfNoneMatch: '*' }),
            });
          },
          { transfer: true, requestSignal: fileSignal, context },
          async () => {
            await body.finish();
          },
        );
      } catch (error) {
        return await reconcileMutation(
          context,
          record,
          error,
          expected,
          restore,
        );
      } finally {
        await body?.close();
      }
    }
    let remote;
    try {
      remote = await observe(record.path, false, fileSignal);
    } catch {
      throw fail(
        'R2_RESULT_UNKNOWN',
        'R2 已送出寫入，但尚無法核對結果；請先查詢狀態，不要重新發布或還原。',
        { unknown: true },
      );
    }
    if (
      !(restore
        ? originalMatches(remote, expected)
        : desiredMatches(remote, record, context.deploymentId))
    )
      throw fail(
        'R2_RESULT_UNKNOWN',
        'R2 寫入後證據與預期不符，請先查詢狀態。',
        { unknown: true },
      );
    return remote;
  }
  async function upload(context) {
    const records = validate(context);
    // The persistence boundary between preparation and upload may be long. Recheck
    // every local backup and source before allowing the first remote mutation.
    for (const record of records) {
      if (record.status === 'planned') {
        const source = await inspectFile(
          context.root,
          `source/${record.path}`,
          context.signal ?? signal,
        );
        if (
          source.sha256 !== record.sha256 ||
          source.byteSize !== record.byteSize
        )
          throw fail(
            'R2_LOCAL_FILE_CHANGED',
            '媒體副本與固定清單不符，未開始本輪上傳。',
          );
        if (record.action === 'overwrite') {
          const backup = await inspectFile(
            context.root,
            record.backup?.path ?? '',
            context.signal ?? signal,
          );
          if (
            backup.sha256 !== record.before.sha256 ||
            backup.byteSize !== record.before.byteSize
          )
            throw fail(
              'R2_BACKUP_INVALID',
              '覆寫備份缺漏或損壞，未開始本輪上傳。',
            );
        }
      } else if (!['skipped', 'uploaded'].includes(record.status)) {
        throw fail(
          'R2_RESULT_UNKNOWN',
          '此部署有未解寫入紀錄，請先查詢狀態。',
          { unknown: true },
        );
      }
      if (
        !sameRemote(
          await head(record.path, context.signal ?? signal),
          record.after ?? record.before,
        )
      )
        throw fail(
          'R2_REMOTE_CHANGED',
          '媒體在上傳前已被修改，未開始本輪上傳。',
        );
    }
    for (const record of records) {
      if (record.status === 'skipped' || record.status === 'uploaded') {
        if (
          !sameRemote(
            await head(record.path, context.signal ?? signal),
            record.after ?? record.before,
          )
        )
          throw fail('R2_REMOTE_CHANGED', '已核對的媒體已被其他發布者修改。');
        continue;
      }
      if (record.status !== 'planned')
        throw fail(
          'R2_RESULT_UNKNOWN',
          '此部署有未解寫入紀錄，請先查詢狀態。',
          { unknown: true },
        );
      if (
        !sameRemote(
          await head(record.path, context.signal ?? signal),
          record.before,
        )
      )
        throw fail('R2_REMOTE_CHANGED', '上傳前遠端媒體或 metadata 已改變。');
      if (record.action === 'overwrite') {
        const backup = await inspectFile(
          context.root,
          record.backup?.path ?? '',
          context.signal ?? signal,
        );
        if (
          backup.sha256 !== record.before.sha256 ||
          backup.byteSize !== record.before.byteSize
        )
          throw fail('R2_BACKUP_INVALID', '覆寫備份缺漏或損壞，未上傳此媒體。');
      }
      record.status = 'intent';
      await persist(context);
      try {
        record.after = await sendFile(
          context,
          record,
          `source/${record.path}`,
          record,
          desired(record, context.deploymentId),
          record.before,
        );
        record.status = 'uploaded';
        await persist(context);
        progress(context, record, 'verified', {
          confirmedBytes: record.byteSize,
        });
      } catch (error) {
        if (record.status === 'intent')
          record.status = error.unknown ? 'unknown' : 'failed';
        await persist(context);
        if (error instanceof CloudflareError) throw error;
        throw fail(
          'R2_UPLOAD_FAILED',
          'R2 媒體上傳未完成，請保留紀錄並查詢狀態。',
          { retryable: transient(error) },
        );
      }
    }
    return records;
  }
  async function status(context, { verifyContent = false } = {}) {
    const records = validate(context);
    const conflicts = [];
    let unknown = false;
    for (const record of records) {
      const remote = await observe(
        record.path,
        verifyContent,
        context.signal ?? signal,
      );
      if (record.restore?.status === 'restored') {
        if (
          !sameRemote(remote, record.restore.after) ||
          (verifyContent && remote?.sha256 !== record.restore.after?.sha256)
        )
          conflicts.push(record.path);
      } else if (
        record.restore?.status === 'intent' ||
        record.restore?.status === 'unknown'
      ) {
        const full = remote && {
          ...remote,
          sha256: await readHash(record.path, remote, context.signal ?? signal),
        };
        if (originalMatches(full, record.before)) {
          record.restore.status = 'restored';
          record.restore.after = full;
          await persist(context);
        } else unknown = true;
      } else if (MUTATING_STATES.has(record.status)) {
        if (desiredMatches(remote, record, context.deploymentId)) {
          record.after = remote;
          record.status = 'uploaded';
          await persist(context);
        } else unknown = true;
      } else if (
        !sameRemote(remote, record.after ?? record.before) ||
        (verifyContent &&
          remote?.sha256 !== (record.after ?? record.before)?.sha256)
      )
        conflicts.push(record.path);
    }
    return {
      complete:
        !unknown &&
        conflicts.length === 0 &&
        records.every((record) =>
          ['uploaded', 'skipped'].includes(record.status),
        ),
      unknown,
      conflicts,
      records,
    };
  }
  async function preflightRestore(context) {
    const records = validate(context);
    for (const record of records) {
      if (
        MUTATING_STATES.has(record.status) ||
        ['intent', 'unknown', 'conflict'].includes(record.restore?.status)
      )
        throw fail(
          'R2_RESULT_UNKNOWN',
          '仍有未解寫入或還原結果，請先查詢狀態。',
          { unknown: true },
        );
      const expected =
        record.restore?.status === 'restored'
          ? record.restore.after
          : (record.after ?? record.before);
      if (
        !sameRemote(await head(record.path, context.signal ?? signal), expected)
      )
        throw fail(
          'R2_RESTORE_CONFLICT',
          '媒體已被後續部署或外部修改，停止整批還原。',
        );
      if (record.action === 'overwrite' && record.status === 'uploaded') {
        const backup = await inspectFile(
          context.root,
          record.backup?.path ?? '',
          context.signal ?? signal,
        );
        if (
          backup.sha256 !== record.before.sha256 ||
          backup.byteSize !== record.before.byteSize
        )
          throw fail(
            'R2_BACKUP_INVALID',
            '媒體還原備份缺漏或損壞，停止整批還原。',
          );
        multipartSizing(backup.byteSize);
      }
    }
    return { ready: true, records };
  }
  async function restore(context) {
    await preflightRestore(context);
    for (const record of context.journal.r2.records) {
      if (record.restore?.status === 'restored') continue;
      if (record.action !== 'overwrite' || record.status !== 'uploaded') {
        record.restore = {
          status:
            record.action === 'create' && record.status === 'uploaded'
              ? 'retained-new'
              : 'unchanged',
        };
        await persist(context);
        continue;
      }
      const current = await head(record.path, context.signal ?? signal);
      if (!sameRemote(current, record.after))
        throw fail('R2_RESTORE_CONFLICT', '還原前媒體已改變，停止後續還原。');
      record.restore = { status: 'intent', after: null };
      await persist(context);
      try {
        const content = {
          ...record.before.headers,
          Metadata: record.before.metadata,
        };
        if (content.Expires) content.Expires = new Date(content.Expires);
        record.restore.after = await sendFile(
          context,
          record,
          record.backup.path,
          record.before,
          content,
          current,
          true,
        );
        record.restore.status = 'restored';
        await persist(context);
      } catch (error) {
        if (record.restore.status === 'intent')
          record.restore.status = error.unknown ? 'unknown' : 'failed';
        await persist(context);
        throw error;
      }
    }
    context.journal.r2.restoreComplete = true;
    await persist(context);
    return { complete: true, records: context.journal.r2.records };
  }
  return {
    checkBucket,
    prepare,
    upload,
    status,
    preflightRestore,
    restore,
    destroy: () => {
      if (ownedClient) s3.destroy();
    },
  };
}
