import { privateResource } from './scripts/workspace-paths.mjs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { ensurePrivateDirectory } from './scripts/private-directory.mjs';
import {
  verificationResources,
  verificationConfiguredUnitWorkers,
} from './scripts/verification-plan.mjs';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));
const cacheDir = privateResource(repositoryRoot, 'cache/vitest');
ensurePrivateDirectory(repositoryRoot, cacheDir);
const unitWorkers = verificationConfiguredUnitWorkers(
  process.env.FOLIOHAVEN_UNIT_WORKERS,
  await verificationResources(),
  process.argv,
);

export default defineConfig({
  root: repositoryRoot,
  cacheDir,
  test: {
    environment: 'node',
    globals: false,
    allowOnly: false,
    passWithNoTests: false,
    maxWorkers: 1,
    fileParallelism: false,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 10_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.{ts,tsx,mts}'],
          pool: 'forks',
          isolate: true,
          maxWorkers: unitWorkers,
          fileParallelism: true,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.{ts,tsx,mts}'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
