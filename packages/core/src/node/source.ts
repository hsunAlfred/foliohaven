import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import type { z } from 'zod';
import { CONTENT_LIMITS } from '../schemas/common.js';
import {
  ArticleMetaSchema,
  CategoriesSchema,
  SiteConfigSchema,
  TagsSchema,
} from '../schemas/content.js';
import type {
  Article,
  Category,
  Diagnostic,
  JsonValue,
  SiteConfig,
  Tag,
} from '../models/index.js';

export const SOURCE_LIMITS = Object.freeze({
  articleMetadata: CONTENT_LIMITS.articleMetaBytes,
  articleHtml: CONTENT_LIMITS.articleHtmlBytes,
  site: CONTENT_LIMITS.siteBytes,
  taxonomy: CONTENT_LIMITS.taxonomyBytes,
  page: CONTENT_LIMITS.pageBytes,
  articleCount: CONTENT_LIMITS.articleCount,
  publishedHtmlTotal: CONTENT_LIMITS.publishedHtmlBytes,
  concurrency: CONTENT_LIMITS.loaderConcurrency,
});

export class ContentSourceError extends Error {
  readonly code: string;
  readonly diagnostics: readonly Diagnostic[];
  constructor(
    code: string,
    message: string,
    resource: string,
    diagnostics?: readonly Diagnostic[],
  ) {
    super(message);
    this.name = 'ContentSourceError';
    this.code = code;
    this.diagnostics = diagnostics ?? [
      { severity: 'error', code, message, resource },
    ];
  }
}

export function sourcePath(root: string, resource: string): string {
  if (
    resource.includes('\\') ||
    resource.includes('\0') ||
    isAbsolute(resource) ||
    resource
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new ContentSourceError(
      'INVALID_SOURCE_PATH',
      '來源路徑不符合安全規則。',
      'source',
    );
  }
  const target = resolve(root, resource);
  const within = relative(resolve(root), target);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new ContentSourceError(
      'INVALID_SOURCE_PATH',
      '來源路徑超出工作區。',
      'source',
    );
  }
  return target;
}

async function safeTarget(root: string, resource: string): Promise<string> {
  const target = sourcePath(root, resource);
  let current = resolve(root);
  const rootStat = await lstat(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ContentSourceError(
      'INVALID_SOURCE_ROOT',
      '來源工作區必須是一般目錄。',
      'source',
    );
  }
  for (const part of resource.split('/')) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new ContentSourceError(
        'SOURCE_SYMLINK',
        '來源不得使用符號連結。',
        resource,
      );
    }
  }
  const resolved = await realpath(target);
  const within = relative(await realpath(root), resolved);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new ContentSourceError(
      'INVALID_SOURCE_PATH',
      '來源路徑超出工作區。',
      resource,
    );
  }
  return target;
}

function ioError(error: unknown, resource: string): ContentSourceError {
  if (error instanceof ContentSourceError) return error;
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? error.code
      : null;
  return new ContentSourceError(
    code === 'ENOENT' ? 'SOURCE_NOT_FOUND' : 'SOURCE_UNREADABLE',
    code === 'ENOENT'
      ? '缺少必要的來源檔案或目錄。'
      : '無法安全讀取來源，請檢查檔案與權限。',
    resource,
  );
}

export async function readSourceBytes(
  root: string,
  resource: string,
  maxBytes: number,
): Promise<Buffer> {
  let handle;
  try {
    const target = await safeTarget(root, resource);
    handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new ContentSourceError(
        'SOURCE_NOT_FILE',
        '來源必須是一般檔案。',
        resource,
      );
    if (stat.size > maxBytes)
      throw new ContentSourceError(
        'SOURCE_TOO_LARGE',
        '來源檔案超過允許大小。',
        resource,
      );
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length);
      if (bytesRead === 0) break;
      size += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (size > maxBytes)
      throw new ContentSourceError(
        'SOURCE_TOO_LARGE',
        '來源檔案超過允許大小。',
        resource,
      );
    return Buffer.concat(chunks, size);
  } catch (error) {
    throw ioError(error, resource);
  } finally {
    await handle?.close();
  }
}

export async function readSourceText(
  root: string,
  resource: string,
  maxBytes: number,
): Promise<string> {
  const bytes = await readSourceBytes(root, resource, maxBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ContentSourceError(
      'INVALID_UTF8',
      '來源必須使用有效的 UTF-8 編碼。',
      resource,
    );
  }
}

export async function readSourceJson(
  root: string,
  resource: string,
  maxBytes: number,
): Promise<unknown> {
  const text = await readSourceText(root, resource, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ContentSourceError(
      'INVALID_JSON',
      'JSON 格式錯誤，請修正來源檔案。',
      resource,
    );
  }
}

function parseSource<T>(
  schema: z.ZodType<T>,
  value: unknown,
  resource: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ContentSourceError(
      'INVALID_SOURCE_DATA',
      '來源資料不符合共用 Schema，請檢查欄位及格式。',
      resource,
      parsed.error.issues.map((issue) => ({
        severity: 'error',
        code: 'INVALID_SOURCE_DATA',
        message: '來源欄位不符合共用 Schema。',
        resource,
        ...(issue.path.length > 0
          ? { field: issue.path.map(String).join('.') }
          : {}),
      })),
    );
  }
  return parsed.data;
}

export interface ContentSources {
  readonly site: SiteConfig;
  readonly categories: readonly Category[];
  readonly tags: readonly Tag[];
  readonly articles: readonly Article[];
  readonly pages: Readonly<Record<string, JsonValue>>;
}
export interface LoadContentOptions {
  readonly mode?: 'public' | 'preview';
  readonly pageSchemas?: Readonly<Record<string, z.ZodType<JsonValue>>>;
}

