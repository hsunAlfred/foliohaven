import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkDependencies } from './check-dependencies.mjs';

const rootRequire = createRequire(new URL('../package.json', import.meta.url));

async function checkBrowser(browserType) {
  const name = browserType.name();
  let browser;
  try {
    const executable = await realpath(browserType.executablePath());
    await access(executable, constants.X_OK);
    browser = await browserType.launch({ headless: true, timeout: 30_000 });
    const context = await browser.newContext();
    // 不連線網站或既有內容，阻擋所有網路請求，僅核對合成的記憶體頁面。
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><html lang="zh-Hant"><body><h1>瀏覽器資源檢查</h1></body></html>',
      {
        waitUntil: 'domcontentloaded',
        timeout: 10_000,
      },
    );
    assert.equal(await page.locator('h1').textContent(), '瀏覽器資源檢查');
    await context.close();
    console.log(`瀏覽器實際啟動通過：${name} ${browser.version()}`);
  } catch {
    throw new Error(
      `環境初始化檢查失敗：${name}。請依 README 安裝固定版本瀏覽器與系統依賴，並確認目前帳號可執行。`,
    );
  } finally {
    if (browser) await browser.close();
  }
}

export async function setup() {
  await checkDependencies();
  // 使用 locked Playwright 自行解析的預設 cache 或明確指定的瀏覽器路徑。
  const playwrightModule = await import(
    pathToFileURL(rootRequire.resolve('@playwright/test')).href
  );
  const playwright = playwrightModule.default ?? playwrightModule;
  for (const browserType of [
    playwright.chromium,
    playwright.firefox,
    playwright.webkit,
  ]) {
    await checkBrowser(browserType);
  }
  console.log('setup 資源核對完成：未安裝、未建置、未修改來源或版本。');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  setup().catch((error) => {
    // 第三方錯誤不包含在安全摘要中，避免輸出主機路徑或環境資料。
    console.error(
      error.message.startsWith('相容檢查失敗：') ||
        error.message.startsWith('環境初始化檢查失敗：')
        ? error.message
        : '環境初始化檢查失敗：無法載入本機 Playwright 或檢查瀏覽器資源。',
    );
    process.exitCode = 1;
  });
}
