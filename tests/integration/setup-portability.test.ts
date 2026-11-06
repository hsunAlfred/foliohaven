import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function browserCache(target: string) {
  let browser = dirname(chromium.executablePath());
  while (!/^chromium-\d+$/u.test(basename(browser))) {
    const parent = dirname(browser);
    if (parent === browser) throw new Error('Installed Chromium cache missing');
    browser = parent;
  }
  const installed = dirname(browser);
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(installed))
    await symlink(join(installed, entry), join(target, entry));
}

async function runSetup(environment: NodeJS.ProcessEnv) {
  return execute(process.execPath, ['scripts/setup.mjs'], {
    cwd: repository,
    env: environment,
    timeout: 90_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
}

function expectRealBrowsers(stdout: string) {
  for (const browser of ['chromium', 'firefox', 'webkit'])
    expect(stdout).toContain(`瀏覽器實際啟動通過：${browser} `);
  expect(stdout).toContain('setup 資源核對完成');
}

describe('portable setup browser resources', () => {
  it('launches all three browsers from the native cache without a container-specific variable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'alfred-native-cache-'));
    directories.push(directory);
    await browserCache(join(directory, 'ms-playwright'));
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CACHE_HOME: directory,
    };
    delete environment.PLAYWRIGHT_BROWSERS_PATH;
    const result = await runSetup(environment);
    expectRealBrowsers(result.stdout);
  });

  it('respects an explicit browser cache and launches actual browser executables', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'alfred-browser-cache-'));
    directories.push(directory);
    const cache = join(directory, 'browsers');
    await browserCache(cache);
    const result = await runSetup({
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: cache,
    });
    expectRealBrowsers(result.stdout);
  });

  it('fails clearly when the selected cache has no executable browsers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'alfred-empty-cache-'));
    directories.push(directory);
    await expect(
      runSetup({
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: resolve(directory, 'missing'),
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('環境初始化檢查失敗：chromium。'),
    });
  });
});
