import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildSiteModel,
  resolveSeo,
  seoPageTypeForPath,
  SEO_PAGE_TITLES,
  ContentValidationError,
  type Diagnostic,
} from '@foliohaven/core';
import {
  validateFixedPageEntries,
  ContentSourceError,
} from '@foliohaven/core/node';
import {
  fixedPages,
  pageSchemas,
  type RenderContextIndex,
} from '@foliohaven/site/registry';
import { FileRepository } from '../../files/repository.js';
import {
  privateDirectoryName,
  safeMkdir,
  safePath,
  RepositoryError,
} from '../../files/io.js';
import { MediaService } from '../../media/service.js';
import { MediaError } from '../../media/errors.js';
import type { PreparedRenderContext, RenderContextOptions } from './types.js';

export class RenderError extends RepositoryError {
  readonly diagnostics: readonly Diagnostic[];
  constructor(
    code: string,
    message: string,
    diagnostics: readonly Diagnostic[] = [],
  ) {
    super(code, message, 422);
    this.name = 'RenderError';
    this.diagnostics = diagnostics;
  }
}
async function jsonFile(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
}

/** 只讀傳入工作區；正式呼叫端必須傳job的不可變snapshot。 */
export async function prepareRenderContext(
  options: RenderContextOptions,
): Promise<PreparedRenderContext> {
  try {
    return await prepareRenderContextInternal(options);
  } catch (error) {
    if (
      error instanceof ContentSourceError ||
      error instanceof ContentValidationError
    )
      throw new RenderError(
        error.code,
        '來源資料驗證失敗，請依診斷修正。',
        error.diagnostics,
      );
    if (error instanceof MediaError)
      throw new RenderError(error.code, '媒體處理失敗，請檢查來源與媒體規格。');
    throw error;
  }
}
async function prepareRenderContextInternal(
  options: RenderContextOptions,
): Promise<PreparedRenderContext> {
  const root = resolve(options.repositoryRoot);
  const directory = resolve(options.contextDirectory);
  const resource = relative(root, directory);
  if (
    !resource.startsWith(`${privateDirectoryName(root)}/`) ||
    resource.split('/').some((part) => part === '..' || part === '')
  )
    throw new RenderError(
      'RENDER_CONTEXT_LOCATION_INVALID',
      '呈現資料必須位於本工作區私有目錄。',
    );
  if (options.signal?.aborted)
    throw new RenderError('BUILD_CANCELLED', '建置已取消。');
  const repository = new FileRepository({ repositoryRoot: root, pageSchemas });
  const { sources, pages } = await repository.withBuildInputLock(
    async (session) => ({
      sources: await session.loadContent({ mode: 'public' }),
      pages: await validateFixedPageEntries(root, fixedPages),
    }),
    options.signal ? { signal: options.signal } : {},
  );
  const input = {
    site: sources.site,
    categories: sources.categories,
    tags: sources.tags,
    articles: sources.articles,
    fixedPages: pages,
  };
  const mediaRefs = buildSiteModel(input).mediaRefs;
  const mediaService = new MediaService({
    repositoryRoot: root,
    repository,
    fixedPages: pages,
    ...(options.coordinationRoot === undefined
      ? {}
      : { coordinationRoot: options.coordinationRoot }),
  });
  const manifest = await mediaService.processReferences(
    mediaRefs,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  const model = buildSiteModel({ ...input, mediaManifest: manifest });
  if (model.mediaPending)
    throw new RenderError('MEDIA_PROCESSING_PENDING', '媒體處理尚未完成。');
  await safeMkdir(root, resource);
  await safeMkdir(root, `${resource}/generations`);
  const generation = randomUUID();
  const staging = await safePath(root, `${resource}/pending-${randomUUID()}`);
  const immutable = await safePath(
    root,
    `${resource}/generations/${generation}`,
  );
  const pendingIndex = await safePath(
    root,
    `${resource}/index-pending-${randomUUID()}.json`,
  );
  let generationReady = false;
  let published = false;
  await mkdir(staging, { mode: 0o700 });
  try {
    await mkdir(resolve(staging, 'articles'), { mode: 0o700 });
    await mkdir(resolve(staging, 'lists'), { mode: 0o700 });
    await mkdir(resolve(staging, 'pages'), { mode: 0o700 });
    const articles: RenderContextIndex['articles'][number][] = [];
    for (const article of model.articlePages) {
      const file = `articles/${article.articleId}.json`;
      await jsonFile(resolve(staging, file), article);
      articles.push({
        id: article.articleId,
        url: article.url,
        file,
        title: article.meta.title,
        description: article.description,
        publishedAt: article.meta.publishedAt,
        updatedAt: article.meta.updatedAt,
      });
    }
    const lists: RenderContextIndex['lists'][number][] = [];
    for (const [index, page] of model.listPages.entries()) {
      const file = `lists/list-${index}.json`;
      await jsonFile(resolve(staging, file), page);
      lists.push({ kind: page.kind, url: page.url, file });
    }
    const pageFiles: Record<string, string> = {};
    for (const [id, data] of Object.entries(sources.pages)) {
      const file = `pages/${id}.json`;
      await jsonFile(resolve(staging, file), data);
      pageFiles[id] = file;
    }
    const index: RenderContextIndex = {
      schemaVersion: 1,
      status: 'valid',
      generation,
      site: model.site,
      routeManifest: model.routeManifest,
      mediaManifest: manifest,
      articles,
      lists,
      pages: pageFiles,
      fixedPages: pages.map((page) => {
        const pageType = seoPageTypeForPath(page.path);
        const seoInput = {
          site: model.site,
          title: pageType === undefined ? page.id : SEO_PAGE_TITLES[pageType],
          path: page.path,
          seo: page.seo,
          ...(pageType === undefined ? {} : { pageType }),
        };
        return {
          id: page.id,
          path: page.path,
          seo:
            page.path === '/'
              ? model.home.seo
              : page.path === '/articles/'
                ? (model.listPages.find((item) => item.kind === 'articles')
                    ?.seo ?? resolveSeo(seoInput))
                : resolveSeo(seoInput),
        };
      }),
    };
    await jsonFile(resolve(staging, 'home.json'), model.home);
    await jsonFile(resolve(staging, 'search-index.json'), model.searchIndex);
    await jsonFile(resolve(staging, 'index.json'), index);
    await jsonFile(pendingIndex, index);
    // Readers pin this immutable directory. Keep every published generation
    // until a cold dev-session start or the owning build snapshot is removed.
    await rename(staging, immutable);
    generationReady = true;
    if (options.signal?.aborted)
      throw new RenderError('BUILD_CANCELLED', '建置已取消。');
    await rename(pendingIndex, await safePath(root, `${resource}/index.json`));
    published = true;
    return {
      model,
      manifest,
      contextDirectory: directory,
      mediaService,
      fixedPageSeos: Object.fromEntries(
        index.fixedPages.map((page) => [page.path, page.seo]),
      ),
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rm(pendingIndex, { force: true });
    if (generationReady && !published)
      await rm(immutable, { recursive: true, force: true });
    throw error;
  }
}

/** 開發來源失效時明確覆寫狀態，不繼續展示先前成功內容。 */
export async function invalidateRenderContext(
  repositoryRoot: string,
  contextDirectory: string,
): Promise<void> {
  const root = resolve(repositoryRoot);
  const directory = resolve(contextDirectory);
  const resource = relative(root, directory);
  if (
    !resource.startsWith(`${privateDirectoryName(root)}/`) ||
    resource.split('/').some((part) => part === '..' || part === '')
  )
    throw new RenderError(
      'RENDER_CONTEXT_LOCATION_INVALID',
      '呈現資料位置無效。',
    );
  await safeMkdir(root, resource);
  const temporary = await safePath(
    root,
    `${resource}/invalid-${randomUUID()}.json`,
  );
  await jsonFile(temporary, {
    schemaVersion: 1,
    status: 'invalid',
    code: 'SOURCE_VALIDATION_FAILED',
  });
  await rename(temporary, await safePath(root, `${resource}/index.json`));
}