export async function readSourceDirectory(root: string, resource: string) {
  try {
    return await readdir(await safeTarget(root, resource), {
      withFileTypes: true,
    });
  } catch (error) {
    throw ioError(error, resource);
  }
}

/** 只讀取指定來源；不改寫日期、作者正文或任何 metadata。 */
export async function loadContent(
  root: string,
  options: LoadContentOptions = {},
): Promise<ContentSources> {
  const site = parseSource(
    SiteConfigSchema,
    await readSourceJson(root, 'content/site.json', SOURCE_LIMITS.site),
    'content/site.json',
  );
  const categories = parseSource(
    CategoriesSchema,
    await readSourceJson(
      root,
      'content/categories.json',
      SOURCE_LIMITS.taxonomy,
    ),
    'content/categories.json',
  );
  const tags = parseSource(
    TagsSchema,
    await readSourceJson(root, 'content/tags.json', SOURCE_LIMITS.taxonomy),
    'content/tags.json',
  );
  const entries = (await readSourceDirectory(root, 'content/articles'))
    .filter((entry) => entry.name !== '.gitkeep')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (entries.length > SOURCE_LIMITS.articleCount)
    throw new ContentSourceError(
      'ARTICLE_LIMIT_EXCEEDED',
      '文章數量超過允許上限，未截斷來源。',
      'content/articles',
    );
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) ||
      entry.name.length > 80
    ) {
      throw new ContentSourceError(
        'INVALID_ARTICLE_DIRECTORY',
        '文章必須位於合法單層識別碼目錄，不能使用符號連結。',
        'content/articles',
      );
    }
  }
  let cursor = 0;
  let publishedBytes = 0;
  const result: (Article | null)[] = Array.from(
    { length: entries.length },
    () => null,
  );
  const loads = await Promise.allSettled(
    Array.from(
      { length: Math.min(SOURCE_LIMITS.concurrency, entries.length) },
      async () => {
        while (cursor < entries.length) {
          const index = cursor++;
          const entry = entries[index];
          if (!entry) continue;
          const base = `content/articles/${entry.name}`;
          const meta = parseSource(
            ArticleMetaSchema,
            await readSourceJson(
              root,
              `${base}/meta.json`,
              SOURCE_LIMITS.articleMetadata,
            ),
            `${base}/meta.json`,
          );
          // 正式載入已驗證 Draft 的 metadata，故壞 JSON／未知 status 不會被吞掉。
          if (meta.status === 'draft' && options.mode !== 'preview') continue;
          const contentHtml = await readSourceText(
            root,
            `${base}/content.html`,
            SOURCE_LIMITS.articleHtml,
          );
          if (contentHtml.includes('\0'))
            throw new ContentSourceError(
              'INVALID_HTML_TEXT',
              '正文不可含 NUL。',
              `${base}/content.html`,
            );
          if (contentHtml.includes('\r'))
            throw new ContentSourceError(
              'HTML_REQUIRES_LF',
              '正文請使用 LF 換行，系統不自動改寫原文。',
              `${base}/content.html`,
            );
          if (meta.status === 'published') {
            publishedBytes += Buffer.byteLength(contentHtml);
            if (publishedBytes > SOURCE_LIMITS.publishedHtmlTotal)
              throw new ContentSourceError(
                'PUBLISHED_HTML_LIMIT_EXCEEDED',
                '已發布正文總量超過允許上限。',
                'content/articles',
              );
          }
          const nested = (await readSourceDirectory(root, base)).filter(
            (child) => child.name !== '.gitkeep',
          );
          if (
            nested.some(
              (child) =>
                !['meta.json', 'content.html'].includes(child.name) ||
                !child.isFile() ||
                child.isSymbolicLink(),
            )
          ) {
            throw new ContentSourceError(
              'INVALID_ARTICLE_FILE',
              '文章目錄只能包含一般 content.html 與 meta.json 檔案。',
              base,
            );
          }
          result[index] = { articleId: entry.name, meta, contentHtml };
        }
      },
    ),
  );
  for (const load of loads) if (load.status === 'rejected') throw load.reason;
  const pages: Record<string, JsonValue> = {};
  let pageEntries: Awaited<ReturnType<typeof readSourceDirectory>>;
  try {
    pageEntries = await readSourceDirectory(root, 'content/pages');
  } catch (error) {
    if (
      !(error instanceof ContentSourceError) ||
      error.code !== 'SOURCE_NOT_FOUND'
    )
      throw error;
    pageEntries = [];
  }
  for (const entry of pageEntries) {
    if (entry.name === '.gitkeep') continue;
    const pageId = entry.name.replace(/\.json$/, '');
    const schema =
      options.pageSchemas && Object.hasOwn(options.pageSchemas, pageId)
        ? options.pageSchemas[pageId]
        : undefined;
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(entry.name) ||
      !schema
    ) {
      throw new ContentSourceError(
        'UNREGISTERED_PAGE_DATA',
        '獨立頁面設定必須有對應的 strict Schema 與合法 JSON 檔名。',
        'content/pages',
      );
    }
    pages[pageId] = parseSource(
      schema,
      await readSourceJson(
        root,
        `content/pages/${entry.name}`,
        SOURCE_LIMITS.page,
      ),
      `content/pages/${entry.name}`,
    );
  }
  return {
    site,
    categories,
    tags,
    articles: result.filter((article): article is Article => article !== null),
    pages,
  };
}
