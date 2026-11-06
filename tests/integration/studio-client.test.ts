import { describe, expect, it } from 'vitest';
import { ArticleWriteSchema, MediaAssetSchema } from '@foliohaven/core';
import { ApiFailure, StudioApi, apiPath } from '../../studio/src/api.js';
import { mediaMarkup } from '../../studio/src/media-markup.js';
import {
  inputIssues,
  inputFieldPath,
  isCurrentHtmlDiagnostic,
} from '../../studio/src/validation.js';

const requestId = '11111111-1111-4111-8111-111111111111';
function failure(status: number) {
  return new Response(
    JSON.stringify({
      error: {
        code: 'TEMPORARY_FAILURE',
        message: '暫時無法服務。',
        retryable: true,
        issues: [],
        requestId,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        Location: `/api/v1/operations/${requestId}`,
        'X-Request-Id': requestId,
      },
    },
  );
}
describe('STUDIO-API-01: browser API contract and source-safe formatting', () => {
  it('allows HTML locations only for the current proven source, never another article or metadata line', () => {
    const html = {
      severity: 'error' as const,
      code: 'HTML_H1_FORBIDDEN',
      message: '正文錯誤',
      articleId: 'one',
      line: 2,
      column: 1,
    };
    expect(isCurrentHtmlDiagnostic(html, 'one')).toBe(true);
    expect(
      isCurrentHtmlDiagnostic({ ...html, articleId: 'other' }, 'one'),
    ).toBe(false);
    expect(
      isCurrentHtmlDiagnostic(
        { ...html, resource: 'content/articles/one/meta.json' },
        'one',
      ),
    ).toBe(false);
    expect(
      isCurrentHtmlDiagnostic({ ...html, field: 'meta.title' }, 'one'),
    ).toBe(false);
    expect(
      isCurrentHtmlDiagnostic({ ...html, code: 'UNKNOWN_METADATA' }, 'one'),
    ).toBe(false);
    expect(
      isCurrentHtmlDiagnostic(
        {
          ...html,
          articleId: 'other',
          resource: 'content/articles/one/content.html',
        },
        'one',
      ),
    ).toBe(false);
    expect(
      isCurrentHtmlDiagnostic(
        {
          severity: 'error',
          code: 'BROKEN_INTERNAL_LINK',
          message: '正文連結',
          resource: 'content/articles/one/content.html',
          line: 3,
        },
        'one',
      ),
    ).toBe(true);
    expect(isCurrentHtmlDiagnostic(html, null)).toBe(false);
  });

  it('focuses only the current article path without changing the displayed error path', () => {
    const path = ['articles', 'one', 'meta', 'category'] as const;
    expect(inputFieldPath(path, 'one')).toEqual(['meta', 'category']);
    expect(path).toEqual(['articles', 'one', 'meta', 'category']);
    expect(inputFieldPath(path, 'other')).toBe(path);
    expect(inputFieldPath(path, null)).toBe(path);
    expect(inputFieldPath(['articles', 'one', 'contentHtml'], 'one')).toEqual([
      'contentHtml',
    ]);
    expect(inputFieldPath(['navigation', 0, 'href'], 'one')).toEqual([
      'navigation',
      0,
      'href',
    ]);
  });

  it('retries temporary GET errors only three times using 1/2/4 second backoff', async () => {
    const delays: number[] = [];
    let calls = 0;
    const api = new StudioApi(
      async () => {
        calls++;
        return calls < 4
          ? failure(503)
          : new Response('{"value":"ready"}', {
              status: 200,
              headers: { ETag: '"revision"' },
            });
      },
      async (delay) => {
        delays.push(delay);
      },
    );
    const result = await api.get<{ value: string }>('/api/v1/workspace');
    expect(calls).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(result.data.value).toBe('ready');
    expect(result.etag).toBe('"revision"');
  });
  it.each([403, 404, 422])(
    'never retries permanent GET status %s',
    async (status) => {
      let calls = 0;
      const api = new StudioApi(
        async () => {
          calls++;
          return failure(status);
        },
        async () => {
          throw new Error('must not wait');
        },
      );
      await expect(api.get('/api/v1/articles/missing')).rejects.toMatchObject({
        status,
      });
      expect(calls).toBe(1);
    },
  );
  it('never retries mutations and retains safe operation Location, request ID and header values', async () => {
    const seen: RequestInit[] = [];
    const api = new StudioApi(
      async (_path, options) => {
        seen.push(options ?? {});
        return failure(503);
      },
      async () => {
        throw new Error('mutation retry is forbidden');
      },
    );
    const key = '22222222-2222-4222-8222-222222222222';
    const command = {
      label: '建立文章',
      method: 'POST' as const,
      path: '/api/v1/articles',
      body: { contentHtml: '<p>原文\n</p>' },
      idempotencyKey: key,
    };
    await expect(api.execute(command)).rejects.toMatchObject({
      status: 503,
      location: `/api/v1/operations/${requestId}`,
      requestId,
    });
    expect(seen).toHaveLength(1);
    await expect(api.execute(command)).rejects.toBeInstanceOf(ApiFailure);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.body).toBe(seen[1]?.body);
    expect(new Headers(seen[0]?.headers).get('Idempotency-Key')).toBe(key);
    expect(new Headers(seen[1]?.headers).get('Idempotency-Key')).toBe(key);
    expect(new Headers(seen[0]?.headers).has('x-alfred-process-token')).toBe(
      false,
    );
  });
  it('keeps preview editor ID out of the ArticleWrite body and sends it only as a header', async () => {
    let seen: RequestInit | undefined;
    const api = new StudioApi(async (_path, options) => {
      seen = options;
      return new Response('{}', { status: 201 });
    });
    await api.send(
      'POST',
      '/api/v1/previews',
      { contentHtml: '原文' },
      { editorId: requestId },
    );
    expect(new Headers(seen?.headers).get('x-alfred-editor-id')).toBe(
      requestId,
    );
    expect(seen?.body).toBe('{"contentHtml":"原文"}');
  });
  it('rejects cross-origin, traversal and non-API paths before any request', async () => {
    let calls = 0;
    const api = new StudioApi(async () => {
      calls++;
      return new Response('{}');
    });
    for (const path of [
      'https://other.invalid/api/v1/workspace',
      '//other.invalid/api/v1/workspace',
      '/api/v1/../../private',
      '/content/site.json',
      '/api/v1/workspace#fragment',
    ]) {
      expect(() => apiPath(path)).toThrow(ApiFailure);
      await expect(api.get(path)).rejects.toMatchObject({
        code: 'INVALID_API_PATH',
      });
    }
    expect(calls).toBe(0);
  });
  it('does not turn an aborted GET into a retried service failure or expose non-JSON error text', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const api = new StudioApi(async () => {
      calls++;
      throw new DOMException('中止', 'AbortError');
    });
    await expect(
      api.get('/api/v1/workspace', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
    const broken = new StudioApi(
      async () =>
        new Response('private implementation detail', { status: 502 }),
    );
    await expect(
      broken.send('POST', '/api/v1/articles', {}),
    ).rejects.toMatchObject({
      code: 'INVALID_API_RESPONSE',
      message: '本機服務未回傳有效 JSON。',
    });
  });
  it('locates real nested Core publish-validation errors without changing the validation decision', () => {
    const result = ArticleWriteSchema.safeParse({
      contentHtml: '',
      meta: { status: 'published' },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected validation failure');
    const fields = inputIssues(result.error).map((issue) =>
      issue.path.join('.'),
    );
    expect(fields).toContain('meta.title');
    expect(fields).toContain('meta.publishedAt');
    expect(fields.some((path) => path.startsWith('meta.meta.'))).toBe(false);
  });
  it('copies actual manifest paths and sizes while escaping per-reference alt text', () => {
    const id = requestId;
    const asset = MediaAssetSchema.parse({
      id,
      kind: 'image',
      sourceSha256: 'a'.repeat(64),
      presetVersion: 'article-image-v1',
      tools: { sharp: 'fixture' },
      outputs: [
        {
          publicPath: `/media/${id}/image.webp`,
          mimeType: 'image/webp',
          width: 800,
          height: 400,
          byteSize: 10,
          sha256: 'b'.repeat(64),
        },
        {
          publicPath: `/media/${id}/image-480.webp`,
          mimeType: 'image/webp',
          width: 480,
          height: 240,
          byteSize: 5,
          sha256: 'c'.repeat(64),
        },
      ],
    });
    const snippet = mediaMarkup(asset, '"<alt>&');
    expect(snippet).toContain('alt="&quot;&lt;alt&gt;&amp;"');
    expect(snippet).toContain('width="800" height="400"');
    expect(snippet.indexOf('image-480.webp 480w')).toBeLessThan(
      snippet.indexOf('image.webp 800w'),
    );
    expect(snippet).not.toContain('media/source');
  });
});
