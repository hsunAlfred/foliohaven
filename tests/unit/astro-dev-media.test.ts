import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteConfigSchema } from '@foliohaven/core';
import type { DevMediaMiddleware } from '../../server/src/http/index.js';
import {
  loadAstroConfigContext,
  loadRenderContext,
} from '../../site/src/lib/server/context.js';

const fixtures: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of fixtures.splice(0))
    await rm(root, { recursive: true, force: true });
});

interface AdapterPlugin {
  configureServer(server: {
    ssrLoadModule: (path: string) => Promise<unknown>;
    middlewares: { use: (middleware: DevMediaMiddleware) => void };
  }): void;
}
async function request(middleware: DevMediaMiddleware) {
  const incoming = Object.assign(new EventEmitter(), {
    url: '/media/11111111-1111-4111-8111-111111111111/image.webp',
    method: 'GET',
    headers: {},
  });
  let status = 0;
  let finish: (value: { status: number; body: string }) => void = () =>
    undefined;
  const done = new Promise<{ status: number; body: string }>((resolve) => {
    finish = resolve;
  });
  const outgoing = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead(code: number) {
      status = code;
      outgoing.headersSent = true;
      return outgoing;
    },
    end(bytes: Buffer) {
      outgoing.writableEnded = true;
      finish({ status, body: bytes.toString() });
    },
  });
  middleware(
    incoming as IncomingMessage,
    outgoing as unknown as ServerResponse,
    () => finish({ status: 0, body: 'UNEXPECTED_NEXT' }),
  );
  return done;
}

describe('Astro development media context loader', () => {
  it('validates only the config site origin while retaining index guards and the strict public loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alfred-config-context-'));
    fixtures.push(root);
    vi.stubEnv('ALFRED_RENDER_CONTEXT', root);
    const index = {
      schemaVersion: 1,
      status: 'valid',
      site: {
        ...SiteConfigSchema.parse({
          siteName: 'Config context fixture',
          siteDescription: 'Config context fixture description',
          siteUrl: 'https://example.invalid/',
          author: { name: 'Fixture' },
        }),
        futureSiteSetting: true,
      },
      routeManifest: { routes: [], assets: [] },
      mediaManifest: { schemaVersion: 1, assets: [] },
      articles: [],
      lists: [],
      fixedPages: [],
      pages: {},
    };
    const write = async (value: unknown) =>
      writeFile(join(root, 'index.json'), JSON.stringify(value));
    await write(index);
    expect((await loadAstroConfigContext()).site).toEqual({
      siteUrl: 'https://example.invalid/',
    });
    await expect(loadRenderContext()).rejects.toThrow('RENDER_CONTEXT_INVALID');
    await write({ ...index, status: 'invalid' });
    await expect(loadAstroConfigContext()).rejects.toThrow(
      'RENDER_CONTEXT_INVALID',
    );
    await write({ ...index, site: { siteUrl: 'not-a-site-url' } });
    await expect(loadAstroConfigContext()).rejects.toThrow(
      'RENDER_CONTEXT_INVALID',
    );
  });
  it('uses the current SSR loader for every request and never falls back to an old valid context', async () => {
    const { astroDevMedia } = (await import(
      new URL('../../scripts/astro-dev-media.mjs', import.meta.url).href
    )) as {
      astroDevMedia(options: {
        repositoryRoot: string;
        contextModulePath: string;
      }): AdapterPlugin;
    };
    const valid = {
      status: 'valid',
      mediaManifest: { schemaVersion: 1, assets: [] },
      routeManifest: { assets: [] },
    };
    const first = vi.fn(async () => valid);
    const second = vi.fn(async () => ({ ...valid, status: 'invalid' }));
    const ssrLoadModule = vi
      .fn<(path: string) => Promise<unknown>>()
      .mockResolvedValueOnce({ loadRenderContext: first })
      .mockResolvedValueOnce({ loadRenderContext: second });
    let middleware: DevMediaMiddleware | undefined;
    const path = '/trusted-site/src/lib/server/context.ts';
    astroDevMedia({
      repositoryRoot: '/unused-root-no-files-opened',
      contextModulePath: path,
    }).configureServer({
      ssrLoadModule,
      middlewares: {
        use: (value) => {
          middleware = value;
        },
      },
    });
    if (!middleware) throw new Error('Media middleware was not installed');
    expect(await request(middleware)).toEqual({
      status: 404,
      body: 'MEDIA_NOT_FOUND\n',
    });
    expect(await request(middleware)).toEqual({
      status: 503,
      body: 'DEV_MEDIA_UNAVAILABLE\n',
    });
    expect(ssrLoadModule.mock.calls).toEqual([[path], [path]]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
