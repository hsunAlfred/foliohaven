import type {
  BuildResult,
  Diagnostic,
  MediaManifest,
  SiteModel,
  SeoViewModel,
} from '@foliohaven/core';
import type { MediaService } from '../../media/service.js';
export interface RenderContextOptions {
  readonly repositoryRoot: string;
  readonly contextDirectory: string;
  readonly coordinationRoot?: string;
  readonly signal?: AbortSignal;
}
export interface PreparedRenderContext {
  readonly model: SiteModel;
  readonly manifest: MediaManifest;
  readonly contextDirectory: string;
  readonly mediaService: MediaService;
  readonly fixedPageSeos: Readonly<Record<string, SeoViewModel>>;
}
export interface BuildWorkerReport {
  readonly schemaVersion: 1;
  readonly result: BuildResult;
  readonly mediaPending: false;
  readonly pendingLinkChecks: 0;
}
export interface RenderSnapshotOptions {
  readonly repositoryRoot: string;
  readonly jobId: string;
  readonly snapshotRevision: string;
  readonly signal?: AbortSignal;
}
export interface ValidateSiteOutputOptions {
  readonly outputDirectory: string;
  readonly model: SiteModel;
  readonly manifest: MediaManifest;
  readonly draftSentinels?: readonly string[];
  readonly fixedPageSeos?: Readonly<Record<string, SeoViewModel>>;
}
export interface SiteOutputValidation {
  readonly fileCount: number;
  readonly routeCount: number;
  readonly warnings: readonly Diagnostic[];
  readonly mediaPending: false;
  readonly pendingLinkChecks: 0;
}
