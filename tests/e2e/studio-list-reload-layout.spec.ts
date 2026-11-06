import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ArticleMetaSchema,
  ArticleResourceSchema,
  JobSchema,
  RecoveryDetailSchema,
} from '@foliohaven/core';
import { studioEnvironment } from '../fixtures/studio/environment.js';

const collection = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  });
const Articles = collection(ArticleResourceSchema);
const Jobs = collection(JobSchema);
const Recoveries = collection(
  z.object({
    id: z.uuid(),
    kind: z.enum(['transaction', 'trash', 'build']),
    status: z.enum(['pending', 'available', 'resolved']),
    createdAt: z.iso.datetime(),
  }),
);
type Environment = Awaited<ReturnType<typeof studioEnvironment>>;
type PointerEventProof = {
  type: string;
  time: number;
  trusted: boolean;
  target: string;
  button: string | null;
  buttonNode: number | null;
  row: string | null;
};
declare global {
  interface Window {
    __listReloadPointerEvents?: PointerEventProof[];
    __listReloadCapture?: boolean;
  }
}

test.use({ viewport: { width: 1536, height: 1000 } });

async function installPointerProof(page: Page) {
  await page.addInitScript(() => {
    const identities = new WeakMap<Element, number>();
    let nextIdentity = 0;
    window.__listReloadPointerEvents = [];
    window.__listReloadCapture = false;
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      document.addEventListener(
        type,
        (event) => {
          if (!window.__listReloadCapture) return;
          const target = event.target;
          if (!(target instanceof Element)) return;
          const row = target.closest('tbody tr');
          const button = target.closest('button');
          if (button && !identities.has(button))
            identities.set(button, ++nextIdentity);
          window.__listReloadPointerEvents?.push({
            type,
            time: performance.now(),
            trusted: event.isTrusted,
            target: target.tagName,
            button: button?.textContent?.trim() ?? null,
            buttonNode: button ? (identities.get(button) ?? null) : null,
            row:
              row?.getAttribute('data-article-id') ??
              row?.getAttribute('data-recovery-id') ??
              row?.textContent?.trim() ??
              null,
          });
        },
        true,
      );
    }
  });
}

async function holdReload(
  page: Page,
  path: string,
  parse: (input: unknown) => unknown,
) {
  let release: () => void = () => {};
  let ready: () => void = () => {};
  let delivered: () => void = () => {};
  let fail: (error: unknown) => void = () => {};
  let failDelivery: (error: unknown) => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responseReady = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const responseDelivered = new Promise<void>((resolve, reject) => {
    delivered = resolve;
    failDelivery = reject;
  });
  const matcher = (url: URL) => url.href === path;
  await page.route(matcher, async (route) => {
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      parse(await response.json());
      ready();
      await gate;
      await route.fulfill({ response });
      delivered();
    } catch (error) {
      fail(error);
      failDelivery(error);
      await route.abort().catch(() => undefined);
    }
  });
  return {
    responseReady,
    responseDelivered,
    release,
    close: async () => {
      release();
      await page.unroute(matcher);
    },
  };
}

async function box(locator: Locator) {
  return locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.x,
      y: bounds.y,
      documentY: bounds.y + window.scrollY,
      width: bounds.width,
      height: bounds.height,
    };
  });
}
function sameBox(
  before: Awaited<ReturnType<typeof box>>,
  after: Awaited<ReturnType<typeof box>>,
  context: string,
) {
  for (const key of ['x', 'y', 'documentY', 'width', 'height'] as const)
    expect(after[key], `${context}: ${key}`).toBeCloseTo(before[key], 1);
}

