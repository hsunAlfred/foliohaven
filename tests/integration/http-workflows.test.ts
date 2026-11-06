import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ArticleResourceSchema,
  JobSchema,
  MediaSourceResourceSchema,
  OperationSchema,
  PreviewResponseSchema,
  RecoveryDetailSchema,
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
import type { NativeImageFactory } from '../../server/src/media/worker.js';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { RepositoryError } from '../../server/src/files/io.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
let root = '';
let running: RunningService;
const nativePids = new Set<number>();
beforeEach(async () => {
  root = await sandbox();
  running = await start(root);
});
afterEach(async () => {
  await running?.service.close();
  for (const pid of nativePids)
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* 已結束 */
    }
  nativePids.clear();
  if (root) await rm(root, { recursive: true, force: true });
});
const terminal = async (id: string) =>
  JobSchema.parse(
    (
      await waitFor(
        () => call(running, `/api/v1/jobs/${id}`),
        (value) =>
          !['queued', 'running'].includes(JobSchema.parse(value.body).status),
      )
    ).body,
  );
async function build() {
  const created = await call(running, '/api/v1/build-jobs', {
    method: 'POST',
    body: {},
    headers: { 'idempotency-key': randomUUID() },
  });
  expect(created.status).toBe(202);
  const queued = JobSchema.parse(created.body);
  const done = await terminal(queued.id);
  expect(done.status, JSON.stringify(done)).toBe('succeeded');
  return { created, queued, done };
}
const boundary = 'alfred-http-fixture-boundary';
function multipart(
  bytes: Buffer,
  filename = 'image.png',
  mime = 'image/png',
  extraFile = false,
) {
  const part = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    bytes,
    Buffer.from('\r\n'),
  ]);
  return Buffer.concat([
    part,
    ...(extraFile ? [part] : []),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}
async function upload(
  bytes: Buffer,
  key = randomUUID(),
  filename = 'image.png',
  mime = 'image/png',
  extraFile = false,
) {
  return call(running, '/api/v1/media/sources', {
    method: 'POST',
    raw: multipart(bytes, filename, mime, extraFile),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'idempotency-key': key,
    },
  });
}
describe('API-01：jobs/media/recovery完整HTTP工作流程', () => {
  it('真HTTP失敗job重啟後取安全retry-input，再用retryOf與最新版本建立成功工作', async () => {
    await running.service.close();
    running = await start(root, {
      buildExecution: {
        prepare: async () => undefined,
        render: async () => {
          throw new RepositoryError(
            'FIXTURE_RENDER_FAILED',
            '合成建置失敗。',
            422,
          );
        },
      },
    });
    const created = await call(running, '/api/v1/build-jobs', {
      method: 'POST',
      body: {},
      headers: { 'idempotency-key': randomUUID() },
    });
    const first = JobSchema.parse(created.body);
    expect((await terminal(first.id)).status).toBe('failed');
    await running.service.close();
    running = await start(root);
    const retry = await call(running, `/api/v1/jobs/${first.id}/retry-input`);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ type: 'build' });
    const next = await call(running, '/api/v1/build-jobs', {
      method: 'POST',
      body: { retryOf: first.id },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(next.status).toBe(202);
    expect((await terminal(JobSchema.parse(next.body).id)).status).toBe(
      'succeeded',
    );
    expect(
      (
        await call(
          running,
          `/api/v1/jobs/${JobSchema.parse(next.body).id}/retry-input`,
        )
      ).status,
    ).toBe(409);
  });
  it('build POST202→真coordinator/artifact proof，operation安全摘要及原queued快照重送', async () => {
    const key = randomUUID();
    const created = await call(running, '/api/v1/build-jobs', {
      method: 'POST',
      body: {},
      headers: { 'idempotency-key': key },
    });
    expect(created.status).toBe(202);
    const queued = JobSchema.parse(created.body);
    const done = await terminal(queued.id);
    expect(done.status, JSON.stringify(done)).toBe('succeeded');
    expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toContain(
      'HTTP build transport fixture',
    );
    const replay = await call(running, '/api/v1/build-jobs', {
      method: 'POST',
      body: {},
      headers: { 'idempotency-key': key },
    });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(created.body);
    const names = await readdir(join(root, '.alfred/operations'));
    const name = names.find((name) => name.endsWith(`--${key}.json`));
    if (!name) throw new Error('operation fixture missing');
    const operationId = name.split('--')[0];
    const summary = await call(running, `/api/v1/operations/${operationId}`);
    expect(OperationSchema.parse(summary.body)).toMatchObject({
      status: 'committed',
      httpStatus: 202,
      jobUrl: `/api/v1/jobs/${queued.id}`,
    });
    expect(summary.bytes.toString()).not.toContain('payloadHash');
    const cancellation = await call(
      running,
      `/api/v1/jobs/${queued.id}/cancellation`,
      { method: 'PUT', body: { requested: true } },
    );
    expect(cancellation.status).toBe(409);
    const list = await call(
      running,
      '/api/v1/jobs?type=build&status=succeeded&pageSize=1',
    );
    expect(list.body).toMatchObject({ total: 1, pageSize: 1 });
  });
  it('20 queued+running硬上限429/Retry-After，取消冪等並等待真正native close，停機無孤兒', async () => {
    await running.service.close();
    let releaseNative: () => void = () => undefined;
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    running = await start(root, {
      buildExecution: {
        prepare: async () => undefined,
        render: async (context) => {
          // Hold the worker before its bounded native process starts. Queue
          // capacity must not depend on filling 20 jobs within that deadline.
          await nativeGate;
          await runControlledProcess({
            command: process.execPath,
            args: [
              '--eval',
              'process.stdout.write(String(process.pid)+"\\n");setInterval(()=>{},1000);process.stdin.resume();',
            ],
            cwd: context.snapshotRoot,
            signal: context.signal,
            timeoutMs: 30_000,
            passFds: [context.leaseFd],
            keepStdinOpen: true,
            onOutput: (stream, chunk) => {
              if (stream === 'stdout') {
                const pid = Number(chunk.toString().trim());
                if (Number.isSafeInteger(pid) && pid > 0) nativePids.add(pid);
              }
            },
          });
        },
      },
    });
    try {
      const ids: string[] = [];
      for (let index = 0; index < 20; index++) {
        const result = await call(running, '/api/v1/build-jobs', {
          method: 'POST',
          body: {},
          headers: { 'idempotency-key': randomUUID() },
        });
        expect(result.status, JSON.stringify(result.body)).toBe(202);
        ids.push(JobSchema.parse(result.body).id);
      }
      const full = await call(running, '/api/v1/build-jobs', {
        method: 'POST',
        body: {},
        headers: { 'idempotency-key': randomUUID() },
      });
      expect(full.status).toBe(429);
      expect(full.headers['retry-after']).toBe('1');
      releaseNative();
      await waitFor(
        async () => nativePids.size,
        (count) => count > 0,
      );
      const last = ids.at(-1);
      if (!last) throw new Error('queued id missing');
      const cancellation = await call(
        running,
        `/api/v1/jobs/${last}/cancellation`,
        { method: 'PUT', body: { requested: true } },
      );
      expect(cancellation.status).toBe(202);
      expect(
        (
          await call(running, `/api/v1/jobs/${last}/cancellation`, {
            method: 'PUT',
            body: { requested: true },
          })
        ).status,
      ).toBe(200);
      await running.service.close();
      for (const pid of nativePids)
        expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      releaseNative();
    }
  });
  it('DELETE文章204→trash detail/If-Match→restore-trash真還原，再次resolution409', async () => {
    const before = await call(running, '/api/v1/articles/one');
    expect(
      (
        await call(running, '/api/v1/articles/one', {
          method: 'DELETE',
          headers: { 'if-match': String(before.headers.etag) },
        })
      ).status,
    ).toBe(204);
    expect((await call(running, '/api/v1/articles/one')).status).toBe(404);
    const list = await call(running, '/api/v1/recoveries?page=1&pageSize=1');
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    const body = list.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      !('items' in body) ||
      !Array.isArray(body.items)
    )
      throw new Error('recovery list missing');
    const summary = body.items[0] as { id: string };
    const detail = await call(running, `/api/v1/recoveries/${summary.id}`);
    const value = RecoveryDetailSchema.parse(detail.body);
    expect(value.kind).toBe('trash');
    expect(value.choices).toContain('restore-trash');
    const resolution = {
      choice: 'restore-trash',
      revisions: value.resources.map((resource) => ({
        resourceKey: resource.resourceKey,
        revision: resource.current.revision,
      })),
    };
    expect(
      (
        await call(running, `/api/v1/recoveries/${value.id}/resolution`, {
          method: 'PUT',
          body: resolution,
        })
      ).status,
    ).toBe(428);
    const restored = await call(
      running,
      `/api/v1/recoveries/${value.id}/resolution`,
      {
        method: 'PUT',
        body: resolution,
        headers: { 'if-match': String(detail.headers.etag) },
      },
    );
    expect(restored.status).toBe(200);
    expect(
      ArticleResourceSchema.parse(
        (await call(running, '/api/v1/articles/one')).body,
      ).contentHtml,
    ).toBe(article().contentHtml);
    expect(
      (
        await call(running, `/api/v1/recoveries/${value.id}/resolution`, {
          method: 'PUT',
          body: resolution,
          headers: { 'if-match': String(detail.headers.etag) },
        })
      ).status,
    ).toBe(409);
  });
  it('artifact recovery合併列表、安全附件/Range與unknown dist阻擋來源保存，workspace ETag隨表示改變', async () => {
    await build();
    const before = await call(running, '/api/v1/workspace');
    await writeFile(
      join(root, 'dist/external.html'),
      '<script>untrusted recovery attachment</script>',
    );
    const after = await call(running, '/api/v1/workspace');
    expect(WorkspaceSchema.parse(after.body).recoveryState).toBe(
      'recovery-required',
    );
    expect(after.headers.etag).not.toBe(before.headers.etag);
    const item = await call(running, '/api/v1/articles/one');
    expect(
      (
        await call(running, '/api/v1/articles/one', {
          method: 'PUT',
          body: article(),
          headers: { 'if-match': String(item.headers.etag) },
        })
      ).status,
    ).toBe(409);
    const list = await call(running, '/api/v1/recoveries');
    const data = list.body;
    if (
      typeof data !== 'object' ||
      data === null ||
      !('items' in data) ||
      !Array.isArray(data.items)
    )
      throw new Error('recovery summaries missing');
    const summary = data.items.find(
      (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        'kind' in value &&
        value.kind === 'build',
    ) as { id: string } | undefined;
    if (!summary) throw new Error('build recovery missing');
    const detail = await call(running, `/api/v1/recoveries/${summary.id}`);
    const value = RecoveryDetailSchema.parse(detail.body);
    expect(value.status).toBe('pending');
    const download = value.resources
      .flatMap((resource) => [
        resource.base,
        resource.current,
        resource.prepared,
        ...resource.preserved,
      ])
      .find((version) => version.binary !== null)?.binary;
    if (!download) throw new Error('attachment missing');
    const file = await call(running, download.downloadUrl, {
      headers: { range: 'bytes=0-4' },
    });
    expect(file.status).toBe(206);
    expect(file.bytes).toHaveLength(5);
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(file.headers['content-disposition']).toContain('attachment');
    const invalid = await call(running, download.downloadUrl, {
      headers: { range: 'bytes=999999999-' },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers['content-range']).toBe(
      `bytes */${download.byteSize}`,
    );
  });
  it('multipart真圖片來源→原201冪等→media job實轉WebP→預覽受控URL→引用衝突及Range', async () => {
    const bytes = await sharp({
      create: {
        width: 64,
        height: 32,
        channels: 3,
        background: { r: 10, g: 60, b: 130 },
      },
    })
      .png()
      .toBuffer();
    const key = randomUUID();
    const uploaded = await upload(bytes, key);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const source = MediaSourceResourceSchema.parse(uploaded.body);
    expect(uploaded.headers.location).toBe(
      `/api/v1/media/sources/${source.id}`,
    );
    const replay = await upload(bytes, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(uploaded.body);
    expect(await readdir(join(root, 'media/source'))).toEqual([source.id]);
    const created = await call(running, '/api/v1/media-jobs', {
      method: 'POST',
      body: { sourceId: source.id, preset: 'article-image' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(created.status).toBe(202);
    const job = await terminal(JobSchema.parse(created.body).id);
    expect(job.status, JSON.stringify(job)).toBe('succeeded');
    const image = await call(
      running,
      `/api/v1/media/files/${source.id}/image.webp`,
    );
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');
    const range = await call(
      running,
      `/api/v1/media/files/${source.id}/image.webp`,
      { headers: { range: 'bytes=1-5' } },
    );
    expect(range.status).toBe(206);
    expect(range.bytes).toEqual(image.bytes.subarray(1, 6));
    const payload = {
      ...article(),
      contentHtml: `<h2 id="image">圖片</h2><img src="/media/${source.id}/image.webp" alt="合成圖片">`,
    };
    const p = await call(running, '/api/v1/previews', {
      method: 'POST',
      body: payload,
      headers: { 'x-alfred-editor-id': randomUUID() },
    });
    expect(p.status).toBe(201);
    const preview = PreviewResponseSchema.parse(p.body);
    const doc = await call(running, preview.documentUrl);
    expect(doc.bytes.toString()).toContain(
      `/api/v1/media/files/${source.id}/image.webp`,
    );
    const articleBefore = await call(running, '/api/v1/articles/one');
    expect(
      (
        await call(running, '/api/v1/articles/one', {
          method: 'PUT',
          body: payload,
          headers: { 'if-match': String(articleBefore.headers.etag) },
        })
      ).status,
    ).toBe(200);
    const current = await call(running, `/api/v1/media/sources/${source.id}`);
    expect(
      (
        await call(running, `/api/v1/media/sources/${source.id}`, {
          method: 'DELETE',
          headers: { 'if-match': String(current.headers.etag) },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(running, `/api/v1/media/files/${source.id}/not-a-variant`))
        .status,
    ).toBe(404);
    expect(
      (
        await call(running, `/api/v1/media/files/${source.id}/image.webp`, {
          headers: { range: 'bytes=1-2,4-6' },
        })
      ).status,
    ).toBe(416);
  });
  it('錯誤multipart/雙file/副檔名偽造不註冊來源，media DTO/query錯誤422不變500', async () => {
    const bytes = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .png()
      .toBuffer();
    expect(
      (await upload(bytes, randomUUID(), 'image.jpg', 'image/jpeg')).status,
    ).toBe(422);
    expect(
      (await upload(bytes, randomUUID(), 'image.png', 'image/png', true))
        .status,
    ).toBe(413);
    expect(
      (
        await call(running, '/api/v1/media/sources', {
          method: 'POST',
          raw: '{}',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
        })
      ).status,
    ).toBe(415);
    expect(
      (await call(running, '/api/v1/media/sources?type=unknown')).status,
    ).toBe(422);
    expect(await readdir(join(root, 'media/source'))).toEqual([]);
    const source = MediaSourceResourceSchema.parse((await upload(bytes)).body);
    const bad = await call(running, `/api/v1/media/sources/${source.id}`, {
      method: 'PUT',
      body: { displayName: 'ok', root: '/tmp/forbidden' },
      headers: { 'if-match': '"' + 'a'.repeat(64) + '"' },
    });
    expect(bad.status).toBe(422);
  });
  it('真FFmpeg影音HTTP job、WebM Range與poster設定更新後結果失效', async () => {
    const sourceFile = join(root, '.alfred/video-fixture.webm');
    await runControlledProcess({
      command: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:size=64x48:rate=10',
        '-t',
        '0.3',
        '-c:v',
        'libvpx-vp9',
        '-threads',
        '1',
        '-an',
        '-y',
        sourceFile,
      ],
      cwd: root,
      timeoutMs: 20_000,
    });
    const uploaded = await upload(
      await readFile(sourceFile),
      randomUUID(),
      'clip.webm',
      'video/webm',
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const source = MediaSourceResourceSchema.parse(uploaded.body);
    const queued = await call(running, '/api/v1/media-jobs', {
      method: 'POST',
      body: { sourceId: source.id, preset: 'article-video' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(queued.status).toBe(202);
    const job = await terminal(JobSchema.parse(queued.body).id);
    expect(job.status, JSON.stringify(job)).toBe('succeeded');
    const full = await call(
      running,
      `/api/v1/media/files/${source.id}/video.webm`,
    );
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('video/webm');
    const suffix = await call(
      running,
      `/api/v1/media/files/${source.id}/video.webm`,
      { headers: { range: 'bytes=-8' } },
    );
    expect(suffix.status).toBe(206);
    expect(suffix.bytes).toEqual(full.bytes.subarray(-8));
    const poster = await call(
      running,
      `/api/v1/media/files/${source.id}/poster.webp`,
    );
    expect(poster.status).toBe(200);
    const before = await call(running, `/api/v1/media/sources/${source.id}`);
    const updated = await call(running, `/api/v1/media/sources/${source.id}`, {
      method: 'PUT',
      body: { displayName: '新的片名', posterTimeSeconds: 0 },
      headers: { 'if-match': String(before.headers.etag) },
    });
    expect(updated.status).toBe(200);
    expect(MediaSourceResourceSchema.parse(updated.body)).toMatchObject({
      displayName: '新的片名',
      posterTimeSeconds: 0,
      asset: null,
    });
    expect(
      (await call(running, `/api/v1/media/files/${source.id}/video.webm`))
        .status,
    ).toBe(404);
  });
  it('無引用媒體刪除204、二進位trash附件206及還原保留原始bytes', async () => {
    const bytes = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 4, g: 5, b: 6 },
      },
    })
      .png()
      .toBuffer();
    const uploaded = await upload(bytes);
    const source = MediaSourceResourceSchema.parse(uploaded.body);
    const list = await call(
      running,
      '/api/v1/media/sources?type=image&pageSize=1',
    );
    expect(list.body).toMatchObject({ total: 1, pageSize: 1 });
    expect(
      (
        await call(running, `/api/v1/media/sources/${source.id}`, {
          method: 'DELETE',
          headers: { 'if-match': String(uploaded.headers.etag) },
        })
      ).status,
    ).toBe(204);
    const summaries = (await call(running, '/api/v1/recoveries')).body;
    if (
      typeof summaries !== 'object' ||
      summaries === null ||
      !('items' in summaries) ||
      !Array.isArray(summaries.items)
    )
      throw new Error('recovery list missing');
    const summary = summaries.items.find(
      (row: unknown) =>
        typeof row === 'object' &&
        row !== null &&
        'kind' in row &&
        row.kind === 'trash',
    ) as { id: string } | undefined;
    if (!summary) throw new Error('trash missing');
    const response = await call(running, `/api/v1/recoveries/${summary.id}`);
    const detail = RecoveryDetailSchema.parse(response.body);
    const binary = detail.resources.find(
      (resource) => resource.base.binary !== null,
    )?.base.binary;
    if (!binary) throw new Error('binary missing');
    const download = await call(running, binary.downloadUrl, {
      headers: { range: 'bytes=2-8' },
    });
    expect(download.status).toBe(206);
    expect(download.bytes).toEqual(bytes.subarray(2, 9));
    expect(download.headers['content-disposition']).toContain('attachment');
    const restore = await call(
      running,
      `/api/v1/recoveries/${detail.id}/resolution`,
      {
        method: 'PUT',
        body: {
          choice: 'restore-trash',
          revisions: detail.resources.map((resource) => ({
            resourceKey: resource.resourceKey,
            revision: resource.current.revision,
          })),
        },
        headers: { 'if-match': String(response.headers.etag) },
      },
    );
    expect(restore.status).toBe(200);
    expect(
      await readFile(join(root, 'media/source', source.id, 'original.png')),
    ).toEqual(bytes);
  });
});
