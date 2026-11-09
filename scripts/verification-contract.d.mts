export const RELEASE_VERIFICATION_LANES: readonly string[];
export const VERIFICATION_ARTIFACT_NAME: string;
export const VERIFICATION_EVIDENCE_FILE: string;
export const MAX_VERIFICATION_ZIP_BYTES: number;
export const MAX_VERIFICATION_JSON_BYTES: number;
export class VerificationContractError extends Error {
  readonly code: string;
}
export interface VerificationDescriptor {
  schemaVersion: 1;
  product: 'foliohaven';
  version: string;
  sourceMode: 'public-export' | 'local';
  sourceFingerprint: string;
  contractDigest: string;
  toolchainDigest: string;
}
export function describeVerificationSource(
  sourceRoot: string,
  options?: { requirePublicExport?: boolean },
): Promise<VerificationDescriptor>;
export function verificationDigest(value: unknown): string;
export function validateVerificationLane<T>(
  value: T,
  descriptor: VerificationDescriptor,
  options?: { lane?: string; scope?: string },
): T;
export function validateVerificationEvidence<T>(
  value: T,
  options: {
    descriptor: VerificationDescriptor;
    repository?: string;
    ref?: string;
    checkoutSha: string;
    runId: number;
    runAttempt: number;
  },
): T;
export function decodeVerificationArchive(input: Uint8Array): unknown;
