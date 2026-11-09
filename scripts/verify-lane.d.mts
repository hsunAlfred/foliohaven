import type { VerificationPlan } from './verification-plan.mjs';
export interface VerificationStep {
  argv: string[];
  framework?: 'vitest' | 'playwright';
  report?: string;
  files?: string[];
  project?: string;
}
export function verificationEnvironment(
  environment?: NodeJS.ProcessEnv,
  lane?: string,
): NodeJS.ProcessEnv;
export function parseLaneArguments(args: string[]): {
  lane: string;
  scope: string;
};
export function laneSteps(
  plan: VerificationPlan,
  lane: string,
  scope: string,
  paths: Record<string, string>,
): VerificationStep[];
export function summarizeFrameworkReport(
  value: unknown,
  step: VerificationStep,
  root: string,
  scope: { browser: string | null; profile: string },
): {
  framework: string;
  path: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};
export function writeVerificationJson(
  path: string,
  value: unknown,
): Promise<void>;
export function runVerificationLane(options: {
  root: string;
  lane: string;
  scope?: string;
  signal?: AbortSignal;
  onProcess?: (child: unknown) => void;
}): Promise<unknown>;
