import type {
  BuildJobRequest,
  BuildResult,
  Job,
  JobListQuery,
  JsonValue,
  MediaJobRequest,
  MediaResult,
  SafeError,
  TaxonomyMigrationRequest,
  TaxonomyResult,
} from '@foliohaven/core';
import type { ArtifactStore } from '../build/artifacts/index.js';
import type { FileRepository, OperationReceipt } from '../files/index.js';
import type { OperationReservation } from '../operations/types.js';
import type { OperationStore } from '../operations/store.js';

export interface JobPayloadMap {
  readonly build: BuildJobRequest;
  readonly media: MediaJobRequest;
  readonly taxonomy: TaxonomyMigrationRequest;
}
export interface JobResultMap {
  readonly build: BuildResult;
  readonly media: MediaResult;
  readonly taxonomy: TaxonomyResult;
}
export type JobType = keyof JobPayloadMap;
export interface JobContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
  /** build執行鎖或本job鎖；受控子程序可繼承，避免owner結束後提早釋放。 */
  readonly leaseFd: number;
  progress(value: {
    readonly stage: string;
    readonly completed: number;
    readonly total: number | null;
    readonly snapshotRevision?: string;
  }): Promise<void>;
}
export interface JobHandler<T extends JobType> {
  validateSource(
    payload: JobPayloadMap[T],
    sourceRevision: string | null,
  ): Promise<boolean>;
  run(context: JobContext, payload: JobPayloadMap[T]): Promise<JobResultMap[T]>;
  committedResult?(
    jobId: string,
    payload: JobPayloadMap[T],
  ): Promise<{
    readonly result: JobResultMap[T];
    readonly committedAt: string;
  } | null>;
}
export interface CreateJob<T extends JobType> {
  readonly type: T;
  readonly payload: JobPayloadMap[T];
  readonly sourceRevision: string | null;
  readonly operation?: OperationReservation;
}
export interface JobManagerOptions {
  readonly repositoryRoot: string;
  readonly operations?: OperationStore;
  readonly repository?: FileRepository;
  readonly artifacts?: Pick<ArtifactStore, 'recover' | 'committedProof'>;
  readonly clock?: () => Date;
  readonly pollIntervalMs?: number;
  readonly fault?: (
    phase: 'created' | 'claimed' | 'finished',
    jobId: string,
  ) => void | Promise<void>;
  readonly onError?: (error: SafeError) => void;
}
export interface JobRecord {
  readonly schemaVersion: 1;
  readonly job: Job;
  readonly payload: JsonValue;
  readonly sourceRevision: string | null;
  readonly cancelRequested: boolean;
  readonly operation?: OperationReceipt;
}
export interface JobList {
  readonly items: readonly Job[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
export type JobsQuery = JobListQuery;
