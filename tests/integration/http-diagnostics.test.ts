import { it, expect } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiErrorSchema, ArticleResourceSchema } from '@foliohaven/core';
import {
  article,
  call,
  sandbox,
  start,
} from '../fixtures/http/environment.mjs';

it('keeps safe semantic field and HTML line diagnostics through actual HTTP validation errors', async () => {
  const root = await sandbox();
  const running = await start(root);
  try {
    const current = await call(running, '/api/v1/articles/one');
    const resource = ArticleResourceSchema.parse(current.body);
    const published = {
      contentHtml: resource.contentHtml,
      meta: {
        ...resource.meta,
        status: 'published',
        publishedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    };
    const unknown = await call(running, '/api/v1/articles/one', {
      method: 'PUT',
      body: {
        ...published,
        meta: { ...published.meta, category: 'unknown-category' },
      },
      headers: { 'If-Match': String(current.headers.etag) },
    });
    expect(unknown.status).toBe(422);
    const issue = ApiErrorSchema.parse(unknown.body).error.issues.find(
      (value) => value.code === 'UNKNOWN_CATEGORY',
    );
    expect(issue?.path).toEqual(['articles', 'one', 'meta', 'category']);
    const invalid = await call(running, '/api/v1/articles/one', {
      method: 'PUT',
      body: {
        ...published,
        contentHtml:
          '<p>SAFE_SOURCE_SENTINEL_NOT_IN_ERROR</p>\n<h2>缺少ID</h2>',
      },
      headers: { 'If-Match': String(current.headers.etag) },
    });
    expect(invalid.status).toBe(422);
    const bodyIssues = ApiErrorSchema.parse(invalid.body).error.issues;
    expect(
      bodyIssues.some(
        (value) =>
          value.path.join('.') === 'articles.one.contentHtml' &&
          /第 2 行/u.test(value.message),
      ),
    ).toBe(true);
    expect(invalid.bytes.toString()).not.toContain(
      'SAFE_SOURCE_SENTINEL_NOT_IN_ERROR',
    );
    expect(invalid.bytes.toString()).not.toContain(root);
    expect((await call(running, '/api/v1/articles/one')).headers.etag).toBe(
      current.headers.etag,
    );
  } finally {
    await running.service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('identifies a different invalid article rather than presenting its errors as the edited article', async () => {
  const root = await sandbox();
  const running = await start(root);
  try {
    const source = article();
    const publishedMeta = {
      ...source.meta,
      status: 'published',
      publishedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    await writeFile(
      join(root, 'content/articles/one/meta.json'),
      JSON.stringify(publishedMeta),
    );
    await mkdir(join(root, 'content/articles/other'));
    await writeFile(
      join(root, 'content/articles/other/meta.json'),
      JSON.stringify({ ...publishedMeta, slug: 'other' }),
    );
    await writeFile(
      join(root, 'content/articles/other/content.html'),
      '<h2 id="other">OTHER_SECRET_BODY</h2><a href="/notes/one/#intro">原本有效的連結</a>',
    );
    const current = await call(running, '/api/v1/articles/one');
    const response = await call(running, '/api/v1/articles/one', {
      method: 'PUT',
      body: {
        contentHtml: '<h2 id="changed-anchor">移除他篇仍引用的anchor</h2>',
        meta: publishedMeta,
      },
      headers: { 'If-Match': String(current.headers.etag) },
    });
    expect(response.status).toBe(422);
    const issues = ApiErrorSchema.parse(response.body).error.issues;
    expect(
      issues.some(
        (issue) =>
          issue.path.slice(0, 3).join('.') === 'articles.other.contentHtml' &&
          issue.code === 'BROKEN_FRAGMENT',
      ),
    ).toBe(true);
    expect(response.bytes.toString()).not.toContain('OTHER_SECRET_BODY');
  } finally {
    await running.service.close();
    await rm(root, { recursive: true, force: true });
  }
});
