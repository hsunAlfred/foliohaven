import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { ensurePrivateDirectory } from './scripts/private-directory.mjs';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));
ensurePrivateDirectory(repositoryRoot, '.alfred/reports/playwright');

export default defineConfig({
  testDir: `${repositoryRoot}tests/e2e`,
  testMatch: '**/*.spec.ts',
  outputDir: `${repositoryRoot}.alfred/reports/playwright/results`,
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  globalTimeout: 120 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: `${repositoryRoot}.alfred/reports/playwright/html`,
        open: 'never',
      },
    ],
    [
      'junit',
      { outputFile: `${repositoryRoot}.alfred/reports/playwright/results.xml` },
    ],
  ],
  use: {
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
