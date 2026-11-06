import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CurrentArtifactSchema, JobSchema } from '@foliohaven/core';
import type { Job } from '@foliohaven/core';
import { atomicJson } from '../../server/src/files/io.js';
import { studioEnvironment } from '../fixtures/studio/environment.js';

test.use({ viewport: { width: 1536, height: 1000 } });

type Environment = Awaited<ReturnType<typeof studioEnvironment>>;
const statuses: Record<Job['status'], string> = {
  queued: '排隊中',
  running: '執行中',
  succeeded: '成功',
  failed: '失敗',
  cancelled: '已取消',
  interrupted: '已中斷',
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('隔離工作紀錄不是物件');
  return value as Record<string, unknown>;
}
async function getJob(page: Page, environment: Environment, id: string) {
  const response = await page.request.get(
    `${environment.url}/api/v1/jobs/${id}`,
  );
  expect(response.status()).toBe(200);
  return JobSchema.parse(await response.json());
}
async function listedJob(page: Page, environment: Environment, id: string) {
  const response = await page.request.get(
    `${environment.url}/api/v1/jobs?type=build&page=1&pageSize=100`,
  );
  expect(response.status()).toBe(200);
  const collection = object(await response.json());
  if (!Array.isArray(collection.items))
    throw new Error('隔離工作清單缺少items');
  const job = collection.items
    .map((item) => JobSchema.parse(item))
    .find((item) => item.id === id);
  if (!job) throw new Error('隔離工作未出現在清單');
  return job;
}
async function realBuild(page: Page, environment: Environment) {
  await page.goto(environment.url);
  const accepted = await page.evaluate(async (key) => {
    const response = await fetch('/api/v1/build-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: '{}',
    });
    return {
      status: response.status,
      value: (await response.json()) as unknown,
    };
  }, randomUUID());
  expect(accepted.status).toBe(202);
  const queued = JobSchema.parse(accepted.value);
  await expect
    .poll(async () => (await getJob(page, environment, queued.id)).status)
    .toBe('succeeded');
  const result = await getJob(page, environment, queued.id);
  if (
    result.type !== 'build' ||
    result.status !== 'succeeded' ||
    !result.result
  )
    throw new Error('隔離Build沒有真實成功結果');
  return result;
}
async function artifact(page: Page, environment: Environment) {
  const response = await page.request.get(
    `${environment.url}/api/v1/artifacts/current`,
  );
  expect(response.status()).toBe(200);
  const current = CurrentArtifactSchema.parse(await response.json());
  return {
    digest: current.current?.digest,
    jobId: current.current?.build?.jobId,
  };
}
async function openJob(page: Page, environment: Environment, id: string) {
  // Each historical variant starts from a fresh document; changing only the
  // hash while another dialog is open exercises its history-close behavior.
  await page.goto('about:blank');
  await page.goto(`${environment.url}/#/jobs/${id}`);
  const detail = page.getByRole('dialog', {
    name: '工作詳細資料',
    exact: true,
  });
  await expect(detail.locator('.job-detail-summary')).toBeVisible();
  return detail;
}
function detailField(detail: Locator, label: string) {
  return detail
    .locator('.job-detail-summary > dt')
    .filter({ hasText: new RegExp(`^${label}$`, 'u') })
    .locator('xpath=following-sibling::dd[1]');
}
function variant(base: Job, status: Job['status'], progress: Job['progress']) {
  const active = status === 'queued' || status === 'running';
  return JobSchema.parse({
    ...base,
    id: randomUUID(),
    status,
    stage: active
      ? status === 'queued'
        ? 'queued'
        : 'preparing-promotion'
      : status,
    progress,
    startedAt: status === 'queued' ? null : base.startedAt,
    finishedAt: active ? null : base.finishedAt,
    result: status === 'succeeded' ? base.result : null,
    error:
      status === 'failed' || status === 'interrupted'
        ? {
            code: 'PROGRESS_FIXTURE_STOPPED',
            message: '隔離工作未完成。',
            retryable: false,
            issues: [],
          }
        : null,
  });
}
function rejectUiWrites(page: Page) {
  let writes = 0;
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method())) writes++;
  });
  return () => writes;
}

test('工作進度：真Build完成後legacy4/6只投影6/6，unknown及零總量顯示已完成且歷史原檔不重寫', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const built = await realBuild(page, environment);
    expect(built.progress).toEqual({ completed: 6, total: 6 });
    const jobPath = join(environment.root, `.alfred/jobs/${built.id}.json`);
    const record = object(JSON.parse(await readFile(jobPath, 'utf8')));
    const originalDist = await readFile(
      join(environment.root, 'dist/index.html'),
    );
    const originalArtifact = await artifact(page, environment);
    const writes = rejectUiWrites(page);
    for (const fixture of [
      {
        progress: { completed: 4, total: 6 },
        projected: { completed: 6, total: 6 },
        label: '6／6',
      },
      {
        progress: { completed: 4, total: null },
        projected: { completed: 4, total: null },
        label: '已完成',
      },
      {
        progress: { completed: 0, total: 0 },
        projected: { completed: 0, total: 0 },
        label: '已完成',
      },
    ]) {
      const legacy = JobSchema.parse({ ...built, progress: fixture.progress });
      await atomicJson(environment.root, `.alfred/jobs/${built.id}.json`, {
        ...record,
        job: legacy,
      });
      const legacyBytes = await readFile(jobPath);
      expect((await getJob(page, environment, built.id)).progress).toEqual(
        fixture.projected,
      );
      expect((await listedJob(page, environment, built.id)).progress).toEqual(
        fixture.projected,
      );
      const detail = await openJob(page, environment, built.id);
      await expect(detailField(detail, '種類／狀態')).toHaveText(
        '網站更新 · 成功',
      );
      await expect(detailField(detail, '目前階段')).toHaveText('已完成');
      await expect(detailField(detail, '進度')).toHaveText(fixture.label);
      await expect(
        detail.getByRole('progressbar', { name: '目前工作進度', exact: true }),
      ).toHaveCount(0);
      await expect(detailField(detail, '進度')).not.toContainText('估計');
      expect(await readFile(jobPath)).toEqual(legacyBytes);
      expect(await readFile(join(environment.root, 'dist/index.html'))).toEqual(
        originalDist,
      );
      expect(await artifact(page, environment)).toEqual(originalArtifact);
    }
    expect(writes()).toBe(0);
  } finally {
    await environment.close();
  }
});

