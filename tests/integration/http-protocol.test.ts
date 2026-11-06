import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { request } from 'node:http';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiErrorSchema } from '@foliohaven/core';
import {
  call,
  origin,
  sandbox,
  start,
  token,
  waitFor,
} from '../fixtures/http/environment.mjs';
import type { RunningService } from '../fixtures/http/environment.mjs';

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
async function raw(message: string): Promise<string> {
  const url = new URL(running.url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), '127.0.0.1', () =>
      socket.end(message),
    );
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}
describe('API-02：HTTP傳輸上限、timeout與中斷', () => {
  it('16KiB header硬上限431，重複token不取第一值繞過驗證', async () => {
    const large = await call(running, '/api/v1/workspace', {
      headers: { 'x-too-large': 'x'.repeat(17 * 1024) },
    });
    expect(large.status).toBe(431);
    ApiErrorSchema.parse(large.body);
    const duplicate = await raw(
      `GET /api/v1/workspace HTTP/1.1\r\nHost: 127.0.0.1\r\nx-alfred-process-token: ${token}\r\nx-alfred-process-token: ${token}\r\nConnection: close\r\n\r\n`,
    );
    expect(duplicate).toContain('400 Bad Request');
    expect(duplicate).toContain('DUPLICATE_HEADER');
  });
  it('chunked實際累積超過32MiB回413，未依賴Content-Length且未建立任何文章', async () => {
    const endpoint = new URL(running.url);
    let responded = false;
    let settle: () => void = () => undefined;
    let pump: Promise<void> = Promise.resolve();
    const response = new Promise<number>((resolve, reject) => {
      const connection = request(
        {
          hostname: '127.0.0.1',
          port: Number(endpoint.port),
          path: '/api/v1/articles',
          method: 'POST',
          headers: {
            'x-alfred-process-token': token,
            origin,
            'x-alfred-studio-origin': origin,
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
            'idempotency-key': randomUUID(),
          },
        },
        (incoming) => {
          responded = true;
          incoming.resume();
          incoming.once('end', () => resolve(incoming.statusCode ?? 0));
          incoming.once('error', reject);
        },
      );
      settle = () => connection.destroy();
      connection.on('error', (error) => {
        if (!responded) reject(error);
      });
      pump = (async () => {
        const chunk = Buffer.alloc(1024 * 1024, 32);
        for (let index = 0; index < 33 && !responded; index++) {
          if (!connection.write(chunk))
            await new Promise<void>((done, fail) => {
              const cleanup = () => {
                connection.off('drain', drain);
                connection.off('error', error);
                connection.off('close', closed);
              };
              const drain = () => {
                cleanup();
                done();
              };
              const error = (error: Error) => {
                cleanup();
                fail(error);
              };
              const closed = () => {
                cleanup();
                done();
              };
              connection.once('drain', drain);
              connection.once('error', error);
              connection.once('close', closed);
            });
        }
        if (!responded) connection.end('{}');
      })();
      void pump.catch((error) => {
        if (!responded) reject(error);
      });
    });
    try {
      expect(await response).toBe(413);
    } finally {
      settle();
      await pump.catch(() => undefined);
    }
    expect(await readdir(join(root, 'content/articles'))).toEqual(['one']);
  });
  it('真慢JSON連線15秒中止回408，所有錯誤為安全格式且沒有延後來源副作用', async () => {
    const endpoint = new URL(running.url);
    const result = await new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        const connection = request(
          {
            hostname: '127.0.0.1',
            port: Number(endpoint.port),
            path: '/api/v1/articles',
            method: 'POST',
            headers: {
              'x-alfred-process-token': token,
              origin,
              'x-alfred-studio-origin': origin,
              'content-type': 'application/json',
              'content-length': '10000',
              'idempotency-key': randomUUID(),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.once('end', () => {
              try {
                resolve({
                  status: response.statusCode ?? 0,
                  body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
                });
              } catch (error) {
                reject(error);
              } finally {
                connection.destroy();
              }
            });
            response.once('error', reject);
          },
        );
        connection.once('error', reject);
        connection.write('{');
      },
    );
    expect(result.status).toBe(408);
    expect(ApiErrorSchema.parse(result.body).error.code).toBe(
      'REQUEST_TIMEOUT',
    );
    expect(await readdir(join(root, 'content/articles'))).toEqual(['one']);
  });
  it('multipart中途client abort會清私有part，不註冊來源也不留下可用假紀錄', async () => {
    const endpoint = new URL(running.url);
    const boundary = 'alfred-client-abort';
    const connection = request({
      hostname: '127.0.0.1',
      port: Number(endpoint.port),
      path: '/api/v1/media/sources',
      method: 'POST',
      headers: {
        'x-alfred-process-token': token,
        origin,
        'x-alfred-studio-origin': origin,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'transfer-encoding': 'chunked',
        'idempotency-key': randomUUID(),
      },
    });
    connection.on('error', () => undefined);
    const closed = new Promise<void>((resolve) =>
      connection.once('close', () => resolve()),
    );
    connection.write(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\n`,
    );
    connection.write(Buffer.alloc(1024, 1));
    await waitFor(
      async () => readdir(join(root, '.alfred/staging')).catch(() => []),
      (names) => names.length > 0,
    );
    connection.destroy();
    await closed;
    await waitFor(
      async () => readdir(join(root, '.alfred/staging')),
      (names) => names.length === 0,
    );
    expect(await readdir(join(root, 'media/source'))).toEqual([]);
  });
});
