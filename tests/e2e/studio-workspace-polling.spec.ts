import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';
import { SiteConfigSchema } from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';

test('編輯取消背景工作區掃描，未保存時仍可手動檢查並正常保存', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let releaseHeld: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let holdNext = true;
  let heldFinished: Promise<void> | undefined;
  const routeWorkspace = async (route: Route) => {
    if (holdNext && route.request().method() === 'GET') {
      holdNext = false;
      // Keep the native background request pending without forwarding it or
      // fabricating a response. Only the editing UI may cancel this request.
      heldFinished = released.then(async () => {
        await route.continue().catch(() => undefined);
      });
      await heldFinished;
    } else await route.continue();
  };
  const isWorkspace = (url: string) =>
    new URL(url).pathname === '/api/v1/workspace';
  try {
    await page.setViewportSize({ width: 1536, height: 1000 });
    await page.clock.install();
    const initialWorkspace = page.waitForResponse(
      (response) => isWorkspace(response.url()) && response.status() === 200,
    );
    await page.goto(`${environment.url}/#/settings`);
    expect((await initialWorkspace).status()).toBe(200);
    const description = page.getByLabel('網站描述', { exact: true });
    await expect(description).toBeEnabled();
    await expect(page.locator('iframe')).toHaveCount(0);

    await page.route('**/api/v1/workspace', routeWorkspace);
    const backgroundRequest = page.waitForRequest((request) =>
      isWorkspace(request.url()),
    );
    await page.clock.runFor(30_000);
    const held = await backgroundRequest;
    const aborted = page.waitForEvent('requestfailed', {
      predicate: (request) => request === held,
    });
    const nextDescription = '工作區背景檢查暫停時，仍能編輯及保存。';
    await description.fill(nextDescription);
    await aborted;
    expect(held.failure()?.errorText).toMatch(/abort|cancel/iu);
    await expect(description).toBeEnabled();
    await expect(description).toHaveValue(nextDescription);
    await expect(page.locator('.workspace-mode')).toHaveText('Studio 模式');
    releaseHeld();
    await heldFinished;

    await page.locator('.workspace-extra > summary').click();
    const manualWorkspace = page.waitForResponse(
      (response) => isWorkspace(response.url()) && response.status() === 200,
    );
    await page
      .getByRole('button', { name: '重新檢查工作區', exact: true })
      .click();
    expect((await manualWorkspace).status()).toBe(200);
    await expect(description).toHaveValue(nextDescription);
    let passiveRequests = 0;
    const observePaused = (request: { url(): string }) => {
      if (isWorkspace(request.url())) passiveRequests++;
    };
    page.on('request', observePaused);
    await page.clock.runFor(30_000);
    expect(passiveRequests).toBe(0);
    page.off('request', observePaused);

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/v1/site-settings',
    );
    const refreshedWorkspace = page.waitForResponse(
      (response) => isWorkspace(response.url()) && response.status() === 200,
    );
    await page
      .getByRole('button', { name: '保存全站設定', exact: true })
      .click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(SiteConfigSchema.parse(await response.json()).siteDescription).toBe(
      nextDescription,
    );
    expect((await refreshedWorkspace).status()).toBe(200);
    await expect(description).toBeEnabled();
    await expect(description).toHaveValue(nextDescription);
    await expect(
      page.getByText('設定與已保存版本一致', { exact: true }),
    ).toBeVisible();
  } finally {
    releaseHeld();
    await heldFinished;
    await page.unroute('**/api/v1/workspace', routeWorkspace);
    await environment.close();
  }
});
