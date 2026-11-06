import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { FileRepository } from '../files/repository.js';
import type {
  OperationReceipt,
  PreparedBinary,
  ReadSession,
} from '../files/types.js';
import type {
  MediaAsset,
  MediaOutput,
  MediaSource,
  MediaSourceResource,
  MediaListQuery,
  FixedPage,
} from '@foliohaven/core';

export interface MediaProgress {
  readonly stage: string;
  readonly completed: number;
  readonly total: number | null;
}
export interface MediaTaskOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MediaProgress) => void | Promise<void>;
  /** Internal job owner descriptor; never accepted from HTTP fields. */
  readonly jobLeaseFd?: number;
}
export interface MediaInspection {
  readonly aspectRatio: number;
  readonly kind: 'image' | 'video';
  readonly mimeType: MediaSourceResource['mimeType'];
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number | null;
  readonly fps: number | null;
  readonly audio: boolean;
  readonly streamIndex: number | null;
}
export interface StagedMedia {
  readonly binary: PreparedBinary;
  readonly source: MediaSource;
  readonly inspection: MediaInspection;
  readonly payloadHash: string;
}
export interface MediaSourceResult {
  readonly value: MediaSourceResource;
  readonly etag: string;
  /** Node-only來源/metadata raw組合版本；不因衍生asset投影改變。 */
  readonly inputRevision: string;
  readonly transactionId?: string;
  readonly location?: string;
}
export interface MediaServiceOptions {
  readonly repositoryRoot: string;
  readonly repository: FileRepository;
  readonly coordinationRoot?: string;
  readonly fixedPages?: readonly FixedPage[];
  readonly clock?: () => Date;
  readonly lockTimeoutMs?: number;
  /** Only Studio runtime opts in; Build and standalone media checks stay strict. */
  readonly reuseFileDigests?: boolean;
  /** 只供隔離故障測試的內部階段觀察；不接受 HTTP 傳入。 */
  readonly onPhase?: (phase: string, sourceId: string) => void | Promise<void>;
  readonly deadlines?: {
    readonly imageMs?: number;
    readonly videoMs?: number;
    readonly uploadMs?: number;
    readonly idleMs?: number;
  };
}
export interface MediaFile {
  readonly stream: Readable;
  readonly output: MediaOutput;
  readonly status: 200 | 206;
  readonly headers: Readonly<Record<string, string>>;
}
export interface MediaSourceList {
  readonly items: readonly MediaSourceResource[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
export type MediaQuery = MediaListQuery;
export type MediaOperation = OperationReceipt;
export type UploadRequest = IncomingMessage;
export interface SourceState {
  readonly source: MediaSource;
  readonly metaRevision: string;
  readonly sourceRevision: string;
  readonly byteSize: number;
  readonly etag: string;
}
export interface Binding {
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly metaRevision: string;
  readonly processingHash: string;
  readonly inspection: MediaInspection;
  readonly asset: MediaAsset;
}
export type SourceReader = (session: ReadSession) => Promise<SourceState>;
