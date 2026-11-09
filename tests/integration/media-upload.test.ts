import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { FileRepository } from '../../server/dist/files/index.js';
import { MediaService } from '../../server/dist/media/index.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(deadlines?: { uploadMs?: number; idleMs?: number }) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-upload-'));
  roots.push(root);
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  const service = new MediaService({
    repositoryRoot: root,
    repository,
    ...(deadlines === undefined ? {} : { deadlines }),
  });
  const server = createServer(async (req, res) => {
    try {
      const staged = await service.stageUpload(req);
      const result = await service.register(staged);
      res.writeHead(201, {
        'Content-Type': 'application/json',
        ETag: result.etag,
      });
      res.end(JSON.stringify(result.value));
    } catch (error) {
      const value = error as { code?: string; status?: number };
      res.writeHead(value.status ?? 500, {
        'Content-Type': 'application/json',
        Connection: 'close',
      });
      res.end(JSON.stringify({ code: value.code ?? 'FAILED' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing test address');
  return { root, port: address.port, service };
}
const boundary = 'alfred-test-boundary';
function body(
  bytes: Buffer,
  fields: readonly (readonly [string, string])[] = [],
  fileCount = 1,
  closed = true,
) {
  const parts: Buffer[] = [];
  for (let index = 0; index < fileCount; index++)
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="圖片.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from('\r\n'),
    );
  for (const [name, value] of fields)
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  if (closed) parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}
async function post(
  port: number,
  bytes: Buffer,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: Record<string, unknown> }>(
    (resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(bytes.length),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString()) as Record<
                string,
                unknown
              >,
            }),
          );
        },
      );
      request.once('error', reject);
      request.end(bytes);
    },
  );
}
async function image() {
  return sharp({
    create: { width: 16, height: 8, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
}

describe('MEDIA-02: real HTTP multipart streams and cleanup', () => {
  it('accepts UTF8 filename and metadata fields after the streamed file', async () => {
    const { root, port } = await fixture();
    const response = await post(
      port,
      body(await image(), [['displayName', '後面的中文名稱']]),
    );
    expect(response.status).toBe(201);
    expect(response.body['displayName']).toBe('後面的中文名稱');
    expect((await readdir(join(root, 'media/source'))).length).toBe(1);
    expect(await readdir(join(root, '.foliohaven/staging'))).toEqual([]);
  });
  it.each([
    ['two-files', [], 2, true, 413],
    ['truncated', [], 1, false, 400],
    ['unknown-field', [['unknown', 'bad']], 1, true, 400],
    [
      'duplicate-field',
      [
        ['displayName', 'one'],
        ['displayName', 'two'],
      ],
      1,
      true,
      400,
    ],
    ['too-long-field', [['displayName', 'x'.repeat(4097)]], 1, true, 400],
    ['invalid-poster', [['posterTimeSeconds', 'Infinity']], 1, true, 422],
  ] as const)(
    'rejects %s and removes staging',
    async (_name, fields, count, closed, status) => {
      const { root, port } = await fixture();
      const response = await post(
        port,
        body(await image(), fields, count, closed),
      );
      expect(response.status).toBe(status);
      expect(await readdir(join(root, '.foliohaven/staging'))).toEqual([]);
    },
  );
  it('rejects declared overall bytes excess before accepting a file', async () => {
    const { port } = await fixture();
    const response = await post(port, Buffer.alloc(0), {
      'Content-Length': String(513 * 1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
  });
  it('enforces idle/overall deadlines and closes the parser without registration', async () => {
    for (const deadlines of [
      { idleMs: 30, uploadMs: 1000 },
      { idleMs: 1000, uploadMs: 30 },
    ]) {
      const { root, port } = await fixture(deadlines);
      const response = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            res.resume();
            res.once('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.once('error', reject);
        req.write(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`,
          ),
        );
      });
      expect(response).toBe(408);
      expect(await readdir(join(root, '.foliohaven/staging'))).toEqual([]);
    }
  });
  it('handles client abort without orphaned partial source or encoder', async () => {
    const { root, port } = await fixture({ idleMs: 100, uploadMs: 1000 });
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Transfer-Encoding': 'chunked',
        },
      });
      req.on('error', () => resolve());
      req.write(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
      );
      setTimeout(() => req.destroy(), 30);
    });
    const deadline = Date.now() + 1000;
    for (;;) {
      let staging: string[] = [];
      try {
        staging = await readdir(join(root, '.foliohaven/staging'));
      } catch {
        /* request can abort before creating its staging */
      }
      if (staging.length === 0) break;
      if (Date.now() > deadline) throw new Error('Staging not cleaned');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await readdir(join(root, '.foliohaven/transactions'))).toEqual([]);
  });
});
