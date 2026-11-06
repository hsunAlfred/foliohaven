import { readdir } from 'node:fs/promises';
import {
  MediaAssetSchema,
  MediaResultSchema,
  MediaSourceResourceSchema,
  UtcDateTimeSchema,
  UuidSchema,
} from '@foliohaven/core';
import type { MediaJobRequest, MediaResult } from '@foliohaven/core';
import {
  atomicJson,
  isMissing,
  readOptional,
  record,
  safeMkdir,
  safePath,
} from '../files/io.js';
import { MediaError } from './errors.js';
import { processingDigest } from './storage.js';
import type { Binding, MediaInspection, SourceState } from './types.js';

interface MediaReceipt {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly preset: MediaJobRequest['preset'];
  readonly committedAt: string;
  readonly result: MediaResult;
  readonly binding: Binding;
}
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

export function parseBinding(candidate: unknown, id: string): Binding | null {
  if (
    !record(candidate) ||
    !exact(candidate, [
      'schemaVersion',
      'sourceRevision',
      'metaRevision',
      'processingHash',
      'inspection',
      'asset',
    ]) ||
    candidate.schemaVersion !== 1 ||
    !digest(candidate.sourceRevision) ||
    !digest(candidate.metaRevision) ||
    !digest(candidate.processingHash) ||
    !record(candidate.inspection)
  )
    return null;
  const asset = MediaAssetSchema.safeParse(candidate.asset);
  if (
    !asset.success ||
    asset.data.id !== id ||
    asset.data.sourceSha256 !== candidate.sourceRevision
  )
    return null;
  const inspection = candidate.inspection;
  if (
    !exact(inspection, [
      'kind',
      'aspectRatio',
      'mimeType',
      'width',
      'height',
      'durationSeconds',
      'fps',
      'audio',
      'streamIndex',
    ]) ||
    typeof inspection.aspectRatio !== 'number' ||
    !Number.isFinite(inspection.aspectRatio) ||
    inspection.aspectRatio <= 0 ||
    inspection.kind !== asset.data.kind ||
    typeof inspection.audio !== 'boolean'
  )
    return null;
  if (
    asset.data.kind === 'image'
      ? inspection.fps !== null ||
        inspection.streamIndex !== null ||
        inspection.audio
      : typeof inspection.fps !== 'number' ||
        !Number.isFinite(inspection.fps) ||
        inspection.fps <= 0 ||
        inspection.fps > 60 ||
        typeof inspection.streamIndex !== 'number' ||
        !Number.isSafeInteger(inspection.streamIndex) ||
        inspection.streamIndex < 0
  )
    return null;
  if (
    !MediaSourceResourceSchema.safeParse({
      id,
      kind: asset.data.kind,
      displayName: 'cache',
      posterTimeSeconds: null,
      mimeType: inspection.mimeType,
      byteSize: 1,
      width: inspection.width,
      height: inspection.height,
      durationSeconds: inspection.durationSeconds,
      sourceSha256: candidate.sourceRevision,
      asset: asset.data,
    }).success
  )
    return null;
  return {
    schemaVersion: 1,
    sourceRevision: candidate.sourceRevision,
    metaRevision: candidate.metaRevision,
    processingHash: candidate.processingHash,
    inspection: inspection as unknown as MediaInspection,
    asset: asset.data,
  };
}
function presetForBinding(binding: Binding): MediaJobRequest['preset'] {
  return binding.asset.kind === 'video'
    ? 'article-video'
    : binding.asset.presetVersion === 'site-icons-v1'
      ? 'site-icons'
      : 'article-image';
}
function parseReceipt(value: unknown, jobId: string): MediaReceipt {
  if (
    !record(value) ||
    !exact(value, [
      'schemaVersion',
      'jobId',
      'preset',
      'committedAt',
      'result',
      'binding',
    ]) ||
    value.schemaVersion !== 1 ||
    value.jobId !== jobId ||
    !UtcDateTimeSchema.safeParse(value.committedAt).success ||
    !['article-image', 'article-video', 'site-icons'].includes(
      String(value.preset),
    )
  )
    throw new MediaError(
      'MEDIA_JOB_RECEIPT_INVALID',
      '媒體工作完成證據損壞，請保留私有資料。',
      409,
    );
  const result = MediaResultSchema.safeParse(value.result);
  const binding = result.success
    ? parseBinding(value.binding, result.data.sourceId)
    : null;
  if (
    !result.success ||
    binding === null ||
    processingDigest(result.data.asset) !== processingDigest(binding.asset) ||
    value.preset !== presetForBinding(binding)
  )
    throw new MediaError(
      'MEDIA_JOB_RECEIPT_INVALID',
      '媒體工作完成證據不符合處理結果。',
      409,
    );
  return {
    schemaVersion: 1,
    jobId,
    preset: value.preset as MediaJobRequest['preset'],
    committedAt: value.committedAt as string,
    result: result.data,
    binding,
  };
}
function receiptKey(jobId: string) {
  if (!UuidSchema.safeParse(jobId).success)
    throw new MediaError('MEDIA_JOB_ID_INVALID', '媒體工作識別不合法。', 400);
  return `.alfred/media-job-receipts/${jobId}.json`;
}
export class MediaReceipts {
  constructor(readonly root: string) {}
  async read(jobId: string): Promise<MediaReceipt | null> {
    const key = receiptKey(jobId);
    const bytes = await readOptional(
      await safePath(this.root, key),
      128 * 1024,
    );
    if (bytes === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes),
      );
    } catch {
      throw new MediaError(
        'MEDIA_JOB_RECEIPT_INVALID',
        '媒體工作完成證據不是有效JSON。',
        409,
      );
    }
    return parseReceipt(value, jobId);
  }
  async committedResult(
    jobId: string,
    payload: Pick<MediaJobRequest, 'sourceId' | 'preset'>,
  ) {
    const receipt = await this.read(jobId);
    if (receipt === null) return null;
    if (
      receipt.result.sourceId !== payload.sourceId ||
      receipt.preset !== payload.preset
    )
      throw new MediaError(
        'MEDIA_JOB_RECEIPT_MISMATCH',
        '工作識別已對應其他媒體處理輸入。',
        409,
      );
    return { result: receipt.result, committedAt: receipt.committedAt };
  }
  /** Caller holds the repository writer lock; the receipt itself is the commit. */
  async commit(
    jobId: string,
    binding: Binding,
    committedAt: string,
  ): Promise<MediaReceipt> {
    const value = parseReceipt(
      {
        schemaVersion: 1,
        jobId,
        preset: presetForBinding(binding),
        committedAt,
        result: { sourceId: binding.asset.id, asset: binding.asset },
        binding,
      },
      jobId,
    );
    const previous = await this.read(jobId);
    if (previous !== null) {
      if (
        processingDigest(previous.result) !== processingDigest(value.result) ||
        previous.preset !== value.preset
      )
        throw new MediaError(
          'MEDIA_JOB_RECEIPT_MISMATCH',
          '完成工作不可替換為另一個媒體結果。',
          409,
        );
      return previous;
    }
    await safeMkdir(this.root, '.alfred/media-job-receipts');
    await atomicJson(this.root, receiptKey(jobId), value);
    return value;
  }
  async binding(state: SourceState): Promise<Binding | null> {
    let entries;
    try {
      entries = await readdir(
        await safePath(this.root, '.alfred/media-job-receipts'),
        { withFileTypes: true },
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    let latest: MediaReceipt | null = null;
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!UuidSchema.safeParse(id).success) continue;
      const receipt = await this.read(id);
      if (
        receipt === null ||
        receipt.result.sourceId !== state.source.id ||
        receipt.binding.sourceRevision !== state.sourceRevision ||
        receipt.binding.metaRevision !== state.metaRevision
      )
        continue;
      if (
        latest === null ||
        receipt.committedAt > latest.committedAt ||
        (receipt.committedAt === latest.committedAt &&
          receipt.jobId > latest.jobId)
      )
        latest = receipt;
    }
    return latest?.binding ?? null;
  }
}
