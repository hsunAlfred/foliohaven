import type {
  ArticleResource,
  HtmlProcessingCache,
  Diagnostic,
  FixedPage,
  MediaManifest,
  TaxonomyMigrationRequest,
  TaxonomyMigrationPlan,
  TaxonomyResult,
} from '@foliohaven/core';
import type { FileRepository } from '../files/index.js';
import type {
  OperationReceipt,
  ReadSession,
  ScanInputs,
} from '../files/types.js';

export interface ContentServiceOptions {
  readonly repository: FileRepository;
  readonly fixedPages: readonly FixedPage[];
  /** 必須涵蓋完整建置輸入，由正式來源掃描器提供，不是 content-only revision。 */
  readonly scanInputs: ScanInputs;
  readonly getMediaManifest?: (session: ReadSession) => Promise<MediaManifest>;
  readonly clock?: () => Date;
  readonly htmlCache?: HtmlProcessingCache;
}
export interface Versioned<T> {
  readonly value: T;
  readonly etag: string;
  readonly transactionId?: string;
}
export interface MutationOptions {
  readonly operation?: OperationReceipt;
  /** taxonomy job結果與來源交易持久關聯，不取代原始202 operation回應。 */
  readonly jobId?: string;
}
export interface ArticleList {
  readonly items: readonly ArticleResource[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
export type MigrationDescriptor = Pick<
  TaxonomyMigrationRequest,
  'kind' | 'from' | 'to' | 'workspaceRevision'
>;
export interface MigrationExecution extends MigrationDescriptor {
  readonly planId: string;
}
export interface MigrationExecutionResult {
  readonly value: TaxonomyResult;
  readonly transactionId: string;
  /** 舊正文連結不自動重寫；此診斷必須修正後才能成功 Build。 */
  readonly diagnostics: readonly Diagnostic[];
}
export interface StoredMigrationPlan {
  readonly value: TaxonomyMigrationPlan;
  readonly generation: number;
}
