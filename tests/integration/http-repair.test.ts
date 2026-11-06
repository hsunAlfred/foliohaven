import { expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ArticleResourceSchema,
  ContentValidationError,
  JobSchema,
  TaxonomyMigrationPlanSchema,
  WorkspaceSchema,
  buildSiteModel,
} from '@foliohaven/core';
import type { Diagnostic } from '@foliohaven/core';
import { loadContent } from '@foliohaven/core/node';
import { fixedPages, pageSchemas } from '@foliohaven/site/registry';
import {
  article,
  call,
  sandbox,
  start,
} from '../fixtures/http/environment.mjs';

const published = (slug: string) => ({
  ...article().meta,
  status: 'published',
  slug,
  publishedAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});
async function add(root: string, id: string, html: string, slug = id) {
  await mkdir(join(root, 'content/articles', id), { recursive: true });
  await writeFile(
    join(root, 'content/articles', id, 'meta.json'),
    JSON.stringify(published(slug)),
  );
  await writeFile(join(root, 'content/articles', id, 'content.html'), html);
}
async function diagnostics(root: string): Promise<readonly Diagnostic[]> {
  try {
    return buildSiteModel({
      ...(await loadContent(root, { mode: 'preview', pageSchemas })),
      fixedPages,
      mediaManifest: { schemaVersion: 1, assets: [] },
      now: new Date().toISOString(),
    }).diagnostics;
  } catch (error) {
    if (error instanceof ContentValidationError) return error.diagnostics;
    throw error;
  }
}

it('HTTP migration keeps both broken-link articles visible and repairs each published source with fresh ETags', async () => {
  const root = await sandbox();
  await add(root, 'one', '<h2 id="intro">目標</h2>');
  await add(
    root,
    'two',
    '<h2 id="two">第二篇</h2><a href="/notes/one/#intro">舊連結</a>',
  );
  await add(
    root,
    'three',
    '<h2 id="three">第三篇</h2><a href="/notes/one/#intro">舊連結</a>',
  );
  const running = await start(root);
  try {
    const workspace = WorkspaceSchema.parse(
      (await call(running, '/api/v1/workspace')).body,
    );
    const descriptor = {
      kind: 'category',
      from: 'notes',
      to: 'guides',
      workspaceRevision: workspace.revision,
    };
    const planned = await call(running, '/api/v1/taxonomy-migrations', {
      method: 'POST',
      body: { ...descriptor, confirmed: false },
    });
    expect(planned.status).toBe(200);
    const plan = TaxonomyMigrationPlanSchema.parse(planned.body);
    const accepted = await call(running, '/api/v1/taxonomy-migrations', {
      method: 'POST',
      body: { ...descriptor, confirmed: true, planId: plan.planId },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(accepted.status).toBe(202);
    const queued = JobSchema.parse(accepted.body);
    let job = queued;
    const deadline = Date.now() + 10_000;
    while (job.status === 'queued' || job.status === 'running') {
      if (Date.now() > deadline) throw new Error('Migration fixture timed out');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      job = JobSchema.parse(
        (await call(running, `/api/v1/jobs/${queued.id}`)).body,
      );
    }
    expect(job.status).toBe('succeeded');
    const listed = await call(running, '/api/v1/articles');
    expect(listed.status).toBe(200);
    const resources = (listed.body as { items: unknown[] }).items.map((value) =>
      ArticleResourceSchema.parse(value),
    );
    expect(resources.map((value) => value.id).sort()).toEqual([
      'one',
      'three',
      'two',
    ]);
    const errors = (await diagnostics(root)).filter(
      (value) => value.severity === 'error',
    );
    expect(errors.map((value) => value.articleId).sort()).toEqual([
      'three',
      'two',
    ]);
    for (const resource of resources)
      expect(resource.diagnostics).toEqual(
        errors.filter((value) => value.articleId === resource.id),
      );
    const targetBefore = await readFile(
      join(root, 'content/articles/one/content.html'),
    );
    const thirdBefore = await readFile(
      join(root, 'content/articles/three/content.html'),
    );
    for (const id of ['two', 'three']) {
      const current = await call(running, `/api/v1/articles/${id}`);
      expect(current.status).toBe(200);
      const resource = ArticleResourceSchema.parse(current.body);
      const repaired = await call(running, `/api/v1/articles/${id}`, {
        method: 'PUT',
        headers: { 'If-Match': String(current.headers.etag) },
        body: {
          contentHtml: resource.contentHtml.replace(
            '/notes/one/',
            '/guides/one/',
          ),
          meta: resource.meta,
        },
      });
      expect(repaired.status).toBe(200);
      expect(ArticleResourceSchema.parse(repaired.body).meta.status).toBe(
        'published',
      );
      if (id === 'two') {
        expect(
          await readFile(join(root, 'content/articles/three/content.html')),
        ).toEqual(thirdBefore);
        expect(
          (await diagnostics(root)).filter(
            (value) => value.severity === 'error',
          ),
        ).toEqual(errors.filter((value) => value.articleId === 'three'));
      }
    }
    expect(
      await readFile(join(root, 'content/articles/one/content.html')),
    ).toEqual(targetBefore);
    expect(
      (await diagnostics(root)).filter((value) => value.severity === 'error'),
    ).toEqual([]);
    const final = await call(running, '/api/v1/articles');
    expect(final.status).toBe(200);
    expect(
      (final.body as { items: unknown[] }).items
        .map((value) => ArticleResourceSchema.parse(value))
        .every((value) => value.diagnostics.length === 0),
    ).toBe(true);
  } finally {
    await running.service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['html', 'route', 'media'] as const)(
  'HTTP management lists return the complete actual Core %s diagnostics without pretending the source is valid',
  async (kind) => {
    const root = await sandbox();
    await add(root, 'one', '<h2 id="intro">正文</h2>');
    if (kind === 'html')
      await writeFile(
        join(root, 'content/articles/one/content.html'),
        '<h2>缺id</h2>',
      );
    if (kind === 'route')
      await add(root, 'two', '<h2 id="two">重複路由</h2>', 'one');
    if (kind === 'media')
      await writeFile(
        join(root, 'content/articles/one/meta.json'),
        JSON.stringify({
          ...published('one'),
          featuredImage:
            '/media/12345678-1234-4123-8123-123456789abc/image.webp',
          featuredImageAlt: '缺少的精選圖片',
        }),
      );
    const running = await start(root);
    try {
      const before = await readFile(
        join(root, 'content/articles/one/content.html'),
      );
      const expected = await diagnostics(root);
      expect(expected.some((value) => value.severity === 'error')).toBe(true);
      const response = await call(running, '/api/v1/articles');
      expect(response.status).toBe(200);
      const rows = (response.body as { items: unknown[] }).items.map((value) =>
        ArticleResourceSchema.parse(value),
      );
      expect(rows).toHaveLength(kind === 'route' ? 2 : 1);
      for (const row of rows)
        expect(row.diagnostics).toEqual(
          expected.filter(
            (value) =>
              value.articleId === undefined || value.articleId === row.id,
          ),
        );
      expect(
        await readFile(join(root, 'content/articles/one/content.html')),
      ).toEqual(before);
    } finally {
      await running.service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
