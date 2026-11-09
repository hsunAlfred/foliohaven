import type { VerificationResources } from './verification-plan.mjs';
export function parseVerificationArguments(
  args: string[],
  resources: VerificationResources,
): { profile: string; concurrency: number; concurrencyExplicit: boolean };
export function maintainerRootSteps(root: string): Promise<string[][]>;
export function runBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, signal: AbortSignal) => Promise<R>,
  controller: AbortController,
): Promise<R[]>;
export function runVerification(options: {
  root: string;
  profile?: string;
  concurrency?: number;
  concurrencyExplicit?: boolean;
  controller?: AbortController;
}): Promise<unknown>;
