export interface DomainFile {
  readonly path: string;
  readonly target: 'r2' | 'worker';
  readonly byteSize: number;
  readonly sha256: string;
  readonly mime: string;
}
export interface DomainContext {
  readonly repositoryRoot: string;
  readonly root: string;
  readonly deploymentId: string;
  readonly journal: {
    readonly uploadStatus: string;
    readonly uploadProof?: unknown;
    readonly [field: string]: unknown;
  };
  readonly manifest: readonly DomainFile[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Readonly<Record<string, unknown>>) => void;
}
export interface DomainCheck {
  readonly code: string;
  readonly status: 'passed' | 'failed';
  readonly path?: string;
  readonly message?: string;
  readonly errorCode?: string;
  readonly [field: string]: unknown;
}
export interface DomainReport {
  readonly schemaVersion: 1;
  readonly deploymentId: string;
  readonly domain: string;
  readonly scope: 'automatic';
  readonly status: 'passed' | 'failed' | 'cancelled';
  readonly partial: boolean;
  readonly attemptId?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly platform: string;
  readonly nodeVersion: string;
  readonly checks: readonly DomainCheck[];
  readonly requiresManualVerification: readonly string[];
}
export interface DomainRequestOptions {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly address: string;
  readonly family: number;
  readonly signal: AbortSignal;
}
export interface DomainResponse {
  readonly statusCode: number;
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  readonly body: AsyncIterable<Uint8Array>;
}
export interface DomainVerifierDependencies {
  readonly lookup?: (
    hostname: string,
    options: { readonly all: true; readonly verbatim: true },
  ) => Promise<
    readonly { readonly address: string; readonly family: number }[]
  >;
  readonly request?: (
    url: URL,
    options: DomainRequestOptions,
  ) => Promise<DomainResponse>;
  readonly runBrowsers?: (
    context: DomainContext,
    base: string,
    request: unknown,
    texts: ReadonlyMap<string, string>,
    onCheck?: (check: DomainCheck) => void,
    options?: {
      readonly useNativeVideo: boolean;
      readonly lookup?: DomainVerifierDependencies['lookup'];
    },
  ) => Promise<readonly DomainCheck[]>;
}
export interface DomainVerificationFailure extends Error {
  readonly code: string;
  readonly verificationReport: DomainReport;
}
export function normalizeDomain(value: string): string;
export function isPublicAddress(address: string): boolean;
export function createDomainVerifier(
  dependencies?: DomainVerifierDependencies,
): (context: DomainContext, domain: string) => Promise<DomainReport>;
export function verifyDomain(
  context: DomainContext,
  domain: string,
): Promise<DomainReport>;
