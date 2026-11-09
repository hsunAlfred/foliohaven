export class ReleaseError extends Error {
  readonly code: string;
}
export interface WorkspaceExport {
  destination: string;
  version: string;
  fileCount: number;
}
export function exportVerificationWorkspace(options: {
  sourceRoot: string;
  destination: string;
}): Promise<WorkspaceExport>;
export function exportReleaseWorkspace(options: {
  sourceRoot: string;
  destination: string;
}): Promise<WorkspaceExport>;
export function packageRelease(options: {
  sourceRoot: string;
  destination: string;
}): Promise<unknown>;
