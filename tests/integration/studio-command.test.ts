import { expect, it } from 'vitest';
import { chromium, expect as browserExpect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { JobSchema } from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';

it('STUDIO-COMMAND-01: same-tick calls and clears cannot bypass an in-flight or uncertain real request', async () => {
  const environment = await studioEnvironment({ commandHarness: true });
  let browser: Browser | undefined;
  let releaseFirst: (() => void) | undefined;
  let releaseRetry: (() => void) | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const keys: string[] = [];
    const bodies: string[] = [];
    const ids: string[] = [];
    await page.route('**/api/v1/build-jobs', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      bodies.push(route.request().postData() ?? '');
      const response = await route.fetch();
      ids.push(JobSchema.parse(await response.json()).id);
      if (keys.length === 1) {
        await firstGate;
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: '{"truncated":',
        });
      } else {
        await retryGate;
        await route.fulfill({ response });
      }
    });
    await page.goto(`${environment.url}/__command-harness`);
    await browserExpect(page.getByRole('status')).toHaveText('就緒');
    const initial = await page.evaluate(() => {
      const command = window.commandHarness;
      const body = {};
      void command
        .run(
          {
            label: '真實Build',
            path: '/api/v1/build-jobs',
            method: 'POST',
            body,
            idempotencyKey: crypto.randomUUID(),
          },
          () => undefined,
        )
        .catch(() => undefined);
      const clearWhileRunning = command.clear({ discardPending: true });
      const duplicate = command
        .run(
          {
            label: '重複Build',
            path: '/api/v1/build-jobs',
            method: 'POST',
            body,
            idempotencyKey: crypto.randomUUID(),
          },
          () => undefined,
        )
        .then(
          () => 'unexpected',
          (error: unknown) => (error as { code: string }).code,
        );
      return duplicate.then((code) => ({ clearWhileRunning, code }));
    });
    expect(initial).toEqual({
      clearWhileRunning: false,
      code: 'COMMAND_IN_PROGRESS',
    });
    await browserExpect.poll(() => ids.length).toBe(1);
    releaseFirst?.();
    await browserExpect(page.getByRole('status')).toHaveText('結果未確認');
    const pending = await page.evaluate(async () => {
      const command = window.commandHarness;
      const original = command.pending;
      const clearUnknown = command.clear();
      const code = await command
        .run(
          {
            label: '新Build',
            path: '/api/v1/build-jobs',
            method: 'POST',
            body: {},
            idempotencyKey: crypto.randomUUID(),
          },
          () => undefined,
        )
        .then(
          () => 'unexpected',
          (error: unknown) => (error as { code: string }).code,
        );
      return { clearUnknown, code, key: original?.command.idempotencyKey };
    });
    expect(pending).toMatchObject({
      clearUnknown: false,
      code: 'COMMAND_RESULT_UNCONFIRMED',
      key: keys[0],
    });
    expect(keys).toHaveLength(1);
    const retry = await page.evaluate(async () => {
      const command = window.commandHarness;
      void command.retry().catch(() => undefined);
      const clearWhileRetrying = command.clear({ discardPending: true });
      const code = await command.retry().then(
        () => 'unexpected',
        (error: unknown) => (error as { code: string }).code,
      );
      return { clearWhileRetrying, code };
    });
    expect(retry).toEqual({
      clearWhileRetrying: false,
      code: 'COMMAND_IN_PROGRESS',
    });
    await browserExpect.poll(() => ids.length).toBe(2);
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(ids[1]).toBe(ids[0]);
    releaseRetry?.();
    await browserExpect(page.getByRole('status')).toHaveText('就緒');
    const collection = await page.request.get(
      `${environment.url}/api/v1/jobs?type=build&pageSize=100`,
    );
    expect(((await collection.json()) as { total: number }).total).toBe(1);
  } finally {
    releaseFirst?.();
    releaseRetry?.();
    await browser?.close();
    await environment.close();
  }
});
