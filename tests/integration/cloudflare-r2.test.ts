import assert from 'node:assert/strict';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { createR2, multipartSizing } from '../../scripts/cloudflare/r2.mjs';
import type { R2Context, R2File } from '../../scripts/cloudflare/r2.mjs';

function required<T>(value: T | undefined | null): T {
  assert(value !== undefined && value !== null);
  return value;
}

const MIB = 1024 ** 2;
const CACHE = 'public, max-age=0, must-revalidate';
const credentials = {
  R2_ACCESS_KEY_ID: 'fixture-access-key',
  R2_SECRET_ACCESS_KEY: 'fixture-secret-key',
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Stored {
  path: string;
  byteSize: number;
  etag: string;
  headers: Record<string, string>;
}
interface Upload {
  key: string;
  headers: Record<string, string>;
  parts: Map<number, Stored>;
}
const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;');
function sendError(response: ServerResponse, status: number, code: string) {
  response.writeHead(status, { 'content-type': 'application/xml' });
  response.end(
    `<Error><Code>${code}</Code><Message>Fixture rejection</Message></Error>`,
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-r2-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'source'));
  await mkdir(join(root, 'remote'));
  const objects = new Map<string, Stored>();
  const uploads = new Map<string, Upload>();
  const events: string[] = [];
  const controls: {
    failBackup?: string;
    losePut?: string;
    latePut?: string;
    failPart?: number;
    failCreate?: boolean;
    failComplete?: boolean;
    loseComplete?: boolean;
    stallGet?: string;
    failHeadAfterWrite?: string;
    weakGet?: boolean;
    releaseLate?: () => Promise<void>;
  } = {};
  async function saveBody(
    body: AsyncIterable<Uint8Array>,
    headers: Record<string, string> = {},
  ) {
    const path = join(root, 'remote', randomUUID());
    const handle = await open(path, 'wx', 0o600);
    const digest = createHash('md5');
    let byteSize = 0;
    try {
      for await (const bytes of body) {
        digest.update(bytes);
        byteSize += bytes.length;
        await handle.writeFile(bytes);
      }
    } finally {
      await handle.close();
    }
    return { path, byteSize, etag: `"${digest.digest('hex')}"`, headers };
  }
  async function seed(
    key: string,
    bytes: Buffer | string,
    headers: Record<string, string> = {},
  ) {
    const stored = await saveBody(Readable.from([Buffer.from(bytes)]), {
      'content-type': 'text/plain',
      ...headers,
    });
    objects.set(key, stored);
    return stored;
  }
  function incomingHeaders(request: IncomingMessage) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers))
      if (
        value !== undefined &&
        (key.startsWith('x-amz-meta-') ||
          [
            'content-type',
            'cache-control',
            'content-disposition',
            'content-encoding',
            'content-language',
            'expires',
          ].includes(key))
      )
        headers[key] = String(value);
    return headers;
  }
  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/u, ''));
    const uploadId = url.searchParams.get('uploadId');
    const partNumber = Number(url.searchParams.get('partNumber'));
    events.push(
      `${request.method} ${key}${uploadId ? ' upload' : ''}${partNumber ? ` part-${partNumber}` : ''}`,
    );
    if (!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 '))
      return sendError(response, 403, 'AccessDenied');
    if (request.method === 'HEAD' && !key) {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      if (controls.failCreate) return sendError(response, 403, 'AccessDenied');
      const id = randomUUID();
      uploads.set(id, {
        key,
        headers: incomingHeaders(request),
        parts: new Map(),
      });
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(
        `<InitiateMultipartUploadResult><Bucket>bucket</Bucket><Key>${xml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
      return;
    }
    if (uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload) return sendError(response, 404, 'NoSuchUpload');
      if (request.method === 'DELETE') {
        uploads.delete(uploadId);
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'PUT') {
        if (partNumber === controls.failPart)
          return sendError(response, 503, 'ServiceUnavailable');
        const stored = await saveBody(request);
        upload.parts.set(partNumber, stored);
        response.writeHead(200, { etag: stored.etag });
        response.end();
        return;
      }
      if (request.method === 'POST') {
        if (controls.failComplete)
          return sendError(response, 503, 'ServiceUnavailable');
        const chunks: Buffer[] = [];
        for await (const part of request) chunks.push(Buffer.from(part));
        const wanted = Buffer.concat(chunks).toString();
        const numbers = [
          ...wanted.matchAll(/<PartNumber>(\d+)<\/PartNumber>/gu),
        ].map((match) => Number(match[1]));
        if (numbers.length !== upload.parts.size)
          return sendError(response, 400, 'InvalidPart');
        async function* parts() {
          for (const number of numbers)
            for await (const bytes of createReadStream(
              required(required(upload).parts.get(number)).path,
            ))
              yield bytes as Buffer;
        }
        const stored = await saveBody(parts(), upload.headers);
        stored.etag = `"${stored.etag.slice(1, -1)}-${numbers.length}"`;
        objects.set(key, stored);
        uploads.delete(uploadId);
        if (controls.loseComplete) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/xml' });
        response.end(
          `<CompleteMultipartUploadResult><Bucket>bucket</Bucket><Key>${xml(key)}</Key><ETag>${xml(stored.etag)}</ETag></CompleteMultipartUploadResult>`,
        );
        return;
      }
    }
    const object = objects.get(key);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (!object) return sendError(response, 404, 'NoSuchKey');
      if (request.method === 'HEAD' && controls.failHeadAfterWrite === key)
        return sendError(response, 503, 'ServiceUnavailable');
      if (
        request.headers['if-match'] &&
        request.headers['if-match'] !== object.etag
      )
        return sendError(response, 412, 'PreconditionFailed');
      if (request.method === 'GET' && controls.failBackup === key)
        return sendError(response, 503, 'ServiceUnavailable');
      response.writeHead(200, {
        ...object.headers,
        etag:
          request.method === 'GET' && controls.weakGet
            ? `W/${object.etag}`
            : object.etag,
        'content-length': object.byteSize,
      });
      if (request.method === 'GET' && controls.stallGet === key) {
        response.flushHeaders();
        return;
      }
      if (request.method === 'HEAD') response.end();
      else createReadStream(object.path).pipe(response);
      return;
    }
    if (request.method === 'PUT') {
      if (
        (request.headers['if-none-match'] === '*' && object) ||
        (request.headers['if-match'] &&
          request.headers['if-match'] !== object?.etag)
      )
        return sendError(response, 412, 'PreconditionFailed');
      const stored = await saveBody(request, incomingHeaders(request));
      if (
        request.headers['content-md5'] !==
        Buffer.from(stored.etag.slice(1, -1), 'hex').toString('base64')
      )
        return sendError(response, 400, 'BadDigest');
      if (controls.latePut === key) {
        controls.releaseLate = async () => {
          objects.set(key, stored);
        };
        request.socket.destroy();
        return;
      }
      objects.set(key, stored);
      if (controls.losePut === key) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { etag: stored.etag });
      response.end();
      return;
    }
    sendError(response, 400, 'InvalidRequest');
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.destroyed) sendError(response, 500, 'InternalError');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fixture listen failed');
  const client = new S3Client({
    region: 'auto',
    endpoint: `http://127.0.0.1:${address.port}`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: credentials.R2_ACCESS_KEY_ID,
      secretAccessKey: credentials.R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  cleanups.push(async () => {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const adapter = createR2({
    config: { accountId: 'a'.repeat(32), bucketName: 'bucket' },
    credentials,
    client,
    retryDelayMs: 1,
  });
  const saved: string[] = [];
  const context: R2Context = {
    root,
    manifest: [],
    deploymentId: randomUUID(),
    journal: {},
    save: async () => {
      saved.push(JSON.stringify(context.journal));
    },
  };
  async function source(
    key: string,
    bytes: Buffer | string,
    mime = 'text/plain',
  ): Promise<R2File> {
    await mkdir(dirname(join(root, 'source', key)), { recursive: true });
    await writeFile(join(root, 'source', key), bytes);
    const file: R2File = {
      path: key,
      byteSize: Buffer.byteLength(bytes),
      sha256: hash(bytes),
      mime,
      target: 'r2',
    };
    context.manifest.push(file);
    return file;
  }
  return {
    root,
    source,
    seed,
    objects,
    uploads,
    events,
    controls,
    adapter,
    context,
    saved,
    client,
  };
}

async function bulkSource(
  f: Awaited<ReturnType<typeof fixture>>,
  key: string,
  mebibytes = 65,
) {
  await mkdir(dirname(join(f.root, 'source', key)), { recursive: true });
  const handle = await open(join(f.root, 'source', key), 'wx');
  const chunk = Buffer.alloc(MIB, 0x22);
  const digest = createHash('sha256');
  try {
    for (let index = 0; index < mebibytes; index++) {
      digest.update(chunk);
      await handle.writeFile(chunk);
    }
  } finally {
    await handle.close();
  }
  f.context.manifest.push({
    path: key,
    byteSize: mebibytes * MIB,
    sha256: digest.digest('hex'),
    mime: 'video/webm',
    target: 'r2',
  });
}

describe('Cloudflare R2 S3 protocol and recovery', () => {
  it('backs up every overwrite before any write, uploads with metadata, then restores original bytes and metadata', async () => {
    const f = await fixture();
    await f.seed('media/a.txt', 'old A', {
      'content-disposition': 'inline',
      'x-amz-meta-author': 'fixture',
    });
    await f.seed('media/b.txt', 'old B');
    await f.source('media/a.txt', 'new A');
    await f.source('media/b.txt', 'new B');
    await f.source('assets/new.css', 'body{}', 'text/css');
    await f.adapter.checkBucket();
    await f.adapter.prepare(f.context);
    expect(f.events.some((event) => event.startsWith('PUT'))).toBe(false);
    expect(await readFile(join(f.root, 'backups/r2/media/a.txt'), 'utf8')).toBe(
      'old A',
    );
    expect(
      (await lstat(join(f.root, 'backups/r2/media/a.txt'))).mode & 0o777,
    ).toBe(0o600);
    await f.adapter.upload(f.context);
    expect((await f.adapter.status(f.context)).complete).toBe(true);
    expect(f.objects.get('media/a.txt')?.headers['cache-control']).toBe(CACHE);
    expect(
      f.objects.get('media/a.txt')?.headers['x-amz-meta-alfred-sha256'],
    ).toBe(hash('new A'));
    expect(f.saved.some((saved) => saved.includes('"status":"intent"'))).toBe(
      true,
    );
    await f.adapter.preflightRestore(f.context);
    await f.adapter.restore(f.context);
    await f.adapter.restore(f.context);
    expect(
      await readFile(required(f.objects.get('media/a.txt')).path, 'utf8'),
    ).toBe('old A');
    expect(f.objects.get('media/a.txt')?.headers['x-amz-meta-author']).toBe(
      'fixture',
    );
    expect(f.objects.has('assets/new.css')).toBe(true);
    expect(f.context.journal.r2?.records[2]?.restore?.status).toBe(
      'retained-new',
    );
  });

  it('skips identical managed bytes but overwrites metadata-only differences', async () => {
    const f = await fixture();
    const oldDeployment = randomUUID();
    const headers = {
      'content-type': 'text/plain',
      'cache-control': CACHE,
      'x-amz-meta-alfred-sha256': hash('same'),
      'x-amz-meta-alfred-byte-size': '4',
      'x-amz-meta-alfred-deployment-id': oldDeployment,
    };
    await f.seed('media/a.txt', 'same', headers);
    await f.seed('media/b.txt', 'same', {
      ...headers,
      'cache-control': 'public, max-age=31536000',
    });
    await f.source('media/a.txt', 'same');
    await f.source('media/b.txt', 'same');
    const records = await f.adapter.prepare(f.context);
    expect(records.map((record) => record.action)).toEqual([
      'skip',
      'overwrite',
    ]);
    await f.adapter.upload(f.context);
    expect(f.events.filter((event) => event.startsWith('PUT'))).toEqual([
      'PUT media/b.txt',
    ]);
  });

  it('refuses all writes when any old media backup fails', async () => {
    const f = await fixture();
    await f.seed('media/a.txt', 'old');
    await f.seed('media/b.txt', 'old');
    await f.source('media/a.txt', 'new');
    await f.source('media/b.txt', 'new');
    f.controls.failBackup = 'media/b.txt';
    await expect(f.adapter.prepare(f.context)).rejects.toBeDefined();
    expect(
      f.events.some(
        (event) => event.startsWith('PUT') || event.startsWith('POST'),
      ),
    ).toBe(false);
    expect(f.context.journal.r2?.prepared).toBe(false);
  });

  it('uses HEAD strong ETag even when GET returns a weak transport ETag', async () => {
    const f = await fixture();
    f.controls.weakGet = true;
    await f.seed('media/a.txt', 'old');
    await f.source('media/a.txt', 'new');
    await f.adapter.prepare(f.context);
    await f.adapter.upload(f.context);
    expect(
      await readFile(required(f.objects.get('media/a.txt')).path, 'utf8'),
    ).toBe('new');
  });

  it('reconciles a successful PUT whose response was lost without retrying the write', async () => {
    const f = await fixture();
    f.controls.losePut = 'media/a.txt';
    await f.source('media/a.txt', 'new');
    await f.adapter.prepare(f.context);
    await f.adapter.upload(f.context);
    expect(
      f.events.filter((event) => event === 'PUT media/a.txt'),
    ).toHaveLength(1);
    expect(f.context.journal.r2?.records[0]?.status).toBe('uploaded');
  });

  it('keeps a negative read after an in-flight PUT unknown, then status observes the late commit', async () => {
    const f = await fixture();
    f.controls.latePut = 'media/a.txt';
    await f.source('media/a.txt', 'new');
    await f.adapter.prepare(f.context);
    await expect(f.adapter.upload(f.context)).rejects.toMatchObject({
      code: 'R2_RESULT_UNKNOWN',
      unknown: true,
    });
    expect((await f.adapter.status(f.context)).unknown).toBe(true);
    await expect(f.adapter.preflightRestore(f.context)).rejects.toMatchObject({
      unknown: true,
    });
    expect(
      f.events.filter((event) => event === 'PUT media/a.txt'),
    ).toHaveLength(1);
    await f.controls.releaseLate?.();
    expect((await f.adapter.status(f.context)).complete).toBe(true);
  });

  it('rejects an entire restore batch before writing when a later key has external metadata drift', async () => {
    const f = await fixture();
    await f.seed('media/a.txt', 'old A');
    await f.seed('media/b.txt', 'old B');
    await f.source('media/a.txt', 'new A');
    await f.source('media/b.txt', 'new B');
    await f.adapter.prepare(f.context);
    await f.adapter.upload(f.context);
    required(f.objects.get('media/b.txt')).headers['x-amz-meta-external'] =
      'changed';
    const before = f.events.filter((event) => event.startsWith('PUT')).length;
    await expect(f.adapter.restore(f.context)).rejects.toMatchObject({
      code: 'R2_RESTORE_CONFLICT',
    });
    expect(f.events.filter((event) => event.startsWith('PUT'))).toHaveLength(
      before,
    );
    expect(
      await readFile(required(f.objects.get('media/a.txt')).path, 'utf8'),
    ).toBe('new A');
  });

  it('checks all backup hashes before any restore write and accepts interrupted restore progress', async () => {
    const f = await fixture();
    await f.seed('media/a.txt', 'old A');
    await f.seed('media/b.txt', 'old B');
    await f.source('media/a.txt', 'new A');
    await f.source('media/b.txt', 'new B');
    await f.adapter.prepare(f.context);
    await f.adapter.upload(f.context);
    await writeFile(join(f.root, 'backups/r2/media/b.txt'), 'BAD');
    const count = f.events.filter((event) => event.startsWith('PUT')).length;
    await expect(f.adapter.restore(f.context)).rejects.toMatchObject({
      code: 'R2_BACKUP_INVALID',
    });
    expect(f.events.filter((event) => event.startsWith('PUT'))).toHaveLength(
      count,
    );
    await writeFile(join(f.root, 'backups/r2/media/b.txt'), 'old B');
    const oldSave = f.context.save;
    f.context.save = async () => {
      await oldSave();
      if (f.context.journal.r2?.records[0]?.restore?.status === 'restored')
        throw new Error('fixture crash');
    };
    await expect(f.adapter.restore(f.context)).rejects.toThrow('fixture crash');
    f.context.save = oldSave;
    await f.adapter.restore(f.context);
    expect(
      await readFile(required(f.objects.get('media/a.txt')).path, 'utf8'),
    ).toBe('old A');
    expect(
      await readFile(required(f.objects.get('media/b.txt')).path, 'utf8'),
    ).toBe('old B');
  });

  it('rejects changed sources, symlink parents, reused preparation and unsafe keys', async () => {
    const f = await fixture();
    await f.source('media/a.txt', 'new');
    await writeFile(join(f.root, 'source/media/a.txt'), 'changed');
    await expect(f.adapter.prepare(f.context)).rejects.toMatchObject({
      code: 'R2_LOCAL_FILE_CHANGED',
    });
    await expect(f.adapter.prepare(f.context)).rejects.toMatchObject({
      code: 'R2_ALREADY_PREPARED',
    });
    const g = await fixture();
    await g.source('media/a.txt', 'new');
    await mkdir(join(g.root, 'victim'));
    await symlink('victim', join(g.root, 'backups'));
    await g.seed('media/a.txt', 'old');
    await expect(g.adapter.prepare(g.context)).rejects.toMatchObject({
      code: 'R2_LOCAL_PATH_INVALID',
    });
    const h = await fixture();
    h.context.manifest.push({
      path: 'media/../private.txt',
      byteSize: 0,
      sha256: hash(''),
      mime: 'text/plain',
      target: 'r2',
    });
    await expect(h.adapter.prepare(h.context)).rejects.toMatchObject({
      code: 'R2_MANIFEST_INVALID',
    });
  });

  it('rejects missing/corrupt journal evidence and source symlinks without remote writes', async () => {
    const f = await fixture();
    await f.source('media/a.txt', 'new');
    await expect(f.adapter.upload(f.context)).rejects.toMatchObject({
      code: 'R2_JOURNAL_INVALID',
    });
    await f.adapter.prepare(f.context);
    required(required(f.context.journal.r2).records[0]).path = 'assets/outside';
    await expect(f.adapter.upload(f.context)).rejects.toMatchObject({
      code: 'R2_JOURNAL_INVALID',
    });
    const g = await fixture();
    await g.source('media/a.txt', 'new');
    await rm(join(g.root, 'source/media/a.txt'));
    await symlink('../outside', join(g.root, 'source/media/a.txt'));
    await expect(g.adapter.prepare(g.context)).rejects.toBeDefined();
    expect(g.events.some((event) => event.startsWith('PUT'))).toBe(false);
  });

  it('has exact capacity bounds and scales multipart memory instead of reading whole objects', () => {
    expect(multipartSizing(64 * MIB).multipart).toBe(false);
    expect(multipartSizing(64 * MIB + 1, 256 * MIB)).toMatchObject({
      multipart: true,
      partSize: 8 * MIB,
      queueSize: 2,
    });
    expect(multipartSizing(512 * MIB, 175 * MIB).queueSize).toBe(1);
    expect(() => multipartSizing(512 * MIB, 150 * MIB)).toThrow();
    expect(() => multipartSizing(5 * 1024 ** 4 - 5 * 1024 ** 3 + 1)).toThrow();
    expect(() => multipartSizing(-1)).toThrow();
  });

  it('uploads 512 MiB through real S3 multipart requests with bounded memory and full readback hash', async () => {
    const f = await fixture();
    const key = 'media/large.webm';
    await mkdir(join(f.root, 'source/media'));
    const handle = await open(join(f.root, 'source', key), 'wx');
    const chunk = Buffer.alloc(MIB, 0x65);
    const digest = createHash('sha256');
    try {
      for (let index = 0; index < 512; index++) {
        digest.update(chunk);
        await handle.writeFile(chunk);
      }
    } finally {
      await handle.close();
    }
    f.context.manifest.push({
      path: key,
      byteSize: 512 * MIB,
      sha256: digest.digest('hex'),
      mime: 'video/webm',
      target: 'r2',
    });
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    try {
      await f.adapter.prepare(f.context);
      await f.adapter.upload(f.context);
      const record = required(required(f.context.journal.r2).records[0]);
      expect(record.upload?.parts).toHaveLength(64);
      expect(record.upload?.queueSize).toBe(2);
      expect(
        (await f.adapter.status(f.context, { verifyContent: true })).complete,
      ).toBe(true);
      expect(
        f.events.filter((event) => event === 'GET media/large.webm'),
      ).toHaveLength(1);
      expect(f.uploads.size).toBe(0);
      expect(peak - baseline).toBeLessThan(300 * MIB);
      console.info(
        JSON.stringify({
          event: 'r2-large-file-fixture',
          byteSize: 512 * MIB,
          parts: 64,
          plannedBufferBudget: record.upload?.memoryBudget,
          peakRssDelta: peak - baseline,
        }),
      );
    } finally {
      clearInterval(sampler);
    }
  });

  it('bounds part retries, aborts only its upload and preserves the old object on failure', async () => {
    const f = await fixture();
    const key = 'media/large.webm';
    await f.seed(key, 'old');
    await mkdir(join(f.root, 'source/media'));
    const handle = await open(join(f.root, 'source', key), 'wx');
    const chunk = Buffer.alloc(MIB, 0x22);
    const digest = createHash('sha256');
    try {
      for (let index = 0; index < 65; index++) {
        digest.update(chunk);
        await handle.writeFile(chunk);
      }
    } finally {
      await handle.close();
    }
    f.context.manifest.push({
      path: key,
      byteSize: 65 * MIB,
      sha256: digest.digest('hex'),
      mime: 'video/webm',
      target: 'r2',
    });
    f.controls.failPart = 1;
    await f.adapter.prepare(f.context);
    await expect(f.adapter.upload(f.context)).rejects.toMatchObject({
      code: 'R2_UPLOAD_FAILED',
    });
    expect(f.events.filter((event) => event.endsWith('part-1'))).toHaveLength(
      3,
    );
    expect(
      f.events.filter((event) => event === `DELETE ${key} upload`),
    ).toHaveLength(1);
    expect(f.uploads.size).toBe(0);
    expect(await readFile(required(f.objects.get(key)).path, 'utf8')).toBe(
      'old',
    );
  });

  it('reconciles a lost Complete response without retrying or aborting the committed upload', async () => {
    const f = await fixture();
    await bulkSource(f, 'media/large.webm');
    f.controls.loseComplete = true;
    await f.adapter.prepare(f.context);
    await f.adapter.upload(f.context);
    expect(f.context.journal.r2?.records[0]?.status).toBe('uploaded');
    expect(
      f.events.filter((event) => event === 'POST media/large.webm upload'),
    ).toHaveLength(1);
    expect(f.events.some((event) => event.startsWith('DELETE'))).toBe(false);
    expect(f.uploads.size).toBe(0);
  });

  it('leaves an unconfirmed Complete unknown and does not abort or repeat the mutation', async () => {
    const f = await fixture();
    await bulkSource(f, 'media/large.webm');
    f.controls.failComplete = true;
    await f.adapter.prepare(f.context);
    await expect(f.adapter.upload(f.context)).rejects.toMatchObject({
      code: 'R2_RESULT_UNKNOWN',
      unknown: true,
    });
    expect(f.context.journal.r2?.records[0]?.upload?.phase).toBe('completing');
    expect(
      f.events.filter((event) => event === 'POST media/large.webm upload'),
    ).toHaveLength(1);
    expect(f.events.some((event) => event.startsWith('DELETE'))).toBe(false);
    expect((await f.adapter.status(f.context)).unknown).toBe(true);
  });

  it('does not retry a denied multipart initiation or create a cleanup target without an upload ID', async () => {
    const f = await fixture();
    await bulkSource(f, 'media/large.webm');
    f.controls.failCreate = true;
    await f.adapter.prepare(f.context);
    await expect(f.adapter.upload(f.context)).rejects.toMatchObject({
      code: 'R2_WRITE_REJECTED',
    });
    expect(
      f.events.filter((event) => event === 'POST media/large.webm'),
    ).toHaveLength(1);
    expect(f.events.some((event) => event.startsWith('DELETE'))).toBe(false);
  });

  it('cancels active multipart work and aborts the owned upload before Complete', async () => {
    const f = await fixture();
    await f.seed('media/large.webm', 'old');
    await bulkSource(f, 'media/large.webm');
    const cancellation = new AbortController();
    f.context.signal = cancellation.signal;
    f.context.onProgress = (event) => {
      if (event.stage === 'part-complete') cancellation.abort();
    };
    await f.adapter.prepare(f.context);
    await expect(f.adapter.upload(f.context)).rejects.toMatchObject({
      code: 'CLOUDFLARE_CANCELLED',
    });
    expect(f.uploads.size).toBe(0);
    expect(
      f.events.filter((event) => event === 'POST media/large.webm upload'),
    ).toHaveLength(0);
    expect(
      await readFile(required(f.objects.get('media/large.webm')).path, 'utf8'),
    ).toBe('old');
  });

  it('stops a response body that stalls after headers without hanging or writing remote data', async () => {
    const f = await fixture();
    await f.seed('media/a.txt', 'old');
    await f.source('media/a.txt', 'new');
    f.controls.stallGet = 'media/a.txt';
    const adapter = createR2({
      config: { accountId: 'a'.repeat(32), bucketName: 'bucket' },
      credentials,
      client: f.client,
      retryDelayMs: 1,
      timeout: { read: 1000, request: 1000, idle: 50, file: 2000 },
    });
    await expect(adapter.prepare(f.context)).rejects.toMatchObject({
      code: 'R2_TRANSFER_TIMEOUT',
    });
    expect(
      f.events.some(
        (event) => event.startsWith('PUT') || event.startsWith('POST'),
      ),
    ).toBe(false);
  });

  it('checks a corrupted backup before any new deployment object is written', async () => {
    const f = await fixture();
    await f.seed('media/a.txt', 'old');
    await f.source('assets/new.css', 'new asset', 'text/css');
    await f.source('media/a.txt', 'new');
    await f.source('media/b.txt', 'new B');
    await f.adapter.prepare(f.context);
    await writeFile(join(f.root, 'backups/r2/media/a.txt'), 'corrupt');
    await expect(f.adapter.upload(f.context)).rejects.toMatchObject({
      code: 'R2_BACKUP_INVALID',
    });
    expect(f.events.some((event) => event.startsWith('PUT'))).toBe(false);
  });

  it('verifies remote bytes through GET instead of treating ETag or custom SHA as the hash', async () => {
    const f = await fixture();
    await f.source('media/a.txt', 'new');
    await f.adapter.prepare(f.context);
    await f.adapter.upload(f.context);
    await writeFile(required(f.objects.get('media/a.txt')).path, 'BAD');
    const result = await f.adapter.status(f.context, { verifyContent: true });
    expect(result.complete).toBe(false);
    expect(result.conflicts).toEqual(['media/a.txt']);
  });

  it('keeps a committed write unknown when its verification HEAD fails, then status resolves it', async () => {
    const f = await fixture();
    await f.source('media/a.txt', 'new');
    await f.adapter.prepare(f.context);
    f.controls.failHeadAfterWrite = 'media/a.txt';
    await expect(f.adapter.upload(f.context)).rejects.toMatchObject({
      code: 'R2_RESULT_UNKNOWN',
      unknown: true,
    });
    expect(f.context.journal.r2?.records[0]?.status).toBe('unknown');
    expect(
      f.events.filter((event) => event === 'PUT media/a.txt'),
    ).toHaveLength(1);
    delete f.controls.failHeadAfterWrite;
    expect((await f.adapter.status(f.context)).complete).toBe(true);
  });
});
