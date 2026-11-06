import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { z } from 'zod';
import {
  ArticleIdSchema,
  SiteConfigSchema,
  SiteUrlSchema,
  MediaManifestSchema,
  UuidSchema,
  notFoundSeo,
  type HomeViewModel,
  type ListPageViewModel,
  type PublicArticleViewModel,
  type JsonValue,
} from '@foliohaven/core';
import type { RenderContextIndex } from '../../fixed-pages.js';

const fileSchema = z
  .string()
  .regex(/^(?:articles|lists|pages)\/[a-z0-9-]+\.json$/u);
const indexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal('valid'),
  generation: UuidSchema.optional(),
  site: SiteConfigSchema,
  routeManifest: z.strictObject({
    routes: z.array(
      z.strictObject({
        kind: z.enum(['fixed', 'article', 'category', 'tag']),
        path: z.string(),
        outputPath: z.string(),
        index: z.boolean(),
        articleId: z.string().optional(),
        taxonomyKey: z.string().optional(),
        page: z.number().int().positive().optional(),
      }),
    ),
    assets: z.array(z.string()),
  }),
  mediaManifest: MediaManifestSchema,
  articles: z.array(
    z.strictObject({
      id: ArticleIdSchema,
      url: z.string(),
      file: fileSchema,
      title: z.string(),
      description: z.string(),
      publishedAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  lists: z.array(
    z.strictObject({
      kind: z.enum(['category', 'tag', 'articles']),
      url: z.string(),
      file: fileSchema,
    }),
  ),
  fixedPages: z.array(
    z.strictObject({
      id: ArticleIdSchema,
      path: z.string(),
      seo: z.record(z.string(), z.json()),
    }),
  ),
  pages: z.record(z.string(), fileSchema),
});

function contextDirectory(): string {
  const directory = process.env['ALFRED_RENDER_CONTEXT'];
  if (directory === undefined || !isAbsolute(directory))
    throw new Error(
      'RENDER_CONTEXT_REQUIRED：請使用專案的建置或開發入口產生私有呈現資料。',
    );
  return resolve(directory);
}
function invalidContext(): Error {
  return new Error(
    'RENDER_CONTEXT_INVALID：呈現資料不存在或來源驗證失敗，請修正來源後重新產生。',
  );
}
async function verifiedDirectory(directory: string): Promise<void> {
  const rootStat = await lstat(directory);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    throw invalidContext();
}
async function readJson(root: string, file: string): Promise<unknown> {
  try {
    const target = resolve(root, file);
    if (
      relative(root, target).startsWith('..') ||
      !target.startsWith(`${root}${sep}`)
    )
      throw invalidContext();
    await verifiedDirectory(root);
    let parent = dirname(target);
    while (parent !== root) {
      await verifiedDirectory(parent);
      parent = dirname(parent);
    }
    if (!(await realpath(target)).startsWith(`${root}${sep}`))
      throw invalidContext();
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 256 * 1024 * 1024)
        throw invalidContext();
      return JSON.parse(await handle.readFile('utf8')) as unknown;
    } finally {
      await handle.close();
    }
  } catch {
    throw invalidContext();
  }
}
interface RenderSnapshot {
  readonly key: string;
  readonly index: RenderContextIndex;
  readonly directory: string;
}
let cachedSnapshot: RenderSnapshot | undefined;
const indexVersion = (root: string, stat: BigIntStats) =>
  `${root}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

/** Pin one validated index and immutable payload directory for this loader. */
async function loadSnapshot(): Promise<RenderSnapshot> {
  try {
    const root = contextDirectory();
    await verifiedDirectory(root);
    const handle = await open(
      resolve(root, 'index.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size > 256n * 1024n * 1024n)
        throw invalidContext();
      const key = indexVersion(root, stat);
      if (cachedSnapshot?.key === key) {
        await verifiedDirectory(cachedSnapshot.directory);
        return cachedSnapshot;
      }
      const parsed = indexSchema.safeParse(
        JSON.parse(await handle.readFile('utf8')) as unknown,
      );
      if (!parsed.success) throw invalidContext();
      // The metadata and JSON belong to the same opened inode, even if the
      // publisher replaces the active index while this read is in flight.
      const afterRead = await handle.stat({ bigint: true });
      // Replacing the pathname can change the opened old inode's ctime when
      // its link is removed; that does not change this snapshot's bytes.
      if (
        afterRead.ino !== stat.ino ||
        afterRead.size !== stat.size ||
        afterRead.mtimeNs !== stat.mtimeNs
      )
        throw invalidContext();
      const index = parsed.data as unknown as RenderContextIndex;
      const directory = index.generation
        ? resolve(root, 'generations', index.generation)
        : root;
      await verifiedDirectory(directory);
      const snapshot = { key: indexVersion(root, afterRead), index, directory };
      cachedSnapshot = snapshot;
      return snapshot;
    } finally {
      await handle.close();
    }
  } catch {
    cachedSnapshot = undefined;
    throw invalidContext();
  }
}
/** 每次核對inode／nanosecond版本；同份不可變索引只解析一次，不快取正文。 */
export async function loadRenderContext(): Promise<RenderContextIndex> {
  return (await loadSnapshot()).index;
}
/** Config consumes only the site origin; public rendering keeps the full schema. */
export async function loadAstroConfigContext() {
  const parsed = indexSchema
    .extend({ site: z.object({ siteUrl: SiteUrlSchema }) })
    .safeParse(await readJson(contextDirectory(), 'index.json'));
  if (!parsed.success) throw invalidContext();
  return parsed.data;
}
export async function loadHomePage(): Promise<HomeViewModel> {
  const snapshot = await loadSnapshot();
  return (await readJson(snapshot.directory, 'home.json')) as HomeViewModel;
}
export async function loadNotFoundPage() {
  const snapshot = await loadSnapshot();
  const home = (await readJson(
    snapshot.directory,
    'home.json',
  )) as HomeViewModel;
  return { site: home.site, seo: notFoundSeo(snapshot.index.site) };
}
export async function loadArticlePage(
  id: string,
): Promise<PublicArticleViewModel> {
  const snapshot = await loadSnapshot();
  const context = snapshot.index;
  const article = context.articles.find((item) => item.id === id);
  if (article === undefined)
    throw new Error('RENDER_ARTICLE_NOT_FOUND：文章不在公開呈現集合。');
  return (await readJson(
    snapshot.directory,
    article.file,
  )) as PublicArticleViewModel;
}
export async function loadListPage(url: string): Promise<ListPageViewModel> {
  const snapshot = await loadSnapshot();
  const context = snapshot.index;
  const page = context.lists.find((item) => item.url === url);
  if (page === undefined)
    throw new Error('RENDER_LIST_NOT_FOUND：列表不在公開呈現集合。');
  return (await readJson(snapshot.directory, page.file)) as ListPageViewModel;
}
/** 新增獨立頁可共用此入口，資料須先由registry的strict schema驗證。 */
export async function loadFixedPage(id: string) {
  const snapshot = await loadSnapshot();
  const context = snapshot.index;
  const page = context.fixedPages.find((item) => item.id === id);
  if (page === undefined)
    throw new Error('RENDER_FIXED_PAGE_NOT_FOUND：固定頁未登錄。');
  const resource = context.pages[id];
  const home = (await readJson(
    snapshot.directory,
    'home.json',
  )) as HomeViewModel;
  return {
    site: home.site,
    seo: page.seo,
    data:
      resource === undefined
        ? null
        : ((await readJson(snapshot.directory, resource)) as JsonValue),
  };
}
export async function loadSearchIndex(): Promise<unknown> {
  const snapshot = await loadSnapshot();
  return readJson(snapshot.directory, 'search-index.json');
}

/** Keep directory SEO, the category tree and first-page Tag counts in one generation. */
export async function loadTaxonomyOverviewPage(
  id: 'category-index' | 'tag-index',
) {
  const snapshot = await loadSnapshot();
  const context = snapshot.index;
  const page = context.fixedPages.find((item) => item.id === id);
  if (page === undefined)
    throw new Error('RENDER_FIXED_PAGE_NOT_FOUND：固定頁未登錄。');
  const home = (await readJson(
    snapshot.directory,
    'home.json',
  )) as HomeViewModel;
  const tags: {
    slug: string;
    name: string;
    description: string;
    url: string;
    articleCount: number;
  }[] = [];
  if (id === 'tag-index') {
    const listsByUrl = new Map(context.lists.map((list) => [list.url, list]));
    const firstPages = context.routeManifest.routes.filter(
      (route) => route.kind === 'tag' && route.page === 1,
    );
    // Bound file reads even when the author has a large Tag directory.
    for (let offset = 0; offset < firstPages.length; offset += 8) {
      const models = await Promise.all(
        firstPages.slice(offset, offset + 8).map(async (route) => {
          const list = listsByUrl.get(route.path);
          if (list?.kind !== 'tag') throw invalidContext();
          return (await readJson(
            snapshot.directory,
            list.file,
          )) as ListPageViewModel;
        }),
      );
      tags.push(
        ...models.map((model) => ({
          slug: model.key,
          name: model.title,
          description: model.description,
          url: model.url,
          articleCount: model.pagination.totalItems,
        })),
      );
    }
  }
  return {
    site: home.site,
    seo: page.seo,
    url: page.path,
    categories: home.categories,
    tags,
  };
}