async function nativeAcrossReload(
  page: Page,
  input: {
    name: string;
    title: string;
    loadingLabel: string;
    trigger: Locator;
    reload: Awaited<ReturnType<typeof holdReload>>;
    begin: () => Promise<void>;
  },
) {
  const heading = page.getByRole('heading', {
    name: input.title,
    level: 2,
    exact: true,
  });
  await input.trigger.scrollIntoViewIfNeeded();
  const idle = {
    heading: await box(heading),
    trigger: await box(input.trigger),
  };
  let pressed = false;
  try {
    await input.begin();
    await input.reload.responseReady;
    const loadingStatus = page
      .getByRole('status')
      .filter({ hasText: input.loadingLabel });
    await expect(loadingStatus).toHaveText(input.loadingLabel);
    await expect(input.trigger).toBeEnabled();
    const live = await loadingStatus.elementHandle();
    if (!live) throw new Error('Loading status must be accessible');
    const loading = {
      heading: await box(heading),
      trigger: await box(input.trigger),
    };
    const bounds = await input.trigger.boundingBox();
    if (!bounds) throw new Error('The existing row must remain clickable');
    const point = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    await page.evaluate(() => {
      window.__listReloadPointerEvents = [];
      window.__listReloadCapture = true;
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    pressed = true;
    input.reload.release();
    await input.reload.responseDelivered;
    await expect(loadingStatus).toHaveCount(0);
    const ready = {
      heading: await box(heading),
      trigger: await box(input.trigger),
    };
    const status = await live.evaluate((element) => ({
      connected: element.isConnected,
      live: element.getAttribute('aria-live'),
      atomic: element.getAttribute('aria-atomic'),
      text: element.textContent,
    }));
    await page.mouse.up();
    pressed = false;
    const events = await page.evaluate(() => {
      window.__listReloadCapture = false;
      return window.__listReloadPointerEvents ?? [];
    });
    const proofPath = test
      .info()
      .outputPath(`${input.name}-native-reload.json`);
    await writeFile(
      proofPath,
      JSON.stringify({ idle, loading, ready, point, status, events }, null, 2),
    );
    await test.info().attach(`${input.name}-native-reload.json`, {
      path: proofPath,
      contentType: 'application/json',
    });
    sameBox(idle.heading, loading.heading, 'heading while loading');
    sameBox(idle.heading, ready.heading, 'heading after response');
    sameBox(idle.trigger, loading.trigger, 'row while loading');
    sameBox(idle.trigger, ready.trigger, 'row after response');
    expect(status).toEqual({
      connected: true,
      live: 'polite',
      atomic: 'true',
      text: '',
    });
    expect(events.map((event) => event.type)).toEqual([
      'pointerdown',
      'pointerup',
      'click',
    ]);
    expect(events.every((event) => event.trusted)).toBe(true);
    const down = events[0];
    if (!down?.buttonNode)
      throw new Error('Native press must target the row button');
    expect(events.every((event) => event.buttonNode === down.buttonNode)).toBe(
      true,
    );
  } finally {
    input.reload.release();
    if (pressed) await page.mouse.up().catch(() => undefined);
    await input.reload.close();
  }
}

async function seedArticles(environment: Environment) {
  const path = join(environment.root, 'content/articles/one/meta.json');
  const base = ArticleMetaSchema.parse(
    JSON.parse(await readFile(path, 'utf8')),
  );
  const date = '2026-10-01T00:00:00.000Z';
  const target = ArticleMetaSchema.parse({
    ...base,
    title: 'A 保留的文章',
    publishedAt: date,
    updatedAt: date,
  });
  await writeFile(path, JSON.stringify(target));
  await mkdir(join(environment.root, 'content/articles/other'));
  await writeFile(
    join(environment.root, 'content/articles/other/meta.json'),
    JSON.stringify(
      ArticleMetaSchema.parse({
        ...target,
        title: 'Z 操作文章',
        slug: 'other',
      }),
    ),
  );
  await writeFile(
    join(environment.root, 'content/articles/other/content.html'),
    '<h2 id="other">另一篇文章</h2><p>透過真實發布與刪除更新清單。</p>',
  );
  return readFile(path);
}
async function confirm(page: Page, action: () => Promise<void>) {
  const accepted = page
    .waitForEvent('dialog')
    .then((dialog) => dialog.accept());
  await action();
  await accepted;
}

test('文章列表重讀：他篇發布與刪除不移動原文章，原生點擊與鍵盤開啟正確內容', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const original = await seedArticles(environment);
    await installPointerProof(page);
    await page.goto(environment.url);
    const target = page.locator(
      'tr[data-article-id="one"] .article-title-button',
    );
    await expect(target).toHaveText('A 保留的文章');
    for (const operation of ['publish', 'delete'] as const) {
      await page
        .getByLabel('文章排序', { exact: true })
        .selectOption('title-asc');
      const listed = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/v1/articles' &&
          url.searchParams.get('sort') === 'title-asc'
        );
      });
      await page.getByRole('button', { name: '套用篩選', exact: true }).click();
      const first = await listed;
      expect(first.status()).toBe(200);
      expect(
        Articles.parse(await first.json()).items.map((item) => item.id),
      ).toEqual(['one', 'other']);
      const reload = await holdReload(page, first.url(), (value) =>
        Articles.parse(value),
      );
      const row = page.locator('tr[data-article-id="other"]');
      await row.locator('summary[aria-label="更多操作：Z 操作文章"]').click();
      const method = operation === 'publish' ? 'PATCH' : 'DELETE';
      const changed = page.waitForResponse(
        (response) =>
          response.request().method() === method &&
          new URL(response.url()).pathname ===
            `/api/v1/articles/other${operation === 'publish' ? '/publication' : ''}`,
      );
      await nativeAcrossReload(page, {
        name: `articles-${operation}`,
        title: '文章',
        loadingLabel: '讀取文章中…',
        trigger: target,
        reload,
        begin: async () => {
          await confirm(page, () =>
            row
              .getByRole('button', {
                name: operation === 'publish' ? '發布已保存版本' : '刪除文章',
                exact: true,
              })
              .click(),
          );
          expect((await changed).status()).toBe(
            operation === 'publish' ? 200 : 204,
          );
        },
      });
      await expect(
        page.getByRole('heading', {
          name: '編輯文章：A 保留的文章',
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByLabel('文章標題', { exact: true })).toHaveValue(
        'A 保留的文章',
      );
      expect(
        await readFile(
          join(environment.root, 'content/articles/one/meta.json'),
        ),
      ).toEqual(original);
      await page.getByRole('button', { name: '文章', exact: true }).click();
      await expect(target).toHaveText('A 保留的文章');
    }
    await target.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', {
        name: '編輯文章：A 保留的文章',
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await readFile(join(environment.root, 'content/articles/one/meta.json')),
    ).toEqual(original);
  } finally {
    await environment.close();
  }
});

