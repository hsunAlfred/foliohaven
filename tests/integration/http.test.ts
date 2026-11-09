import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiErrorSchema,
  ArticleResourceSchema,
  JobSchema,
  OperationSchema,
  SiteConfigSchema,
  TaxonomySchema,
  TaxonomyMigrationPlanSchema,
  WorkspaceSchema,
} from '@foliohaven/core';
import {
  article,
  call,
  sandbox,
  start,
  waitFor,
} from '../fixtures/http/environment.mjs';
import type { RunningService } from '../fixtures/http/environment.mjs';
import { OperationStore } from '../../server/src/operations/index.js';
import { JobManager } from '../../server/src/jobs/index.js';
import { scanBuildInputs } from '../../server/src/build/inputs.js';

let root = '';
let running: RunningService;
beforeEach(async () => {
  root = await sandbox();
  running = await start(root);
});
afterEach(async () => {
  await running?.service.close();
  if (root) await rm(root, { recursive: true, force: true });
});
const failCode = (value: unknown) => ApiErrorSchema.parse(value).error.code;
describe('API-01/02：完整本機HTTP契約與來源副作用', () => {
  it('health只GET回固定本體，其餘未知path也必須驗證；無環境/token洩漏', async () => {
    const health = await call(running, '/api/v1/health', { authorized: false });
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
    expect(health.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/u);
    expect(health.headers['cache-control']).toBe('no-store');
    const noauth = await call(running, '/unknown', { authorized: false });
    expect(noauth.status).toBe(403);
    expect(failCode(noauth.body)).toBe('SERVICE_FORBIDDEN');
    const wrong = await call(running, '/api/v1/health', {
      method: 'POST',
      authorized: false,
    });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('GET');
  });
  it('拒絕偽造token/Host/Origin，只有observed Studio origin精確相等才允許mutation', async () => {
    for (const headers of [
      { 'x-foliohaven-process-token': 'wrong' },
      { host: 'evil.invalid' },
      { host: '127.0.0.1.evil.invalid' },
      { host: 'localhost:99999' },
    ]) {
      const result = await call(running, '/api/v1/workspace', { headers });
      expect(result.status).toBe(403);
    }
    for (const headers of [
      { origin: 'http://evil.invalid' },
      { 'x-foliohaven-studio-origin': 'http://localhost:5174' },
      { origin: 'null' },
      { origin: 'http://localhost:5173/' },
    ]) {
      const result = await call(running, '/api/v1/previews', {
        method: 'POST',
        body: article(),
        headers,
      });
      expect(result.status).toBe(403);
    }
    expect(
      await readFile(join(root, 'content/articles/one/content.html'), 'utf8'),
    ).toBe(article().contentHtml);
  });
  it('已知route不支援method回405 Allow；未知route404，encoded traversal和反斜線400', async () => {
    for (const [path, allow] of [
      ['/api/v1/articles', 'GET, POST'],
      ['/api/v1/jobs/' + randomUUID(), 'GET'],
      ['/api/v1/media/sources/' + randomUUID(), 'GET, PUT, DELETE'],
    ]) {
      const result = await call(running, path ?? '', { method: 'OPTIONS' });
      expect(result.status).toBe(405);
      expect(result.headers.allow).toBe(allow);
    }
    expect((await call(running, '/api/v1/not-defined')).status).toBe(404);
    for (const path of [
      '/api/v1/articles/%2e%2e',
      '/api/v1/articles/../site.json',
      '/api/v1/articles/a%2fb',
      '/api/v1/articles/a\\b',
      '/api/v1/articles/%00',
    ])
      expect((await call(running, path)).status).toBe(400);
  });
  it('JSON MIME/UTF8/大小/未知欄位及重複query安全拒絕，沒有來源副作用', async () => {
    expect(
      (
        await call(running, '/api/v1/articles', {
          method: 'POST',
          raw: '{}',
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call(running, '/api/v1/articles', {
          method: 'POST',
          raw: Buffer.from([0xff]),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(running, '/api/v1/articles', {
          method: 'POST',
          raw: '{',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(running, '/api/v1/articles', {
          method: 'POST',
          raw: '{}',
          headers: {
            'content-type': 'application/json',
            'content-length': String(32 * 1024 * 1024 + 1),
          },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call(running, '/api/v1/articles', {
          method: 'POST',
          body: { ...article(), id: 'forbidden' },
          headers: { 'idempotency-key': randomUUID() },
        })
      ).status,
    ).toBe(422);
    expect((await call(running, '/api/v1/articles?page=1&page=2')).status).toBe(
      400,
    );
    expect((await call(running, '/api/v1/articles?sort=anything')).status).toBe(
      422,
    );
    expect(await readdir(join(root, 'content/articles'))).toEqual(['one']);
  });
  it('POST draft真建HTML+meta、Location/ETag、同key原201重送且異payload409', async () => {
    const key = randomUUID();
    const payload = {
      ...article(),
      meta: { ...article().meta, title: '新文章' },
    };
    const created = await call(running, '/api/v1/articles', {
      method: 'POST',
      body: payload,
      headers: { 'idempotency-key': key },
    });
    expect(created.status).toBe(201);
    const value = ArticleResourceSchema.parse(created.body);
    expect(created.headers.location).toBe(`/api/v1/articles/${value.id}`);
    expect(created.headers.etag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(
      await readFile(
        join(root, 'content/articles', value.id, 'content.html'),
        'utf8',
      ),
    ).toBe(payload.contentHtml);
    const replay = await call(running, '/api/v1/articles', {
      method: 'POST',
      body: payload,
      headers: { 'idempotency-key': key },
    });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(created.body);
    expect(replay.headers.etag).toBe(created.headers.etag);
    const conflict = await call(running, '/api/v1/articles', {
      method: 'POST',
      body: article(),
      headers: { 'idempotency-key': key },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.headers.location).toMatch(/^\/api\/v1\/operations\//u);
    expect(await readdir(join(root, 'content/articles'))).toHaveLength(2);
  });
  it('POST缺key428、錯key422；已保留操作的業務失敗原HTTP422可由摘要追蹤且不自動重做', async () => {
    expect(
      (
        await call(running, '/api/v1/articles', {
          method: 'POST',
          body: article(),
        })
      ).status,
    ).toBe(428);
    expect(
      (
        await call(running, '/api/v1/articles', {
          method: 'POST',
          body: article(),
          headers: { 'idempotency-key': 'not-a-uuid' },
        })
      ).status,
    ).toBe(422);
    const key = randomUUID();
    const payload = {
      ...article(),
      meta: {
        ...article().meta,
        status: 'published',
        publishedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    };
    const failed = await call(running, '/api/v1/articles', {
      method: 'POST',
      body: payload,
      headers: { 'idempotency-key': key },
    });
    expect(failed.status).toBe(422);
    const name = (await readdir(join(root, '.foliohaven/operations'))).find(
      (name) => name.endsWith(`--${key}.json`),
    );
    if (!name) throw new Error('failed operation missing');
    const summary = await call(
      running,
      `/api/v1/operations/${name.split('--')[0]}`,
    );
    expect(OperationSchema.parse(summary.body)).toMatchObject({
      status: 'failed',
      httpStatus: 422,
      error: { code: 'INITIAL_STATUS_MUST_BE_DRAFT' },
    });
    expect(
      (
        await call(running, '/api/v1/articles', {
          method: 'POST',
          body: payload,
          headers: { 'idempotency-key': key },
        })
      ).status,
    ).toBe(409);
    expect(await readdir(join(root, 'content/articles'))).toEqual(['one']);
  });
  it('文章PUT缺版本428、舊版本412帶最新ETag，成功完整替換並PATCH發布/撤回', async () => {
    const before = await call(running, '/api/v1/articles/one');
    expect(before.status).toBe(200);
    const payload = {
      ...article(),
      meta: { ...article().meta, title: '新標題' },
    };
    expect(
      (
        await call(running, '/api/v1/articles/one', {
          method: 'PUT',
          body: payload,
        })
      ).status,
    ).toBe(428);
    const saved = await call(running, '/api/v1/articles/one', {
      method: 'PUT',
      body: payload,
      headers: { 'if-match': String(before.headers.etag) },
    });
    expect(saved.status).toBe(200);
    const stale = await call(running, '/api/v1/articles/one', {
      method: 'PUT',
      body: article(),
      headers: { 'if-match': String(before.headers.etag) },
    });
    expect(stale.status).toBe(412);
    expect(stale.headers.etag).toBe(saved.headers.etag);
    const published = await call(running, '/api/v1/articles/one/publication', {
      method: 'PATCH',
      body: {
        status: 'published',
        publishedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      headers: { 'if-match': String(saved.headers.etag) },
    });
    expect(published.status).toBe(200);
    expect(ArticleResourceSchema.parse(published.body).meta.status).toBe(
      'published',
    );
    const draft = await call(running, '/api/v1/articles/one/publication', {
      method: 'PATCH',
      body: { status: 'draft', publishedAt: null, updatedAt: null },
      headers: { 'if-match': String(published.headers.etag) },
    });
    expect(draft.status).toBe(200);
    expect(ArticleResourceSchema.parse(draft.body).meta.status).toBe('draft');
  });
  it('發布驗證保留安全issues，列表篩選/分頁由Core處理且損壞來源不假成功', async () => {
    const before = await call(running, '/api/v1/articles/one');
    const bad = await call(running, '/api/v1/articles/one', {
      method: 'PUT',
      body: {
        ...article(),
        meta: { ...article().meta, status: 'published', publishedAt: null },
      },
      headers: { 'if-match': String(before.headers.etag) },
    });
    expect(bad.status).toBe(422);
    expect(ApiErrorSchema.parse(bad.body).error.issues.length).toBeGreaterThan(
      0,
    );
    const list = await call(
      running,
      `/api/v1/articles?status=draft&page=1&pageSize=1&q=${encodeURIComponent('文章')}`,
    );
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    await writeFile(join(root, 'content/articles/one/meta.json'), '{broken');
    const damaged = await call(running, '/api/v1/articles/one');
    expect(damaged.status).toBe(422);
    expect(failCode(damaged.body)).toBe('INVALID_JSON');
    expect(damaged.bytes.toString()).not.toContain(root);
  });
  it('workspace strong ETag、IDE模式與安全模式切換CAS，IDE下來源保存拒絕', async () => {
    const initial = await call(running, '/api/v1/workspace');
    expect(initial.status).toBe(200);
    expect(WorkspaceSchema.parse(initial.body).editMode).toBe('studio');
    const ide = await call(running, '/api/v1/workspace/edit-mode', {
      method: 'PUT',
      body: { mode: 'ide' },
      headers: { 'if-match': String(initial.headers.etag) },
    });
    expect(ide.status).toBe(200);
    expect(ide.headers.etag).not.toBe(initial.headers.etag);
    const item = await call(running, '/api/v1/articles/one');
    const rejected = await call(running, '/api/v1/articles/one', {
      method: 'PUT',
      body: article(),
      headers: { 'if-match': String(item.headers.etag) },
    });
    expect(rejected.status).toBe(409);
    const stale = await call(running, '/api/v1/workspace/edit-mode', {
      method: 'PUT',
      body: { mode: 'studio' },
      headers: { 'if-match': String(initial.headers.etag) },
    });
    expect(stale.status).toBe(412);
    const studio = await call(running, '/api/v1/workspace/edit-mode', {
      method: 'PUT',
      body: { mode: 'studio' },
      headers: { 'if-match': String(ide.headers.etag) },
    });
    expect(studio.status).toBe(200);
  });
  it('taxonomy/site完整讀寫與引用衝突，If-Match及未知欄位維持共同契約', async () => {
    const before = await call(running, '/api/v1/taxonomy');
    const value = TaxonomySchema.parse(before.body);
    const saved = await call(running, '/api/v1/taxonomy', {
      method: 'PUT',
      body: {
        ...value,
        categories: value.categories.map((item) => ({
          ...item,
          name: item.path === 'notes' ? '新筆記' : item.name,
        })),
      },
      headers: { 'if-match': String(before.headers.etag) },
    });
    expect(saved.status).toBe(200);
    const conflict = await call(running, '/api/v1/taxonomy', {
      method: 'PUT',
      body: {
        ...value,
        categories: value.categories.filter((item) => item.path !== 'notes'),
      },
      headers: { 'if-match': String(saved.headers.etag) },
    });
    expect(conflict.status).toBe(409);
    const oldSite = await call(running, '/api/v1/site-settings');
    const config = SiteConfigSchema.parse(oldSite.body);
    const nextSite = await call(running, '/api/v1/site-settings', {
      method: 'PUT',
      body: { ...config, siteName: '正式保存' },
      headers: { 'if-match': String(oldSite.headers.etag) },
    });
    expect(nextSite.status).toBe(200);
    expect(SiteConfigSchema.parse(nextSite.body).siteName).toBe('正式保存');
  });
  it('symlink來源拒絕且不洩漏主機路徑，未知ID安全404/422', async () => {
    await rm(join(root, 'content/articles/one/content.html'));
    await symlink(
      join(root, 'content/site.json'),
      join(root, 'content/articles/one/content.html'),
    );
    const bad = await call(running, '/api/v1/articles/one');
    expect(bad.status).toBe(409);
    expect(bad.bytes.toString()).not.toContain(root);
    expect((await call(running, `/api/v1/jobs/${randomUUID()}`)).status).toBe(
      404,
    );
    expect(
      (await call(running, `/api/v1/operations/${randomUUID()}`)).status,
    ).toBe(404);
  });
  it('真HTTP dry-run不占Idempotency-Key，confirmed原計畫建立taxonomy job並真交易', async () => {
    const workspace = WorkspaceSchema.parse(
      (await call(running, '/api/v1/workspace')).body,
    );
    const payload = {
      kind: 'category',
      from: 'notes',
      to: 'renamed',
      workspaceRevision: workspace.revision,
      confirmed: false,
    };
    const planned = await call(running, '/api/v1/taxonomy-migrations', {
      method: 'POST',
      body: payload,
    });
    expect(planned.status).toBe(200);
    const plan = TaxonomyMigrationPlanSchema.parse(planned.body);
    expect(plan.affectedArticleIds).toEqual(['one']);
    const key = randomUUID();
    const confirmed = { ...payload, confirmed: true, planId: plan.planId };
    const created = await call(running, '/api/v1/taxonomy-migrations', {
      method: 'POST',
      body: confirmed,
      headers: { 'idempotency-key': key },
    });
    expect(created.status).toBe(202);
    const job = JobSchema.parse(created.body);
    expect(job.status).toBe('queued');
    const done = await waitFor(
      () => call(running, `/api/v1/jobs/${job.id}`),
      (value) =>
        !['queued', 'running'].includes(JobSchema.parse(value.body).status),
    );
    expect(JobSchema.parse(done.body).status, JSON.stringify(done.body)).toBe(
      'succeeded',
    );
    expect(JobSchema.parse(done.body).result).toMatchObject({
      kind: 'category',
      from: 'notes',
      to: 'renamed',
    });
    expect(
      ArticleResourceSchema.parse(
        (await call(running, '/api/v1/articles/one')).body,
      ).meta.category,
    ).toBe('renamed');
    const replay = await call(running, '/api/v1/taxonomy-migrations', {
      method: 'POST',
      body: confirmed,
      headers: { 'idempotency-key': key },
    });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(created.body);
  });
  it('confirmed migration拒絕變造/過期計畫及來源更新，不建立可執行job', async () => {
    await running.service.close();
    let now = new Date();
    running = await start(root, { clock: () => now });
    const workspace = WorkspaceSchema.parse(
      (await call(running, '/api/v1/workspace')).body,
    );
    const descriptor = {
      kind: 'category',
      from: 'notes',
      to: 'renamed',
      workspaceRevision: workspace.revision,
      confirmed: false,
    };
    const planned = TaxonomyMigrationPlanSchema.parse(
      (
        await call(running, '/api/v1/taxonomy-migrations', {
          method: 'POST',
          body: descriptor,
        })
      ).body,
    );
    const changed = await call(running, '/api/v1/taxonomy-migrations', {
      method: 'POST',
      body: {
        ...descriptor,
        to: 'different',
        confirmed: true,
        planId: planned.planId,
      },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(changed.status).toBe(409);
    now = new Date(now.getTime() + 600_001);
    const expired = await call(running, '/api/v1/taxonomy-migrations', {
      method: 'POST',
      body: { ...descriptor, confirmed: true, planId: planned.planId },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(expired.status).toBe(409);
    const second = TaxonomyMigrationPlanSchema.parse(
      (
        await call(running, '/api/v1/taxonomy-migrations', {
          method: 'POST',
          body: descriptor,
        })
      ).body,
    );
    const settings = await call(running, '/api/v1/site-settings');
    expect(
      (
        await call(running, '/api/v1/site-settings', {
          method: 'PUT',
          body: {
            ...SiteConfigSchema.parse(settings.body),
            siteName: '使revision變更',
          },
          headers: { 'if-match': String(settings.headers.etag) },
        })
      ).status,
    ).toBe(200);
    const stale = await call(running, '/api/v1/taxonomy-migrations', {
      method: 'POST',
      body: { ...descriptor, confirmed: true, planId: second.planId },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(stale.status).toBe(409);
    expect((await call(running, '/api/v1/jobs')).body).toMatchObject({
      total: 0,
    });
  });
  it('queued taxonomy重啟用持久確認授權與相同revision重算，HTTP可見成功與原202', async () => {
    await running.service.close();
    const revision = (await scanBuildInputs(root)).revision;
    const operations = new OperationStore({ repositoryRoot: root });
    const manager = new JobManager({ repositoryRoot: root, operations });
    const payload = {
      kind: 'category' as const,
      from: 'notes',
      to: 'restored-plan',
      workspaceRevision: revision,
      confirmed: true,
      planId: randomUUID(),
    };
    const key = randomUUID();
    const reserved = await operations.reserve({
      key,
      kind: 'taxonomy-migration',
      payload,
    });
    if (reserved.status !== 'reserved')
      throw new Error('fixture reservation required');
    const queued = await manager.create({
      type: 'taxonomy',
      payload,
      sourceRevision: revision,
      operation: reserved.reservation,
    });
    await manager.close();
    await operations.close();
    running = await start(root);
    const done = await waitFor(
      () => call(running, `/api/v1/jobs/${queued.id}`),
      (value) =>
        !['queued', 'running'].includes(JobSchema.parse(value.body).status),
    );
    expect(done.status).toBe(200);
    expect(JobSchema.parse(done.body).status, JSON.stringify(done.body)).toBe(
      'succeeded',
    );
    expect(
      ArticleResourceSchema.parse(
        (await call(running, '/api/v1/articles/one')).body,
      ).meta.category,
    ).toBe('restored-plan');
    const summary = await call(
      running,
      `/api/v1/operations/${reserved.reservation.id}`,
    );
    expect(OperationSchema.parse(summary.body)).toMatchObject({
      status: 'committed',
      httpStatus: 202,
      jobUrl: `/api/v1/jobs/${queued.id}`,
    });
    const replay = await call(running, '/api/v1/taxonomy-migrations', {
      method: 'POST',
      body: payload,
      headers: { 'idempotency-key': key },
    });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(queued);
  });
});
