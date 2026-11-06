import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ApiErrorSchema } from '@foliohaven/core';
import { RepositoryError } from '../files/io.js';
import { jsonValue, safeFailure } from '../operations/value.js';

export class HttpError extends RepositoryError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
    this.name = 'HttpError';
  }
}
export function header(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const values = request.rawHeaders.filter((_, index) => index % 2 === 0);
  if (values.filter((value) => value.toLowerCase() === name).length > 1)
    throw new HttpError('DUPLICATE_HEADER', '必要標頭不可重複。', 400);
  const value = request.headers[name];
  if (Array.isArray(value))
    throw new HttpError('DUPLICATE_HEADER', '必要標頭不可重複。', 400);
  return value;
}
export function authenticate(request: IncomingMessage, token: string): void {
  const host = header(request, 'host');
  let validHost = false;
  if (host && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/u.test(host)) {
    try {
      const parsed = new URL(`http://${host}`);
      validHost = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    } catch {
      /* 無效Host一律拒絕 */
    }
  }
  const supplied = header(request, 'x-alfred-process-token');
  if (
    !validHost ||
    supplied === undefined ||
    Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
  )
    throw new HttpError('SERVICE_FORBIDDEN', '本機服務驗證失敗。', 403);
}
export function mutationOrigin(request: IncomingMessage): string {
  const origin = header(request, 'origin');
  const observed = header(request, 'x-alfred-studio-origin');
  let valid = false;
  if (origin && origin === observed) {
    try {
      const url = new URL(origin);
      valid =
        ['http:', 'https:'].includes(url.protocol) &&
        url.origin === origin &&
        url.username === '' &&
        url.password === '';
    } catch {
      /* 不反射不合法的來源值 */
    }
  }
  if (!valid || !origin)
    throw new HttpError('ORIGIN_FORBIDDEN', '操作來源與Studio來源不符。', 403);
  return origin;
}
export function requestUrl(request: IncomingMessage): URL {
  const raw = request.url ?? '';
  const path = raw.split('?')[0] ?? '';
  if (
    !raw.startsWith('/') ||
    path.includes('%') ||
    /[\\\p{Cc}]/u.test(path) ||
    path.includes('//') ||
    /(?:^|\/)\.{1,2}(?:\/|$)/u.test(path)
  )
    throw new HttpError('INVALID_REQUEST_PATH', '請求資源路徑不合法。', 400);
  return new URL(raw, 'http://127.0.0.1');
}
export function query(url: URL): Record<string, string> {
  const value: Record<string, string> = {};
  for (const [name, item] of url.searchParams) {
    if (Object.hasOwn(value, name))
      throw new HttpError('INVALID_QUERY', '查詢參數不可重複。', 400);
    Object.defineProperty(value, name, {
      value: item,
      enumerable: true,
      configurable: true,
    });
  }
  return value;
}
export function json(
  response: ServerResponse,
  status: number,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.destroyed || response.writableEnded) return;
  const bytes =
    body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(jsonValue(body)));
  response.writeHead(status, {
    ...(body === undefined
      ? {}
      : { 'Content-Type': 'application/json; charset=utf-8' }),
    'Content-Length': String(bytes.length),
    ...headers,
  });
  response.end(bytes);
}
export function fail(
  response: ServerResponse,
  error: unknown,
  requestId: string,
): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const known = error instanceof RepositoryError;
  const status =
    known && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const safe = safeFailure(error, 'INTERNAL_ERROR');
  const body = ApiErrorSchema.parse({ error: { ...safe, requestId } });
  const headers: Record<string, string> = {};
  if (known && error.etag) headers.ETag = error.etag;
  if (known && 'retryAfter' in error && Number.isSafeInteger(error.retryAfter))
    headers['Retry-After'] = String(error.retryAfter);
  if (known && error.status === 429 && !headers['Retry-After'])
    headers['Retry-After'] = '1';
  if (
    known &&
    'contentRange' in error &&
    typeof error.contentRange === 'string'
  )
    headers['Content-Range'] = error.contentRange;
  if (known && 'operationId' in error && typeof error.operationId === 'string')
    headers.Location = `/api/v1/operations/${error.operationId}`;
  if (status === 413 || status === 408 || status === 415 || status === 400) {
    response.shouldKeepAlive = false;
    headers.Connection = 'close';
  }
  json(response, status, body, headers);
}
export async function readJson(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<unknown> {
  const maximum = 32 * 1024 * 1024;
  const type = header(request, 'content-type');
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type))
    throw new HttpError(
      'UNSUPPORTED_CONTENT_TYPE',
      '請使用UTF-8 application/json。',
      415,
    );
  if (
    header(request, 'content-encoding') !== undefined &&
    request.headers['content-encoding'] !== 'identity'
  )
    throw new HttpError(
      'UNSUPPORTED_CONTENT_ENCODING',
      '不支援壓縮請求內容。',
      415,
    );
  const length = header(request, 'content-length');
  if (
    length !== undefined &&
    (!/^\d+$/u.test(length) || Number(length) > maximum)
  )
    throw new HttpError('REQUEST_TOO_LARGE', 'JSON請求超過32MiB。', 413);
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      request.off('data', data);
      request.off('end', end);
      request.off('aborted', aborted);
      request.off('error', aborted);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) {
        request.pause();
        reject(error);
      } else resolve();
    };
    const data = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maximum)
        finish(new HttpError('REQUEST_TOO_LARGE', 'JSON請求超過32MiB。', 413));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const aborted = () =>
      finish(
        new HttpError('REQUEST_ABORTED', '請求已中止或超過時間限制。', 408),
      );
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, total),
      ),
    ) as unknown;
  } catch {
    throw new HttpError('INVALID_JSON', '請求不是有效的UTF-8 JSON。', 400);
  }
}
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}
export function byteRange(
  raw: string | undefined,
  size: number,
): ByteRange | undefined {
  if (raw === undefined) return undefined;
  const invalid = () =>
    Object.assign(
      new HttpError('RANGE_NOT_SATISFIABLE', '要求的檔案範圍無效。', 416),
      { contentRange: `bytes */${size}` },
    );
  const match = /^bytes=(\d*)-(\d*)$/u.exec(raw);
  if (!match || (match[1] === '' && match[2] === '') || size === 0)
    throw invalid();
  let start: number;
  let end = size - 1;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw invalid();
    start = Math.max(0, size - suffix);
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? end : Math.min(Number(match[2]), end);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      start >= size
    )
      throw invalid();
  }
  return { start, end };
}
export function sliceStream(source: Readable, range: ByteRange): Readable {
  return Readable.from(
    (async function* () {
      let offset = 0;
      try {
        for await (const part of source) {
          const chunk = Buffer.isBuffer(part)
            ? part
            : Buffer.from(part as Uint8Array);
          const next = offset + chunk.length;
          if (next > range.start && offset <= range.end)
            yield chunk.subarray(
              Math.max(0, range.start - offset),
              Math.min(chunk.length, range.end - offset + 1),
            );
          offset = next;
          if (offset > range.end) break;
        }
      } finally {
        source.destroy();
      }
    })(),
  );
}
