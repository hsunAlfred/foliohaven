import type { IncomingMessage, ServerResponse } from 'node:http';
import { finished, pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { ManagedMediaPathSchema, MediaManifestSchema } from '@foliohaven/core';
import type { MediaManifest, MediaOutput } from '@foliohaven/core';
import { FileRepository } from '../files/index.js';
import { MediaService } from '../media/service.js';
import { MediaError } from '../media/errors.js';
import { MediaRangeError } from '../media/files.js';
import type { MediaFile } from '../media/types.js';
import { header, HttpError } from './transport.js';

export interface DevMediaContext {
  readonly mediaManifest: MediaManifest;
  readonly routeManifest: { readonly assets: readonly string[] };
}
export interface DevMediaOptions {
  readonly repositoryRoot: string;
  /** Must resolve the current valid private context, never a last-good fallback. */
  readonly loadContext: () => Promise<DevMediaContext>;
}
export type DevMediaMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

function matchesOutput(actual: MediaOutput, expected: MediaOutput): boolean {
  return (
    actual.publicPath === expected.publicPath &&
    actual.sha256 === expected.sha256 &&
    actual.byteSize === expected.byteSize &&
    actual.mimeType === expected.mimeType
  );
}
function unavailable(): Error {
  return new Error('DEV_MEDIA_CONTEXT_UNAVAILABLE');
}
function reject(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  code: string,
  extra: Readonly<Record<string, string>> = {},
) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(`${code}\n`);
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

/** Read-only dev capability for current public outputs; it exposes no management API. */
export function createDevMediaMiddleware(
  options: DevMediaOptions,
): DevMediaMiddleware {
  const repositoryRoot = resolve(options.repositoryRoot);
  const media = new MediaService({
    repositoryRoot,
    repository: new FileRepository({ repositoryRoot }),
  });
  return (request, response, next) => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    if (path !== '/media' && !path.startsWith('/media/')) {
      next();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reject(request, response, 405, 'METHOD_NOT_ALLOWED', {
        Allow: 'GET, HEAD',
      });
      return;
    }
    if (!ManagedMediaPathSchema.safeParse(path).success) {
      reject(request, response, 404, 'MEDIA_NOT_FOUND');
      return;
    }
    const controller = new AbortController();
    const aborted = () => controller.abort();
    const closed = () => {
      if (!response.writableFinished) controller.abort();
    };
    request.once('aborted', aborted);
    response.once('close', closed);
    void (async () => {
      let expected: MediaOutput | undefined;
      let file: MediaFile | undefined;
      try {
        const context = await options.loadContext();
        if (
          ('status' in context && context.status !== 'valid') ||
          !Array.isArray(context.routeManifest.assets) ||
          !context.routeManifest.assets.every(
            (asset) => typeof asset === 'string',
          )
        )
          throw unavailable();
        const manifest = MediaManifestSchema.safeParse(context.mediaManifest);
        if (!manifest.success) throw unavailable();
        expected = manifest.data.assets
          .flatMap((asset) => asset.outputs)
          .find((output) => output.publicPath === path);
        if (!context.routeManifest.assets.includes(path) || !expected) {
          reject(request, response, 404, 'MEDIA_NOT_FOUND');
          return;
        }
        file = await media.openVariant(
          path.split('/')[2] ?? '',
          path.split('/')[3] ?? '',
          header(request, 'range'),
        );
        if (!matchesOutput(file.output, expected)) throw unavailable();
        if (controller.signal.aborted) return;
        response.writeHead(file.status, {
          ...file.headers,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        if (request.method === 'HEAD') response.end();
        else
          await pipeline(file.stream, response, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof MediaRangeError && expected)
          reject(request, response, 416, 'MEDIA_RANGE_NOT_SATISFIABLE', {
            // The current source may have changed since this context was built.
            // Never disclose a newer binding's size through the range error.
            'Content-Range': `bytes */${expected.byteSize}`,
          });
        else if (error instanceof MediaError && error.status === 404)
          reject(request, response, 404, 'MEDIA_NOT_FOUND');
        else if (error instanceof HttpError && error.status === 400)
          reject(request, response, 400, 'INVALID_MEDIA_REQUEST');
        else reject(request, response, 503, 'DEV_MEDIA_UNAVAILABLE');
      } finally {
        request.removeListener('aborted', aborted);
        response.removeListener('close', closed);
        if (file) {
          file.stream.destroy();
          await finished(file.stream, { cleanup: true }).catch(() => undefined);
        }
      }
    })();
  };
}
