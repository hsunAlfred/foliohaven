import type {
  JsonValue,
  RecoveryDetail,
  RecoveryResolution,
  Workspace,
  TaxonomyResult,
} from '@foliohaven/core';
import type { ContentSources, LoadContentOptions } from '@foliohaven/core/node';

export interface RawResource {
  readonly bytes: Buffer;
  readonly revision: string;
}
export interface ReadSession {
  readonly generation: number;
  read(resourceKey: string): Promise<RawResource | null>;
  etag(resourceKeys: readonly string[]): Promise<string>;
  listArticleIds(): Promise<readonly string[]>;
  loadContent(options?: LoadContentOptions): Promise<ContentSources>;
}
export interface OperationReceipt {
  readonly id: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly httpStatus: number;
  readonly resourceUrl?: string;
  readonly jobUrl?: string;
  readonly response?: JsonValue;
  readonly headers?: { readonly ETag?: string; readonly Location?: string };
}
/** 私有暫存來源由 repository 建立；不接受任意來源路徑。 */
export interface PreparedBinary {
  readonly preparedBinaryId: string;
  readonly byteSize: number;
  readonly revision: string;
}
export interface FileChange {
  readonly resourceKey: string;
  readonly expectedRevision: string | null;
  readonly content: Uint8Array | PreparedBinary | null;
}
export type ScanInputs = () => Promise<string>;
export interface CommitRequest {
  readonly kind: 'save' | 'create' | 'delete' | 'taxonomy' | 'restore';
  readonly changes: readonly FileChange[];
  readonly precondition?: {
    readonly ifMatch: string | undefined;
    readonly resourceKeys: readonly string[];
    /** Domain在同writer以實際來源重建HTTP表示；raw版本始終由repository計算。 */
    readonly representationEtag?: (
      session: ReadSession,
      actualRawEtag: string,
    ) => Promise<string>;
  };
  readonly workspacePrecondition?: {
    readonly revision: string;
    readonly scanInputs: ScanInputs;
  };
  readonly operation?: OperationReceipt;
  readonly jobCompletion?: {
    readonly id: string;
    readonly type: 'taxonomy';
    readonly result: TaxonomyResult;
  };
  readonly validate?: (session: ReadSession) => Promise<void>;
  /** 刪除整個受控來源時，提供對應ID，避免還原時合併同名新目錄。 */
  readonly trash?: { readonly kind: 'article' | 'media'; readonly id: string };
}
export interface CommittedJobResult {
  readonly id: string;
  readonly type: 'taxonomy';
  readonly result: TaxonomyResult;
  readonly transactionId: string;
  readonly committedAt: string;
}
export interface CommitResult {
  readonly transactionId: string;
  readonly generation: number;
  readonly revisions: readonly {
    readonly resourceKey: string;
    readonly revision: string | null;
  }[];
  readonly etag: string;
}
export type FaultPhase =
  | 'prepared-file'
  | 'backup-file'
  | 'prepared-journal'
  | 'verified-before-commit'
  | 'install-intent'
  | 'generation'
  | 'before-displace'
  | 'directory-created'
  | 'directory-reserved'
  | 'after-displace'
  | 'before-install-link'
  | 'after-install'
  | 'per-file-journal'
  | 'committed-journal'
  | 'resolution-intent'
  | 'resolution-committed'
  | 'purge-files';
export interface FaultEvent {
  readonly phase: FaultPhase;
  readonly transactionId: string;
  readonly resourceKey?: string;
}
export interface RepositoryOptions {
  readonly repositoryRoot: string;
  readonly pageSchemas?: NonNullable<LoadContentOptions['pageSchemas']>;
  readonly registeredPageIds?: readonly string[];
  readonly clock?: () => Date;
  readonly fault?: (event: FaultEvent) => void | Promise<void>;
  readonly lockTimeoutMs?: number;
  /** Studio-only observation optimization; strict Build readers omit this. */
  readonly reuseFileDigests?: boolean;
}
export interface WorkspaceResult {
  readonly value: Workspace;
  readonly etag: string;
  readonly generation: number;
}
export interface RecoveryResult {
  readonly value: RecoveryDetail;
  readonly etag: string;
}
export interface RecoveryResolutionResult {
  readonly id: string;
  readonly status: 'resolved';
  readonly choice: RecoveryResolution['choice'];
  readonly generation: number;
}
