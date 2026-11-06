import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import {
  ArticleWriteSchema,
  SiteConfigSchema,
  TaxonomySchema,
} from '@foliohaven/core';
import type { BuildCoordinatorOptions } from '../../../server/src/build/coordinator.js';
import { createLocalService } from '../../../server/src/http/index.js';
import type { LocalService } from '../../../server/src/http/index.js';

export const token = 'synthetic-http-fixture-process-token-0000000000000000';
export const origin = 'http://localhost:5173';
export const article = () =>
  ArticleWriteSchema.parse({
    contentHtml: '<h2 id="intro">開始</h2><p>HTTP合成文章。</p>',
    meta: {
      status: 'draft',
      title: '文章',
      slug: 'one',
      category: 'notes',
      tags: ['example'],
      seo: { description: 'HTTP合成文章說明' },
    },
  });
export const site = () =>
  SiteConfigSchema.parse({
    siteName: 'HTTP測試網站',
    siteDescription: '隔離HTTP契約驗收',
    siteUrl: 'https://example.invalid/',
    author: { name: '作者', url: null },
    pagination: { category: 2, tag: 2, articles: 2 },
  });
export async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'alfred-http-'));
  try {
    for (const key of [
      'content/articles/one',
      'content/pages',
      'media/source',
      'packages/core',
      'packages/ui',
      'site',
      'studio',
      'server',
      'scripts',
    ])
      await mkdir(join(root, key), { recursive: true });
    for (const [key, value] of Object.entries({
      '.node-version': process.versions.node,
      'package.json': '{"name":"http-fixture","type":"module"}',
      'pnpm-workspace.yaml': 'packages: []\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    }))
      await writeFile(join(root, key), value);
    await writeFile(join(root, 'content/site.json'), JSON.stringify(site()));
    const taxonomy = TaxonomySchema.parse({
      categories: [
        { path: 'notes', name: '筆記', description: '筆記資料' },
        { path: 'tools', name: '工具', description: '工具資料' },
      ],
      tags: [{ slug: 'example', name: '範例', description: '範例資料' }],
    });
    await writeFile(
      join(root, 'content/categories.json'),
      JSON.stringify(taxonomy.categories),
    );
    await writeFile(
      join(root, 'content/tags.json'),
      JSON.stringify(taxonomy.tags),
    );
    await writeFile(
      join(root, 'content/articles/one/meta.json'),
      JSON.stringify(article().meta),
    );
    await writeFile(
      join(root, 'content/articles/one/content.html'),
      article().contentHtml,
    );
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export const smallBuild: NonNullable<BuildCoordinatorOptions['execution']> = {
  prepare: async () => undefined,
  render: async (context) => {
    // 只驗HTTP→正式coordinator→journal promotion；不宣稱此fixture為Astro SSG。
    const output = join(
      context.repositoryRoot,
      '.alfred/builds',
      context.jobId,
      'output',
    );
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, 'index.html'),
      '<!doctype html><p>HTTP build transport fixture</p>',
    );
    await mkdir(join(context.snapshotRoot, '.alfred'), { recursive: true });
    await writeFile(
      join(context.snapshotRoot, '.alfred/build-result.json'),
      JSON.stringify({
        schemaVersion: 1,
        mediaPending: false,
        pendingLinkChecks: 0,
        result: {
          outputDirectory: 'dist',
          snapshotRevision: context.snapshotRevision,
          routeCount: 1,
          fileCount: 1,
          warnings: [],
        },
      }),
    );
  },
};
export interface RunningService {
  readonly service: LocalService;
  readonly url: string;
  readonly root: string;
}
export async function start(
  root: string,
  extra: {
    clock?: () => Date;
    buildExecution?: BuildCoordinatorOptions['execution'];
  } = {},
): Promise<RunningService> {
  const service = await createLocalService({
    repositoryRoot: root,
    proxyToken: token,
    buildExecution: smallBuild,
    ...extra,
  });
  const address = await service.listen({ port: 0 });
  return { service, url: address.url, root };
}
export interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly bytes: Buffer;
  readonly body: unknown;
}
export async function call(
  running: Pick<RunningService, 'url'>,
  path: string,
  input: {
    method?: string;
    body?: unknown;
    raw?: Buffer | string;
    headers?: Record<string, string>;
    authorized?: boolean;
  } = {},
): Promise<HttpResult> {
  const method = input.method ?? 'GET';
  const bytes =
    input.raw !== undefined
      ? Buffer.from(input.raw)
      : input.body !== undefined
        ? Buffer.from(JSON.stringify(input.body))
        : undefined;
  const endpoint = new URL(running.url);
  return new Promise((resolve, reject) => {
    const connection = request(
      {
        hostname: '127.0.0.1',
        port: Number(endpoint.port),
        path,
        method,
        headers: {
          ...(input.authorized === false
            ? {}
            : { 'x-alfred-process-token': token }),
          ...(method === 'GET'
            ? {}
            : { origin, 'x-alfred-studio-origin': origin }),
          ...(input.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...(bytes ? { 'content-length': String(bytes.length) } : {}),
          ...input.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          const result = Buffer.concat(chunks);
          let body: unknown = result.toString();
          if (
            String(response.headers['content-type']).startsWith(
              'application/json',
            )
          ) {
            try {
              body = JSON.parse(result.toString()) as unknown;
            } catch (error) {
              reject(error);
              return;
            }
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes: result,
            body,
          });
        });
      },
    );
    connection.once('error', reject);
    connection.end(bytes);
  });
}
export async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const end = Date.now() + 20_000;
  let value = await read();
  while (!predicate(value)) {
    if (Date.now() > end) throw new Error('HTTP fixture wait timeout');
    await new Promise((resolve) => setTimeout(resolve, 30));
    value = await read();
  }
  return value;
}
