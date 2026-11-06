export interface WorkerTarget {
  accountId: string;
  workerName: string;
}
export interface WorkerVersion {
  versionId: string;
  deploymentId: string;
  settingsFingerprint?: string;
  tag?: string | null;
}
export interface WorkerBefore extends WorkerVersion {
  settingsFingerprint: string;
  message: string | null;
}
export interface WorkerStage {
  configRelative: string;
  configDigest: string;
  templateDigest: string;
  workerManifest: ArtifactManifest;
}
export interface WorkerState {
  before: WorkerBefore | null;
  after: WorkerVersion | null;
  stage: WorkerStage | null;
  status:
    | 'prepared'
    | 'deploy-intent'
    | 'uploaded'
    | 'unknown'
    | 'recovery-required'
    | 'restore-intent'
    | 'restored';
  wranglerSucceeded?: boolean;
  restored?: WorkerVersion;
  stageArtifactInvalid?: boolean;
}
export interface WorkerContext {
  root: string;
  deploymentId: string;
  journal: { worker?: WorkerState };
  save(): Promise<void>;
  signal?: AbortSignal;
  manifest?: readonly {
    readonly path: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly target: 'worker' | 'r2';
  }[];
}
export interface WorkerStatus {
  status: WorkerState['status'] | 'conflict';
  conflict?: boolean;
  diagnosticCode?: string;
  remote: WorkerVersion | null;
  canRestoreWorker: boolean;
}
export interface WranglerRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}
export function createWorker(options: {
  config: WorkerTarget;
  token?: string;
  repositoryRoot: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  run?: (options: WranglerRunOptions) => Promise<unknown>;
  retryDelayMs?: number;
}): {
  preflight(context?: WorkerContext): Promise<WorkerBefore | null>;
  stage(context: WorkerContext): Promise<WorkerStage>;
  dryRun(context: WorkerContext): Promise<unknown>;
  deploy(context: WorkerContext): Promise<WorkerVersion>;
  status(context: WorkerContext): Promise<WorkerStatus>;
  preflightRestore(context: WorkerContext): Promise<{
    canRestoreWorker: boolean;
    alreadyRestored: boolean;
    remote?: WorkerVersion;
  }>;
  restore(context: WorkerContext): Promise<{
    restored: boolean;
    reason?: string;
    versionId?: string;
  }>;
};
import type { ArtifactManifest } from '@foliohaven/server';
