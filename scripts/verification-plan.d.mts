export interface LaneCoverage {
  unitFiles: string[];
  integrationFiles: string[];
  e2eFiles: string[];
  browser: null | 'chromium' | 'firefox' | 'webkit';
}
export interface VerificationPlan {
  schemaVersion: 1;
  planDigest: string;
  unitFiles: string[];
  integrationFiles: string[];
  e2eFiles: string[];
  lanes: Record<string, LaneCoverage>;
  quick: { integrationFiles: string[]; e2eFiles: string[]; e2eGrep: string };
}
export interface NominalVerificationResources {
  cpus: number;
  memoryBytes: number;
}
export interface VerificationResources extends NominalVerificationResources {
  hostAvailableBytes: number | null;
  cgroupMemoryStatus: string;
  cgroupHeadroomBytes: number | null;
  memoryHeadroomBytes: number | null;
  memoryReserveBytes: number;
  usableMemoryBytes: number;
  memoryCapacityStatus: string;
}
export const CORE_VERIFICATION_LANES: readonly string[];
export const SERIAL_INTEGRATION_FILE: string;
export const QUICK_INTEGRATION_FILES: readonly string[];
export const QUICK_E2E_FILES: readonly string[];
export const QUICK_E2E_GREP: string;
export function verificationError(
  code: string,
  message: string,
): Error & { code: string };
export function createVerificationPlan(
  sourceRoot: string,
): Promise<VerificationPlan>;
export function expectedLaneCoverage(
  plan: VerificationPlan,
  lane: string,
  scope?: string,
): LaneCoverage;
export function validateLaneCoverage<T>(plan: VerificationPlan, receipt: T): T;
export function validateVerificationCoverage(
  plan: VerificationPlan,
  receipts: unknown[],
): boolean;
export function verificationConcurrency(
  requested: unknown,
  resources: VerificationResources,
): number;
export function effectiveVerificationResources(input: {
  availableCpus: number;
  hostMemoryBytes: number;
  constrainedMemoryBytes?: number;
  cpuMax?: string;
  cpuQuota?: string;
  cpuPeriod?: string;
}): NominalVerificationResources;
export function verificationResources(): Promise<VerificationResources>;
export function verificationUnitWorkers(
  requested: unknown,
  resources: VerificationResources,
): number;
export function effectiveMemoryHeadroom(
  nominal: NominalVerificationResources,
  input?: {
    hostAvailableBytes?: number | null;
    cgroup?: { status: string; headroomBytes: number | null };
  },
): VerificationResources;
export function parseMemAvailable(value: unknown): number | null;
export function cgroupMemoryDirectories(
  membership: string | undefined,
  mountinfo: string | undefined,
): { version: number; directories: string[] } | null;
export function cgroupMemoryHeadroom(
  entries: { limit?: string | undefined; current?: string | undefined }[],
  version?: number,
): { status: string; headroomBytes: number | null };
export function verificationLaneResources(
  lane: string,
  scope: string,
  resources: VerificationResources,
): VerificationResources;
export function verificationResourceMessage(
  resources: VerificationResources,
  cap: number,
): string;

export function verificationConfiguredUnitWorkers(
  requested: unknown,
  resources: VerificationResources,
  args: string[],
): number;
