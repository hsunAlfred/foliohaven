import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import {
  MediaSourceSchema,
  UuidSchema,
  CONTENT_LIMITS,
} from '@foliohaven/core';
import type { MediaSource } from '@foliohaven/core';
import type { ReadSession } from '../files/types.js';
import { safePath, sha256 } from '../files/io.js';
import { MediaError } from './errors.js';
import type { SourceState } from './types.js';
import type { FileRevisionCache } from '../files/revision-cache.js';

export type MediaDigestCache = FileRevisionCache<{
  readonly sha256: string;
  readonly byteSize: number;
}>;

export function sourceKeys(
  id: string,
  source: string,
): readonly [string, string] {
  if (
    !UuidSchema.safeParse(id).success ||
    !/^original\.(?:jpe?g|png|webp|avif|svg|ico|mp4|mov|webm)$/u.test(source)
  )
    throw new MediaError('MEDIA_ID_INVALID', '媒體識別或來源名稱不合法。', 400);
  return [`media/source/${id}/${source}`, `media/source/${id}/meta.json`];
}
export function metadataBytes(source: MediaSource): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  if (bytes.length > CONTENT_LIMITS.mediaMetaBytes)
    throw new MediaError(
      'MEDIA_METADATA_TOO_LARGE',
      '媒體設定超出大小上限。',
      413,
    );
  return bytes;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function streamHash(
  path: string,
  cache?: MediaDigestCache,
): Promise<{ sha256: string; byteSize: number }> {
  return cache === undefined
    ? uncachedStreamHash(path)
    : cache.read([path], () => uncachedStreamHash(path));
}
async function uncachedStreamHash(
  path: string,
): Promise<{ sha256: string; byteSize: number }> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new MediaError('MEDIA_SOURCE_INVALID', '媒體必須是一般檔案。');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += (chunk as Buffer).length;
    }
    if (size !== stat.size)
      throw new MediaError(
        'MEDIA_SOURCE_CHANGED',
        '媒體來源在讀取期間變更。',
        412,
      );
    return { sha256: hash.digest('hex'), byteSize: size };
  } finally {
    await handle.close();
  }
}
export async function readSourceState(
  root: string,
  session: ReadSession,
  id: string,
  cache?: MediaDigestCache,
): Promise<SourceState> {
  if (!UuidSchema.safeParse(id).success)
    throw new MediaError('MEDIA_ID_INVALID', '媒體識別不合法。', 400);
  const raw = await session.read(`media/source/${id}/meta.json`);
  if (raw === null)
    throw new MediaError('MEDIA_NOT_FOUND', '媒體來源不存在。', 404);
  if (raw.bytes.length > CONTENT_LIMITS.mediaMetaBytes)
    throw new MediaError('MEDIA_METADATA_TOO_LARGE', '媒體設定超出大小上限。');
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        raw.bytes,
      ),
    );
  } catch {
    throw new MediaError(
      'MEDIA_METADATA_INVALID',
      '媒體設定不是有效UTF-8 JSON。',
    );
  }
  const parsed = MediaSourceSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.id !== id)
    throw new MediaError(
      'MEDIA_METADATA_INVALID',
      '媒體設定與來源識別不一致。',
    );
  const keys = sourceKeys(id, parsed.data.source);
  let original;
  try {
    original = await streamHash(await safePath(root, keys[0]), cache);
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError('MEDIA_SOURCE_MISSING', '媒體原檔缺失或無法讀取。');
  }
  if (
    original.byteSize === 0 ||
    original.byteSize >
      (parsed.data.kind === 'image'
        ? CONTENT_LIMITS.imageSourceBytes
        : CONTENT_LIMITS.videoSourceBytes)
  )
    throw new MediaError(
      'MEDIA_SOURCE_TOO_LARGE',
      '媒體來源超出大小限制。',
      413,
    );
  return {
    source: parsed.data,
    metaRevision: raw.revision,
    sourceRevision: original.sha256,
    byteSize: original.byteSize,
    etag: await session.etag(keys),
  };
}
/** Same length-boundary framing as FileRepository, before the new resource exists. */
export async function stagedEtag(
  root: string,
  id: string,
  source: string,
  preparedId: string,
  meta: Buffer,
): Promise<string> {
  if (!UuidSchema.safeParse(preparedId).success)
    throw new MediaError('MEDIA_STAGE_INVALID', '媒體暫存識別不合法。', 400);
  const keys = sourceKeys(id, source);
  const hash = createHash('sha256');
  const length = (size: number) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(size));
    return buffer;
  };
  for (const key of [...keys].sort()) {
    const keyBytes = Buffer.from(key);
    hash
      .update(length(keyBytes.length))
      .update(keyBytes)
      .update(Buffer.from([1]));
    if (key.endsWith('/meta.json'))
      hash.update(length(meta.length)).update(meta);
    else {
      const path = await safePath(root, `.alfred/staging/${preparedId}.part`);
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        hash.update(length((await handle.stat()).size));
        for await (const chunk of handle.createReadStream({ autoClose: false }))
          hash.update(chunk);
      } finally {
        await handle.close();
      }
    }
  }
  return `"${hash.digest('hex')}"`;
}
export async function hashOutputs(
  root: string,
  processingHash: string,
  outputs: readonly { variant: string; sha256: string; byteSize: number }[],
  cache?: MediaDigestCache,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/u.test(processingHash)) return false;
  try {
    for (const output of outputs) {
      if (
        !/^(?:image(?:-(?:[1-9]\d*|social(?:-crop)?))?\.webp|(?:image|mask-icon)\.svg|favicon\.(?:png|ico)|favicon-(?:16|48)\.png|apple-touch-icon\.png|icon-(?:192|512)\.png|video\.webm|poster\.webp)$/u.test(
          output.variant,
        )
      )
        return false;
      const actual = await streamHash(
        await safePath(
          root,
          `.alfred/media/${processingHash}/${output.variant}`,
        ),
        cache,
      );
      if (
        actual.sha256 !== output.sha256 ||
        actual.byteSize !== output.byteSize
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
export const processingDigest = (value: unknown) =>
  sha256(Buffer.from(canonical(value)));
export { createReadStream };
