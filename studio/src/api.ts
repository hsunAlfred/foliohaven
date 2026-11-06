import { ApiErrorSchema } from '@foliohaven/core';
import type { ApiIssue } from '@foliohaven/core';

export interface ApiResponse<T> {
  readonly data: T;
  readonly etag: string | null;
  readonly location: string | null;
  readonly requestId: string | null;
}
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: readonly ApiIssue[] = [],
    readonly requestId: string | null = null,
    readonly location: string | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}
export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly etag?: string;
  readonly idempotencyKey?: string;
  readonly editorId?: string;
}
export interface Command {
  readonly label: string;
  readonly path: string;
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly etag?: string;
  readonly idempotencyKey?: string;
}
export interface PendingCommand {
  readonly command: Command;
  readonly error: ApiFailure;
}
const pause = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('操作已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
export function apiPath(path: string): string {
  const url = new URL(path, 'http://studio.invalid');
  if (
    !path.startsWith('/api/v1/') ||
    path.includes('\\') ||
    url.origin !== 'http://studio.invalid' ||
    url.hash !== '' ||
    !url.pathname.startsWith('/api/v1/')
  )
    throw new ApiFailure(400, 'INVALID_API_PATH', '只能操作本站工作室 API。');
  return `${url.pathname}${url.search}`;
}
export class StudioApi {
  constructor(
    readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    readonly wait: (
      milliseconds: number,
      signal?: AbortSignal,
    ) => Promise<void> = pause,
  ) {}
  async #request<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<ApiResponse<T>> {
    const headers = new Headers({ Accept: 'application/json' });
    if (options.etag !== undefined) headers.set('If-Match', options.etag);
    if (options.idempotencyKey !== undefined)
      headers.set('Idempotency-Key', options.idempotencyKey);
    if (options.editorId !== undefined)
      headers.set('x-alfred-editor-id', options.editorId);
    const form = body instanceof FormData;
    if (body !== undefined && !form)
      headers.set('Content-Type', 'application/json');
    const target = apiPath(path);
    let response: Response;
    try {
      response = await this.fetcher(target, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        ...(body === undefined
          ? {}
          : { body: form ? body : JSON.stringify(body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      )
        throw error;
      throw new ApiFailure(
        0,
        'SERVICE_UNAVAILABLE',
        '無法連線至本機服務；編輯內容仍保留。',
        [],
        null,
        null,
        true,
      );
    }
    const requestId = response.headers.get('X-Request-Id');
    const location = response.headers.get('Location');
    let value: unknown;
    if (response.status !== 204) {
      try {
        value = await response.json();
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new ApiFailure(
          response.status,
          'INVALID_API_RESPONSE',
          '本機服務未回傳有效 JSON。',
          [],
          requestId,
          location,
        );
      }
    }
    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(value);
      if (!parsed.success)
        throw new ApiFailure(
          response.status,
          'INVALID_API_RESPONSE',
          '本機服務錯誤回應不符合契約。',
          [],
          requestId,
          location,
        );
      const issue = parsed.data.error;
      throw new ApiFailure(
        response.status,
        issue.code,
        issue.message,
        issue.issues,
        issue.requestId,
        location,
        issue.retryable,
      );
    }
    return {
      data: value as T,
      etag: response.headers.get('ETag'),
      location,
      requestId,
    };
  }
  async get<T>(
    path: string,
    options: Pick<RequestOptions, 'signal'> = {},
  ): Promise<ApiResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#request<T>('GET', path, undefined, options);
      } catch (error) {
        if (
          !(error instanceof ApiFailure) ||
          attempt >= 3 ||
          ![0, 408, 429, 500, 502, 503, 504].includes(error.status)
        )
          throw error;
        await this.wait(1000 * 2 ** attempt, options.signal);
      }
    }
  }
  send<T>(
    method: Command['method'],
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.#request<T>(method, path, body, options);
  }
  execute<T>(command: Command): Promise<ApiResponse<T>> {
    return this.send<T>(command.method, command.path, command.body, {
      ...(command.etag === undefined ? {} : { etag: command.etag }),
      ...(command.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: command.idempotencyKey }),
    });
  }
}
export const queryPath = (
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') query.set(key, String(value));
  return `/api/v1/${path}${query.size ? `?${query}` : ''}`;
};
export function newKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // LAN HTTP may lack randomUUID; getRandomValues still supplies secure bytes.
  const hex = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (value, index) => {
      if (index === 6) value = (value & 0x0f) | 0x40;
      if (index === 8) value = (value & 0x3f) | 0x80;
      return value.toString(16).padStart(2, '0');
    },
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const isAborted = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';
export function messageOf(error: unknown): string {
  return error instanceof ApiFailure
    ? error.message
    : error instanceof Error && error.name === 'ZodError'
      ? '欄位格式不符合規則，請檢查標示內容。'
      : '操作未完成，請重新檢查本機服務。';
}
