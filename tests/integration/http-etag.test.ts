import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  ArticleResourceSchema,
  JobSchema,
  MediaSourceResourceSchema,
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
import { createLocalRuntime } from '../../server/src/runtime/services.js';
import { FileRepository } from '../../server/src/files/index.js';
import { representationEtag } from '../../server/src/files/io.js';
import { ContentService } from '../../server/src/content/index.js';
import { fixedPages } from '@foliohaven/site/registry';
import { scanBuildInputs } from '../../server/src/build/inputs.js';
import { OperationStore } from '../../server/src/operations/index.js';
import {
  MediaService,
  acquireMediaSlot,
} from '../../server/src/media/index.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
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
describe('API-01：衍生表示strong ETag與內部raw CAS', () => {
  it('taxonomy改動diagnostics即改Article ETag，舊PUT/PATCH/DELETE全412帶最新etag且不改文章', async () => {
    const before = await call(running, '/api/v1/articles/one');
    const html = await readFile(
      join(root, 'content/articles/one/content.html'),
    );
    const metadata = await readFile(
      join(root, 'content/articles/one/meta.json'),
    );
    await writeFile(
      join(root, 'content/categories.json'),
      JSON.stringify([{ path: 'tools', name: '工具', description: '工具' }]),
    );
    const latest = await call(running, '/api/v1/articles/one');
    expect(latest.status).toBe(200);
    expect(latest.headers.etag).not.toBe(before.headers.etag);
    expect(
      ArticleResourceSchema.parse(latest.body).diagnostics.some(
        (issue) => issue.code === 'UNKNOWN_CATEGORY',
      ),
    ).toBe(true);
    for (const [method, path, body] of [
      ['PUT', '/api/v1/articles/one', article()],
      [
        'PATCH',
        '/api/v1/articles/one/publication',
        { status: 'draft', publishedAt: null, updatedAt: null },
      ],
      ['DELETE', '/api/v1/articles/one', undefined],
    ] as const) {
      const response = await call(running, path, {
        method,
        ...(body === undefined ? {} : { body }),
        headers: { 'if-match': String(before.headers.etag) },
      });
      expect(response.status).toBe(412);
      expect(response.headers.etag).toBe(latest.headers.etag);
    }
    expect(
      await readFile(join(root, 'content/articles/one/content.html')),
    ).toEqual(html);
    expect(
      await readFile(join(root, 'content/articles/one/meta.json')),
    ).toEqual(metadata);
  });
  it('Article201/GET使用同一canonical bytes與etag，後續diagnostics更新不改寫原201 replay', async () => {
    const key = randomUUID();
    const created = await call(running, '/api/v1/articles', {
      method: 'POST',
      body: article(),
      headers: { 'idempotency-key': key },
    });
    expect(created.status).toBe(201);
    const value = ArticleResourceSchema.parse(created.body);
    const first = await call(running, `/api/v1/articles/${value.id}`);
    expect(first.headers.etag).toBe(created.headers.etag);
    expect(first.bytes).toEqual(created.bytes);
    await writeFile(
      join(root, 'content/categories.json'),
      JSON.stringify([{ path: 'tools', name: '工具', description: '工具' }]),
    );
    const changed = await call(running, `/api/v1/articles/${value.id}`);
    expect(changed.headers.etag).not.toBe(created.headers.etag);
    const replay = await call(running, '/api/v1/articles', {
      method: 'POST',
      body: article(),
      headers: { 'idempotency-key': key },
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.etag).toBe(created.headers.etag);
    expect(replay.bytes).toEqual(created.bytes);
  });
  it('asset null→完成改Media ETag，舊更新/刪除412，inputRevision與queued工作不受asset影響', async () => {
    await running.service.close();
    const runtime = await createLocalRuntime({ repositoryRoot: root });
    try {
      const bytes = await sharp({
        create: {
          width: 32,
          height: 16,
          channels: 3,
          background: { r: 4, g: 6, b: 8 },
        },
      })
        .png()
        .toBuffer();
      const staged = await runtime.media.stageSource(Readable.from([bytes]), {
        filename: 'image.png',
        mimeType: 'image/png',
      });
      const source = await runtime.media.register(staged);
      expect(source.value.asset).toBeNull();
      const first = await runtime.jobs.create({
        type: 'media',
        payload: { sourceId: source.value.id, preset: 'article-image' },
        sourceRevision: source.inputRevision,
      });
      const second = await runtime.jobs.create({
        type: 'media',
        payload: { sourceId: source.value.id, preset: 'article-image' },
        sourceRevision: source.inputRevision,
      });
      expect((await runtime.jobs.runJob(first.id))?.status).toBe('succeeded');
      const processed = await runtime.media.get(source.value.id);
      expect(processed.value.asset).not.toBeNull();
      expect(processed.etag).not.toBe(source.etag);
      expect(processed.inputRevision).toBe(source.inputRevision);
      expect((await runtime.jobs.runJob(second.id))?.status).toBe('succeeded');
      await expect(
        runtime.media.update(
          source.value.id,
          { displayName: 'stale' },
          source.etag,
        ),
      ).rejects.toMatchObject({ status: 412, etag: processed.etag });
      await expect(
        runtime.media.update(
          source.value.id,
          { displayName: 'stale and invalid', posterTimeSeconds: 999 },
          source.etag,
        ),
      ).rejects.toMatchObject({ status: 412, etag: processed.etag });
      await expect(
        runtime.media.remove(source.value.id, source.etag),
      ).rejects.toMatchObject({ status: 412, etag: processed.etag });
      expect(
        await readFile(
          join(root, 'media/source', source.value.id, 'original.png'),
        ),
      ).toEqual(bytes);
    } finally {
      await runtime.close();
    }
  });
  it('HTTP Media201/GET bytes一致，完成後etag變動而同key仍重送原始201', async () => {
    const bytes = await sharp({
      create: {
        width: 16,
        height: 8,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer();
    const key = randomUUID();
    const boundary = 'alfred-etag-upload';
    const raw = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = () =>
      call(running, '/api/v1/media/sources', {
        method: 'POST',
        raw,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'idempotency-key': key,
        },
      });
    const created = await upload();
    expect(created.status).toBe(201);
    const source = MediaSourceResourceSchema.parse(created.body);
    const initial = await call(running, `/api/v1/media/sources/${source.id}`);
    expect(initial.headers.etag).toBe(created.headers.etag);
    expect(initial.bytes).toEqual(created.bytes);
    const job = JobSchema.parse(
      (
        await call(running, '/api/v1/media-jobs', {
          method: 'POST',
          body: { sourceId: source.id, preset: 'article-image' },
          headers: { 'idempotency-key': randomUUID() },
        })
      ).body,
    );
    const done = await waitFor(
      () => call(running, `/api/v1/jobs/${job.id}`),
      (value) =>
        !['queued', 'running'].includes(JobSchema.parse(value.body).status),
    );
    expect(JobSchema.parse(done.body).status).toBe('succeeded');
    const latest = await call(running, `/api/v1/media/sources/${source.id}`);
    expect(latest.headers.etag).not.toBe(created.headers.etag);
    expect(latest.bytes.toString()).not.toContain('inputRevision');
    const stale = await call(running, `/api/v1/media/sources/${source.id}`, {
      method: 'PUT',
      body: { displayName: 'stale' },
      headers: { 'if-match': String(created.headers.etag) },
    });
    expect(stale.status).toBe(412);
    expect(stale.headers.etag).toBe(latest.headers.etag);
    const replay = await upload();
    expect(replay.status).toBe(201);
    expect(replay.headers.etag).toBe(created.headers.etag);
    expect(replay.bytes).toEqual(created.bytes);
  });
  it('representation callback讀取的跨來源在prepared階段被IDE修改仍攔下，不誤裝候選', async () => {
    await running.service.close();
    let changed = false;
    const repository = new FileRepository({
      repositoryRoot: root,
      fault: async (event) => {
        if (event.phase === 'prepared-journal' && !changed) {
          changed = true;
          await writeFile(join(root, 'content/categories.json'), '[]');
        }
      },
    });
    const key = 'content/articles/one/content.html';
    const old = await repository.withConsistentRead(async (session) => ({
      raw: await session.read(key),
      etag: await session.etag([key]),
      taxonomy: await session.read('content/categories.json'),
    }));
    if (!old.raw || !old.taxonomy) throw new Error('fixture sources missing');
    const current = representationEtag(old.etag, {
      taxonomy: old.taxonomy.revision,
    });
    await expect(
      repository.commit({
        kind: 'save',
        changes: [
          {
            resourceKey: key,
            expectedRevision: old.raw.revision,
            content: Buffer.from('<p>stale candidate</p>'),
          },
        ],
        precondition: {
          ifMatch: current,
          resourceKeys: [key],
          representationEtag: async (session, raw) =>
            representationEtag(raw, {
              taxonomy: (await session.read('content/categories.json'))
                ?.revision,
            }),
        },
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    expect(await readFile(join(root, key))).toEqual(old.raw.bytes);
  });
  it('cold inspection在writer外等待media pool，持slot者仍可取得writer而不形成反向死鎖', async () => {
    await running.service.close();
    const runtime = await createLocalRuntime({ repositoryRoot: root });
    let observed: () => void = () => undefined;
    const missing = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const media = new MediaService({
      repositoryRoot: root,
      repository: runtime.repository,
      onPhase: (phase) => {
        if (phase === 'inspection-required') observed();
      },
    });
    const bytes = await sharp({
      create: {
        width: 16,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .png()
      .toBuffer();
    const source = await media.register(
      await media.stageSource(Readable.from([bytes]), {
        filename: 'image.png',
        mimeType: 'image/png',
      }),
    );
    await rm(
      join(root, '.foliohaven/media-inspections', `${source.value.id}.json`),
    );
    const first = await acquireMediaSlot(root, 'image', 10_000);
    const second = await acquireMediaSlot(root, 'image', 10_000);
    let reading: Promise<unknown> | undefined;
    let writer: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      reading = media.get(source.value.id);
      await missing;
      writer = runtime.repository.withConsistentRead(async () => true);
      const won = await Promise.race([
        writer.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2_000);
        }),
      ]);
      expect(won).toBe(true);
    } finally {
      clearTimeout(timer);
      await first.release();
      await second.release();
      await reading;
      await writer;
      await runtime.close();
    }
  });
  it('article create在committed後被IDE修改仍回當次保存DTO/ETag與原201 receipt', async () => {
    await running.service.close();
    let changed = false;
    const repository = new FileRepository({
      repositoryRoot: root,
      fault: async (event) => {
        if (event.phase === 'committed-journal' && !changed) {
          changed = true;
          const id = (await readdir(join(root, 'content/articles'))).find(
            (id) => id.startsWith('article-'),
          );
          if (!id) throw new Error('created fixture missing');
          await writeFile(
            join(root, 'content/articles', id, 'content.html'),
            '<p>IDE later version</p>',
          );
        }
      },
    });
    const operations = new OperationStore({ repositoryRoot: root, repository });
    try {
      const service = new ContentService({
        repository,
        fixedPages,
        scanInputs: async () => (await scanBuildInputs(root)).revision,
      });
      const input = {
        key: randomUUID(),
        kind: 'article-create',
        payload: article(),
      };
      const reserved = await operations.reserve(input);
      if (reserved.status !== 'reserved')
        throw new Error('reservation missing');
      const saved = await service.createArticle(article(), {
        operation: operations.receipt(reserved.reservation, {
          httpStatus: 201,
        }),
      });
      expect(saved.value.contentHtml).toBe(article().contentHtml);
      const current = await service.getArticle(saved.value.id);
      expect(current.value.contentHtml).toBe('<p>IDE later version</p>');
      expect(current.etag).not.toBe(saved.etag);
      const receipt = (await repository.listCommittedOperations())[0];
      expect(receipt?.headers?.ETag).toBe(saved.etag);
      expect(receipt?.response).toEqual(saved.value);
      await operations.initialize();
      const replay = await operations.reserve(input);
      expect(replay.status).toBe('replay');
      if (replay.status === 'replay') {
        expect(replay.response.headers?.ETag).toBe(saved.etag);
        expect(replay.response.response).toEqual(saved.value);
      }
    } finally {
      await operations.close();
    }
  });
  it('media update在committed後遭IDE改metadata仍回候選snapshot，不以晚get取代成功結果', async () => {
    await running.service.close();
    let id = '';
    let active = false;
    const repository = new FileRepository({
      repositoryRoot: root,
      fault: async (event) => {
        if (event.phase === 'committed-journal' && active) {
          active = false;
          const key = join(root, 'media/source', id, 'meta.json');
          const value = JSON.parse(await readFile(key, 'utf8')) as Record<
            string,
            unknown
          >;
          await writeFile(
            key,
            JSON.stringify({ ...value, displayName: 'IDE later metadata' }),
          );
        }
      },
    });
    const media = new MediaService({ repositoryRoot: root, repository });
    const bytes = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 1, g: 3, b: 5 },
      },
    })
      .png()
      .toBuffer();
    const source = await media.register(
      await media.stageSource(Readable.from([bytes]), {
        filename: 'image.png',
        mimeType: 'image/png',
      }),
    );
    id = source.value.id;
    active = true;
    const saved = await media.update(
      id,
      { displayName: 'Saved candidate' },
      source.etag,
    );
    expect(saved.value.displayName).toBe('Saved candidate');
    const current = await media.get(id);
    expect(current.value.displayName).toBe('IDE later metadata');
    expect(current.etag).not.toBe(saved.etag);
    expect(current.inputRevision).not.toBe(saved.inputRevision);
  });
  it('inspection disk cache不可寫時仍用當次受版本約束的檢查結果回GET與保存snapshot', async () => {
    await running.service.close();
    const runtime = await createLocalRuntime({ repositoryRoot: root });
    const directory = join(root, '.foliohaven/media-inspections');
    try {
      const bytes = await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: 6, g: 8, b: 10 },
        },
      })
        .png()
        .toBuffer();
      const source = await runtime.media.register(
        await runtime.media.stageSource(Readable.from([bytes]), {
          filename: 'image.png',
          mimeType: 'image/png',
        }),
      );
      await rm(join(directory, `${source.value.id}.json`));
      await chmod(directory, 0o500);
      const loaded = await runtime.media.get(source.value.id);
      expect(loaded.etag).toBe(source.etag);
      expect(loaded.inputRevision).toBe(source.inputRevision);
      const saved = await runtime.media.update(
        source.value.id,
        { displayName: 'Without optional cache' },
        loaded.etag,
      );
      expect(saved.value.displayName).toBe('Without optional cache');
      expect((await runtime.media.get(source.value.id)).etag).toBe(saved.etag);
    } finally {
      await chmod(directory, 0o700);
      await runtime.close();
    }
  });
});
