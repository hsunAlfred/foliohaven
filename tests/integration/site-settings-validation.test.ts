import { expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiErrorSchema, ETagSchema, SiteConfigSchema } from '@foliohaven/core';
import { call, sandbox, start } from '../fixtures/http/environment.mjs';
import type { RunningService } from '../fixtures/http/environment.mjs';

it('rejects malformed site URLs with HTTP 422 and preserves the source and ETag until a valid save', async () => {
  const root = await sandbox();
  let running: RunningService | null = null;
  try {
    running = await start(root);
    const source = join(root, 'content/site.json');
    const originalBytes = await readFile(source);
    const initial = await call(running, '/api/v1/site-settings');
    expect(initial.status).toBe(200);
    const config = SiteConfigSchema.parse(initial.body);
    const originalEtag = ETagSchema.parse(initial.headers.etag);

    for (const siteUrl of ['', 'https://', 'https://[']) {
      const rejected = await call(running, '/api/v1/site-settings', {
        method: 'PUT',
        body: { ...config, siteUrl },
        headers: { 'If-Match': originalEtag },
      });
      expect(rejected.status).toBe(422);
      const error = ApiErrorSchema.parse(rejected.body).error;
      expect(error.issues.some((issue) => issue.path.includes('siteUrl'))).toBe(
        true,
      );
      expect(await readFile(source)).toEqual(originalBytes);
      const unchanged = await call(running, '/api/v1/site-settings');
      expect(unchanged.status).toBe(200);
      expect(unchanged.headers.etag).toBe(originalEtag);
      expect(SiteConfigSchema.parse(unchanged.body)).toEqual(config);
    }

    const next = { ...config, siteUrl: 'https://validated.example.invalid/' };
    const saved = await call(running, '/api/v1/site-settings', {
      method: 'PUT',
      body: next,
      headers: { 'If-Match': originalEtag },
    });
    expect(saved.status).toBe(200);
    expect(SiteConfigSchema.parse(saved.body)).toEqual(next);
    const savedEtag = ETagSchema.parse(saved.headers.etag);
    expect(savedEtag).not.toBe(originalEtag);
    expect(
      SiteConfigSchema.parse(JSON.parse((await readFile(source)).toString())),
    ).toEqual(next);
    const current = await call(running, '/api/v1/site-settings');
    expect(current.status).toBe(200);
    expect(current.headers.etag).toBe(savedEtag);
    expect(SiteConfigSchema.parse(current.body)).toEqual(next);
  } finally {
    try {
      await running?.service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
