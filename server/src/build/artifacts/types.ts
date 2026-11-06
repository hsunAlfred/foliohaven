import type {
  BuildResult,
  Diagnostic,
  RecoveryResolution,
} from '@foliohaven/core';

export type ArtifactEntry =
  | { readonly path: string; readonly kind: 'directory' }
  | {
      readonly path: string;
      readonly kind: 'file';
      readonly byteSize: number;
      readonly sha256: string;
    };
export interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly entries: readonly ArtifactEntry[];
  readonly fileCount: number;
  readonly totalBytes: number;
}
export interface ArtifactProof {
  readonly jobId: string;
  readonly digest: string;
  readonly manifest: ArtifactManifest;
  readonly result: BuildResult;
  readonly artifactCommitted: true;
  readonly committedAt: string;
}
/** 固定正式部署來源；目的地只由 deploymentId 推導，不接受任意路徑。 */
export interface CaptureCurrentOptions {
  readonly deploymentId: string;
  readonly expectedJobId: string;
  readonly expectedSnapshotRevision: string;
  readonly signal?: AbortSignal;
}
export interface CapturedArtifact {
  readonly resource: string;
  readonly manifest: ArtifactManifest;
  readonly proof: ArtifactProof;
}
export interface PromoteOptions {
  readonly snapshotRevision: string;
  readonly routeCount: number;
  readonly warnings?: readonly Diagnostic[];
  readonly signal?: AbortSignal;
}
/** 只由 preparePromotion 建立；方法封閉持久交易，沒有可回寫的路徑或設定。 */
export interface PreparedPromotion {
  readonly jobId: string;
  readonly digest: string;
  promote(): Promise<ArtifactProof>;
  release(): Promise<void>;
}
export type ArtifactFaultPhase =
  | 'prepared-copies'
  | 'prepared-journal'
  | 'promotion-intent'
  | 'old-moved'
  | 'before-new-rename'
  | 'new-moved'
  | 'artifact-committed'
  | 'state-committed'
  | 'before-rollback-rename'
  | 'rollback-restored'
  | 'resolution-intent'
  | 'resolution-committed';
export interface ArtifactStoreOptions {
  readonly repositoryRoot: string;
  readonly clock?: () => Date;
  readonly lockTimeoutMs?: number;
  readonly fault?: (event: {
    readonly phase: ArtifactFaultPhase;
    readonly jobId: string;
  }) => void | Promise<void>;
}
export interface ArtifactRecoverySummary {
  readonly id: string;
  readonly kind: 'build';
  readonly status: 'pending' | 'available' | 'resolved';
  readonly createdAt: string;
}
export interface ArtifactRecoveryResult {
  readonly id: string;
  readonly status: 'resolved';
  readonly choice: RecoveryResolution['choice'];
}
export interface ArtifactRecoveryState {
  readonly recoveryState: 'ready' | 'recovery-required';
  readonly currentDigest: string | null;
}
