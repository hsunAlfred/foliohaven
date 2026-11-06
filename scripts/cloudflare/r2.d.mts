export interface R2File {
  path: string;
  byteSize: number;
  sha256: string;
  mime: string;
  target: 'r2' | 'worker';
}
export interface R2Remote {
  etag: string;
  byteSize: number;
  sha256: string | null;
  metadata: Record<string, string>;
  headers: Record<string, string>;
  fingerprint: string;
}
export interface R2Record extends Omit<R2File, 'target'> {
  action: 'create' | 'skip' | 'overwrite';
  status: string;
  before: R2Remote | null;
  after: R2Remote | null;
  backup: { path: string; byteSize: number; sha256: string } | null;
  upload: {
    phase: string;
    uploadId: string | null;
    parts: { PartNumber: number; ETag: string; byteSize: number }[];
    partSize: number;
    queueSize: number;
    memoryBudget: number;
  } | null;
  restore: {
    status: string;
    after?: R2Remote | null;
    upload?: R2Record['upload'];
  } | null;
}
export interface R2State {
  schemaVersion: 1;
  bucketName: string;
  prepared: boolean;
  records: R2Record[];
  restoreComplete?: boolean;
}
export interface R2Context {
  root: string;
  manifest: R2File[];
  deploymentId: string;
  journal: { r2?: R2State };
  save(): Promise<void>;
  signal?: AbortSignal;
  onProgress?: (event: Record<string, unknown>) => void;
}
export function multipartSizing(
  byteSize: number,
  memoryBytes?: number,
): {
  multipart: boolean;
  partSize: number;
  queueSize: number;
  memoryBudget: number;
};
export function createR2(options: {
  config: { accountId: string; bucketName: string };
  credentials: { R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string };
  signal?: AbortSignal;
  onProgress?: (event: Record<string, unknown>) => void;
  client?: {
    send(
      command: object,
      options?: { abortSignal?: AbortSignal },
    ): Promise<object>;
  };
  retryDelayMs?: number;
  timeout?: { read?: number; request?: number; idle?: number; file?: number };
}): {
  checkBucket(): Promise<void>;
  prepare(context: R2Context): Promise<R2Record[]>;
  upload(context: R2Context): Promise<R2Record[]>;
  status(
    context: R2Context,
    options?: { verifyContent?: boolean },
  ): Promise<{
    complete: boolean;
    unknown: boolean;
    conflicts: string[];
    records: R2Record[];
  }>;
  preflightRestore(
    context: R2Context,
  ): Promise<{ ready: true; records: R2Record[] }>;
  restore(context: R2Context): Promise<{ complete: true; records: R2Record[] }>;
  destroy(): void;
};
