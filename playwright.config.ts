import { privateResource } from './scripts/workspace-paths.mjs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { ensurePrivateDirectory } from './scripts/private-directory.mjs';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));
const lane = process.env.FOLIOHAVEN_VERIFICATION_LANE;
if (
  lane !== undefined &&
  !['quality', 'e2e-chromium', 'e2e-firefox', 'e2e-webkit'].includes(lane)
)
  throw new Error('驗證 lane 不合法。');
const reports = ensurePrivateDirectory(
  repositoryRoot,
  privateResource(
    repositoryRoot,
    lane
      ? `reports/verification/framework/${lane}/playwright`
      : 'reports/playwright',
  ),
);

export default defineConfig({
  testDir: `${repositoryRoot}tests/e2e`,
  testMatch: '**/*.spec.ts',
  outputDir: `${reports}/results`,
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
        outputFolder: `${reports}/html`,
        open: 'never',
      },
    ],
    ['junit', { outputFile: `${reports}/results.xml` }],
    ...(lane
      ? [['json', { outputFile: `${reports}/../playwright.json` }] as const]
      : []),
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
