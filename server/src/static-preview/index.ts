import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ArtifactStore } from '../build/artifacts/index.js';
import { isMissing, RepositoryError, safePath } from '../files/io.js';
import { byteRange } from '../http/transport.js';

const mime: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  webp: 'image/webp',
  png: 'image/png',
  webm: 'video/webm',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webmanifest: 'application/manifest+json',
  woff: 'font/woff',
  woff2: 'font/woff2',
};
function resource(request: IncomingMessage): {
  key: string;
  pathname: string;
  search: string;
} {
  const raw = request.url ?? '/';
  if (
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.includes('\\') ||
    Array.from(raw).some((character) => character.charCodeAt(0) <= 32) ||
    /%2f|%5c/iu.test(raw.split('?')[0] ?? '')
  )
    throw new RepositoryError('INVALID_PREVIEW_URL', '網址格式無效。', 400);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.split('?')[0] ?? '');
  } catch {
    throw new RepositoryError('INVALID_PREVIEW_URL', '網址編碼無效。', 400);
  }
  if (/\p{Cc}/u.test(decoded))
    throw new RepositoryError(
      'INVALID_PREVIEW_URL',
      '網址含不合法控制字元。',
      400,
    );
  if (
    decoded
      .split('/')
      .some(
        (part, index) =>
          part === '..' ||
          part === '.' ||
          (part.startsWith('.') && !(index === 1 && part === '.well-known')),
      )
  )
    throw new RepositoryError('PREVIEW_NOT_FOUND', '頁面不存在。', 404);
  const url = new URL(raw, 'http://preview.invalid');
  return { key: decoded.slice(1), pathname: url.pathname, search: url.search };
}
/** 只服務根dist；每次回應持artifact gate到串流結束，與promotion／recovery協調。 */
export function createStaticPreview(options: {
  readonly repositoryRoot: string;
}) {
  const root = resolve(options.repositoryRoot);
  const artifacts = new ArtifactStore({ repositoryRoot: root });
  const active = new Set<AbortController>();
  let listening = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let startup: Promise<void> | undefined;
  const startupController = new AbortController();
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const controller = new AbortController();
    active.add(controller);
    const disconnect = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once('close', disconnect);
    try {
      if (closing)
        throw new RepositoryError(
          'PREVIEW_STOPPING',
          '預覽服務正在停止。',
          503,
        );
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        response.setHeader('Allow', 'GET, HEAD');
        throw new RepositoryError('METHOD_NOT_ALLOWED', '不支援此方法。', 405);
      }
      const path = resource(request);
      await artifacts.withPreviewGate(
        async ({ digest }) => {
          let key = path.key;
          let status = 200;
          if (key === '' || key.endsWith('/')) key += 'index.html';
          try {
            const info = await lstat(await safePath(root, `dist/${key}`));
            if (info.isDirectory()) {
              response.writeHead(308, {
                Location: path.pathname + '/' + path.search,
              });
              response.end();
              return;
            }
          } catch (error) {
            if (!isMissing(error)) throw error;
            key = '404.html';
            status = 404;
          }
          let handle;
          try {
            handle = await open(
              await safePath(root, `dist/${key}`),
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
          } catch (error) {
            if (isMissing(error))
              throw new RepositoryError(
                'PREVIEW_NOT_FOUND',
                '頁面不存在。',
                404,
              );
            throw error;
          }
          try {
            const stat = await handle.stat();
            if (!stat.isFile())
              throw new RepositoryError(
                'PREVIEW_NOT_FOUND',
                '頁面不存在。',
                404,
              );
            const type =
              mime[key.split('.').at(-1) ?? ''] ?? 'application/octet-stream';
            const etag = `"${createHash('sha256').update(digest).update('\0').update(key).digest('hex')}"`;
            response.setHeader('Content-Type', type);
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Cache-Control', 'no-cache');
            response.setHeader('ETag', etag);
            if (status === 200 && request.headers['if-none-match'] === etag) {
              response.writeHead(304);
              response.end();
              return;
            }
            const requested =
              type === 'video/webm' &&
              (!request.headers['if-range'] ||
                request.headers['if-range'] === etag)
                ? request.headers.range
                : undefined;
            const range = byteRange(requested, stat.size);
            if (type === 'video/webm')
              response.setHeader('Accept-Ranges', 'bytes');
            if (range) {
              status = 206;
              response.setHeader(
                'Content-Range',
                `bytes ${range.start}-${range.end}/${stat.size}`,
              );
            }
            response.setHeader(
              'Content-Length',
              range ? range.end - range.start + 1 : stat.size,
            );
            response.writeHead(status);
            if (request.method === 'HEAD') {
              response.end();
              return;
            }
            await pipeline(
              handle.createReadStream({ autoClose: false, ...(range ?? {}) }),
              response,
              { signal: controller.signal },
            );
          } finally {
            await handle.close();
          }
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) {
        response.destroy();
        return;
      }
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof RepositoryError ? error.status : 500;
      if (
        error instanceof Error &&
        'contentRange' in error &&
        typeof error.contentRange === 'string'
      )
        response.setHeader('Content-Range', error.contentRange);
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(
        status === 404
          ? '頁面不存在。'
          : status === 416
            ? '要求的檔案範圍無效。'
            : '無法提供預覽，請檢查建置或復原狀態。',
      );
    } finally {
      response.removeListener('close', disconnect);
      active.delete(controller);
    }
  }
  const server = createServer(
    { maxHeaderSize: 16 * 1024 },
    (request, response) => {
      void handle(request, response).catch(() => response.destroy());
    },
  );
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.setTimeout(30_000, (socket) => socket.destroy());
  return {
    async listen({
      port = 4322,
      host = '127.0.0.1',
    }: {
      readonly port?: number;
      readonly host?: '127.0.0.1' | '0.0.0.0';
    } = {}) {
      if (
        listening ||
        startup ||
        closing ||
        !['127.0.0.1', '0.0.0.0'].includes(host) ||
        !Number.isSafeInteger(port) ||
        port < 0 ||
        port > 65535
      )
        throw new RepositoryError(
          'INVALID_PREVIEW_OPTIONS',
          '預覽服務啟動設定無效。',
          500,
        );
      startup = (async () => {
        await artifacts.withPreviewGate(async () => undefined, {
          signal: startupController.signal,
        });
        if (closing)
          throw new RepositoryError(
            'PREVIEW_STOPPING',
            '預覽服務正在停止。',
            503,
          );
        await new Promise<void>((resolveReady, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => {
            server.removeListener('error', reject);
            listening = true;
            resolveReady();
          });
        });
      })();
      try {
        await startup;
      } finally {
        startup = undefined;
      }
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new RepositoryError(
          'PREVIEW_START_FAILED',
          '預覽服務無法啟動。',
          503,
        );
      return {
        host,
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
      };
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true;
        startupController.abort();
        await startup?.catch(() => undefined);
        for (const controller of active) controller.abort();
        if (listening)
          await new Promise<void>((resolveClosed, reject) =>
            server.close((error) => (error ? reject(error) : resolveClosed())),
          );
        listening = false;
      })();
      return closePromise;
    },
  };
}