test('工作進度：running與失敗取消中斷的4/6維持真實計數，終態不補成100%或顯示活動進度條', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  try {
    const built = await realBuild(page, environment);
    const originalDist = await readFile(
      join(environment.root, 'dist/index.html'),
    );
    const originalArtifact = await artifact(page, environment);
    const writes = rejectUiWrites(page);
    for (const status of [
      'running',
      'failed',
      'cancelled',
      'interrupted',
    ] as const) {
      const job = variant(built, status, { completed: 4, total: 6 });
      const relative = `.alfred/jobs/${job.id}.json`;
      await atomicJson(environment.root, relative, {
        schemaVersion: 1,
        job,
        payload: {},
        sourceRevision: built.snapshotRevision,
        cancelRequested: status === 'cancelled',
      });
      const originalRecord = await readFile(join(environment.root, relative));
      expect((await getJob(page, environment, job.id)).progress).toEqual({
        completed: 4,
        total: 6,
      });
      expect((await listedJob(page, environment, job.id)).progress).toEqual({
        completed: 4,
        total: 6,
      });
      const detail = await openJob(page, environment, job.id);
      await expect(detailField(detail, '種類／狀態')).toHaveText(
        `網站更新 · ${statuses[status]}`,
      );
      await expect(detailField(detail, '進度')).toHaveText('4／6');
      await expect(detailField(detail, '進度')).not.toContainText(/100|6／6/u);
      const progress = detail.getByRole('progressbar', {
        name: '目前工作進度',
        exact: true,
      });
      if (status === 'running') {
        await expect(progress).toHaveAttribute('value', '4');
        await expect(progress).toHaveAttribute('max', '6');
      } else {
        await expect(progress).toHaveCount(0);
        await expect(detailField(detail, '目前階段')).toHaveText(
          statuses[status],
        );
      }
      expect(await readFile(join(environment.root, relative))).toEqual(
        originalRecord,
      );
    }
    expect(writes()).toBe(0);
    expect(await readFile(join(environment.root, 'dist/index.html'))).toEqual(
      originalDist,
    );
    expect(await artifact(page, environment)).toEqual(originalArtifact);
  } finally {
    await environment.close();
  }
});

test('工作進度：各狀態unknown與零總量文案正確，合法GET投影不更動真實工作或dist', async ({
  page,
}) => {
  const environment = await studioEnvironment();
  let displayed: Job | null = null;
  try {
    const built = await realBuild(page, environment);
    const originalDist = await readFile(
      join(environment.root, 'dist/index.html'),
    );
    const originalArtifact = await artifact(page, environment);
    const jobPath = join(environment.root, `.alfred/jobs/${built.id}.json`);
    const originalRecord = await readFile(jobPath);
    const writes = rejectUiWrites(page);
    const detailUrl = `**/api/v1/jobs/${built.id}`;
    await page.route(detailUrl, async (route) => {
      if (route.request().method() === 'GET' && displayed)
        await route.fulfill({ json: displayed });
      else await route.continue();
    });
    const labels = {
      queued: '等待開始',
      running: '正在估計工作量',
      failed: '未提供進度數字',
      cancelled: '未提供進度數字',
      interrupted: '未提供進度數字',
    } as const;
    for (const status of [
      'queued',
      'running',
      'failed',
      'cancelled',
      'interrupted',
    ] as const) {
      for (const total of [null, 0]) {
        displayed = JobSchema.parse({
          ...variant(built, status, { completed: 0, total }),
          id: built.id,
        });
        const detail = await openJob(page, environment, built.id);
        await expect(detailField(detail, '種類／狀態')).toHaveText(
          `網站更新 · ${statuses[status]}`,
        );
        await expect(detailField(detail, '進度')).toHaveText(
          total === null ? labels[status] : '0／0',
        );
        await expect(detailField(detail, '進度')).not.toContainText(
          /NaN|Infinity|100%/u,
        );
        const progress = detail.getByRole('progressbar', {
          name: '目前工作進度',
          exact: true,
        });
        if (status === 'queued' || status === 'running') {
          if (total === null)
            await expect(progress).not.toHaveAttribute('value');
          else {
            await expect(progress).toHaveAttribute('value', '0');
            await expect(progress).toHaveAttribute('max', '1');
          }
        } else await expect(progress).toHaveCount(0);
        if (total === 0)
          await expect(detailField(detail, '進度')).not.toContainText('估計');
      }
    }
    expect(writes()).toBe(0);
    expect(await readFile(jobPath)).toEqual(originalRecord);
    expect(await readFile(join(environment.root, 'dist/index.html'))).toEqual(
      originalDist,
    );
    expect(await artifact(page, environment)).toEqual(originalArtifact);
    await page.unroute(detailUrl);
    expect((await getJob(page, environment, built.id)).status).toBe(
      'succeeded',
    );
    expect((await getJob(page, environment, built.id)).progress).toEqual({
      completed: 6,
      total: 6,
    });
  } finally {
    await environment.close();
  }
});
