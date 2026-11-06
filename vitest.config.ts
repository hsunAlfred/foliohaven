import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { ensurePrivateDirectory } from './scripts/private-directory.mjs';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));
ensurePrivateDirectory(repositoryRoot, '.alfred/cache/vitest');

export default defineConfig({
  root: repositoryRoot,
  cacheDir: '.alfred/cache/vitest',
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
