export const PRIVATE_DIRECTORY_NAMES: readonly ['.foliohaven', '.alfred'];
export function privateDirectoryName(
  repositoryRoot: string,
): '.foliohaven' | '.alfred';
export function pinPrivateDirectory(repositoryRoot: string): () => void;
export function privateResource(
  repositoryRoot: string,
  resource?: string,
): string;
export function isBuildSnapshotResource(
  repositoryRoot: string,
  resource: string,
): boolean;
export function compatibleEnvironment(
  name: string,
  environment?: Readonly<Record<string, string | undefined>>,
): string | undefined;