test('工作列表重讀：保留原列位置與可讀狀態，原生點擊及鍵盤開啟正確工作', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const queued = await page.request.post(
      `${environment.url}/api/v1/build-jobs`,
      {
        headers: { Origin: environment.url, 'Idempotency-Key': randomUUID() },
        data: {},
      },
    );
    expect(queued.status()).toBe(202);
    const job = JobSchema.parse(await queued.json());
    await expect
      .poll(
        async () =>
          JobSchema.parse(
            await (
              await page.request.get(`${environment.url}/api/v1/jobs/${job.id}`)
            ).json(),
          ).status,
      )
      .toBe('succeeded');
    await installPointerProof(page);
    const listed = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/v1/jobs' &&
        url.searchParams.get('pageSize') === '20'
      );
    });
    await page.goto(`${environment.url}/#/jobs`);
    const first = await listed;
    expect(first.status()).toBe(200);
    expect(
      Jobs.parse(await first.json()).items.map((item) => item.id),
    ).toContain(job.id);
    await expect(
      page.getByRole('region', { name: '網站狀態', exact: true }),
    ).toContainText('網站已更新至目前保存的內容。');
    const target = page
      .locator('table.jobs-table')
      .getByRole('button', { name: '網站更新 · 成功', exact: true });
    await expect(target).toBeVisible();
    const reload = await holdReload(page, first.url(), (value) =>
      Jobs.parse(value),
    );
    await nativeAcrossReload(page, {
      name: 'jobs',
      title: '網站更新與工作',
      loadingLabel: '讀取工作中…',
      trigger: target,
      reload,
      begin: () =>
        page.getByRole('button', { name: '重新讀取工作', exact: true }).click(),
    });
    const dialog = page.getByRole('dialog', {
      name: '工作詳細資料',
      exact: true,
    });
    await expect(dialog).toContainText(job.id);
    await expect(
      dialog.getByRole('definition').filter({ hasText: '網站更新 · 成功' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await target.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toContainText(job.id);
  } finally {
    await environment.close();
  }
});

test('復原列表重讀：真垃圾桶紀錄保持位置，原生點擊及鍵盤開啟正確比較', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const current = await page.request.get(
      `${environment.url}/api/v1/articles/one`,
    );
    expect(current.status()).toBe(200);
    ArticleResourceSchema.parse(await current.json());
    const etag = current.headers().etag;
    if (!etag) throw new Error('Precise article version is required');
    const removed = await page.request.delete(
      `${environment.url}/api/v1/articles/one`,
      {
        headers: { Origin: environment.url, 'If-Match': etag },
      },
    );
    expect(removed.status()).toBe(204);
    const rows = Recoveries.parse(
      await (
        await page.request.get(
          `${environment.url}/api/v1/recoveries?page=1&pageSize=20`,
        )
      ).json(),
    );
    const recovery = rows.items.find((item) => item.kind === 'trash');
    if (!recovery)
      throw new Error('Real article deletion must produce a trash recovery');
    const detail = RecoveryDetailSchema.parse(
      await (
        await page.request.get(
          `${environment.url}/api/v1/recoveries/${recovery.id}`,
        )
      ).json(),
    );
    expect(detail.choices).toContain('restore-trash');
    expect(
      detail.resources.some(
        (item) => item.resourceKey === 'content/articles/one/content.html',
      ),
    ).toBe(true);
    await installPointerProof(page);
    const listed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/recoveries',
    );
    await page.goto(`${environment.url}/#/recoveries`);
    const first = await listed;
    expect(first.status()).toBe(200);
    expect(
      Recoveries.parse(await first.json()).items.map((item) => item.id),
    ).toContain(recovery.id);
    const target = page
      .locator(`tr[data-recovery-id="${recovery.id}"]`)
      .getByRole('button', { name: '垃圾桶 · 可還原', exact: true });
    await expect(target).toBeVisible();
    const reload = await holdReload(page, first.url(), (value) =>
      Recoveries.parse(value),
    );
    await nativeAcrossReload(page, {
      name: 'recoveries',
      title: '衝突與復原',
      loadingLabel: '讀取復原紀錄中…',
      trigger: target,
      reload,
      begin: () =>
        page
          .getByRole('button', { name: '重新掃描復原紀錄', exact: true })
          .click(),
    });
    const dialog = page.getByRole('dialog', { name: '復原比較', exact: true });
    await expect(dialog).toContainText(recovery.id);
    await expect(
      dialog.getByRole('option', {
        name: 'content/articles/one/content.html',
        exact: true,
      }),
    ).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await target.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toContainText(recovery.id);
    expect(
      (
        await page.request.get(`${environment.url}/api/v1/articles/one`)
      ).status(),
    ).toBe(404);
  } finally {
    await environment.close();
  }
});
