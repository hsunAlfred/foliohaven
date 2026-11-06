import { createHash } from 'node:crypto';
import { SafeErrorSchema } from '@foliohaven/core';
import type { JsonValue, SafeError } from '@foliohaven/core';
import { RepositoryError } from '../files/io.js';

export function jsonValue(value: unknown): JsonValue {
  const active = new Set<object>();
  const visit = (item: unknown, depth: number): JsonValue => {
    if (depth > 50)
      throw new RepositoryError(
        'INVALID_JSON_VALUE',
        '資料巢狀層級超過限制。',
        422,
      );
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (
      typeof item !== 'object' ||
      item === null ||
      (!Array.isArray(item) &&
        ![Object.prototype, null].includes(
          Object.getPrototypeOf(item) as object | null,
        ))
    )
      throw new RepositoryError(
        'INVALID_JSON_VALUE',
        '資料必須是可序列化的 JSON。',
        422,
      );
    if (active.has(item))
      throw new RepositoryError(
        'INVALID_JSON_VALUE',
        '資料不可循環引用。',
        422,
      );
    active.add(item);
    let result: JsonValue;
    if (Array.isArray(item))
      result = Array.from(item, (child: unknown) => visit(child, depth + 1));
    else
      result = Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [
            key,
            visit((item as Record<string, unknown>)[key], depth + 1),
          ]),
      );
    active.delete(item);
    return result;
  };
  return visit(value, 0);
}
export function canonicalPayloadHash(kind: string, payload: unknown): string {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(kind))
    throw new RepositoryError('INVALID_OPERATION_KIND', '操作種類無效。', 422);
  return createHash('sha256')
    .update(JSON.stringify([kind, jsonValue(payload)]))
    .digest('hex');
}
export function safeFailure(
  error: unknown,
  fallback = 'JOB_FAILED',
): SafeError {
  if (error instanceof RepositoryError) {
    const parsed = SafeErrorSchema.safeParse({
      code: error.code,
      message: error.message,
      retryable: 'retryable' in error ? error.retryable : false,
      issues: 'issues' in error ? error.issues : [],
    });
    if (parsed.success) return parsed.data;
  }
  return {
    code: fallback,
    message: '工作未完成，請檢查階段及來源後重新建立工作。',
    retryable: false,
    issues: [],
  };
}
