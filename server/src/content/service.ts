import { randomUUID } from 'node:crypto';
import {
  ArticleIdSchema,
  ArticleMetaSchema,
  ArticleResourceSchema,
  ArticleWriteSchema,
  ArticleListQuerySchema,
  ArticleOptionsQuerySchema,
  ArticleOptionsSchema,
  CategoriesSchema,
  TagsSchema,
  SiteConfigSchema,
  TaxonomySchema,
  PublicationUpdateSchema,
  TaxonomyMigrationRequestSchema,
  UuidSchema,
  CONTENT_LIMITS,
  ContentValidationError,
  analyzeHtml,
  buildSiteModel,
  filterArticles,
  planTaxonomyMigration,
  previewArticle,
  scanTaxonomyReferences,
  toUtcDateTime,
} from '@foliohaven/core';
import type {
  Article,
  ArticleResource,
  ArticleOption,
  ArticleOptions,
  ArticleWrite,
  JsonValue,
  Diagnostic,
  MediaManifest,
  SiteConfig,
  Taxonomy,
  TaxonomyMigrationPlan,
  TaxonomyResult,
} from '@foliohaven/core';
import type { ContentSources } from '@foliohaven/core/node';
import { etagForResources, RepositoryError } from '../files/index.js';
import { representationEtag } from '../files/io.js';
import type {
  CommitResult,
  FileChange,
  RawResource,
  ReadSession,
} from '../files/types.js';
import { ContentServiceError, parseContract, sourceError } from './errors.js';
import type {
  ArticleList,
  ContentServiceOptions,
  MigrationDescriptor,
  MigrationExecution,
  MigrationExecutionResult,
  MutationOptions,
  StoredMigrationPlan,
  Versioned,
} from './types.js';

const taxonomyKeys = ['content/categories.json', 'content/tags.json'] as const;
const siteKey = 'content/site.json';
function articleKeys(id: string): readonly [string, string] {
  parseContract(ArticleIdSchema, id);
  return [
    `content/articles/${id}/content.html`,
    `content/articles/${id}/meta.json`,
  ];
}
function jsonBytes(value: unknown, resourceKey: string): Buffer {
  const limit =
    resourceKey === siteKey
      ? CONTENT_LIMITS.siteBytes
      : taxonomyKeys.some((key) => key === resourceKey)
        ? CONTENT_LIMITS.taxonomyBytes
        : resourceKey.startsWith('content/pages/')
          ? CONTENT_LIMITS.pageBytes
          : CONTENT_LIMITS.articleMetaBytes;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > limit)
    throw new ContentServiceError(
      'SOURCE_TOO_LARGE',
      '保存後的 JSON 超過此資源 UTF-8 容量上限，來源未變更。',
      413,
      [
        {
          severity: 'error',
          code: 'SOURCE_TOO_LARGE',
          message: `JSON 大小 ${bytes.byteLength} bytes 超過 ${limit} bytes 上限。`,
          resource: resourceKey,
        },
      ],
    );
  return bytes;
}
function text(raw: RawResource, maxBytes: number, resource: string): string {
  if (raw.bytes.byteLength > maxBytes)
    throw new ContentServiceError(
      'SOURCE_TOO_LARGE',
      '來源超過允許大小；原始檔案已保留。',
      422,
      [
        {
          severity: 'error',
          code: 'SOURCE_TOO_LARGE',
          message: '來源檔案超過安全容量。',
          resource,
        },
      ],
    );
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      raw.bytes,
    );
  } catch {
    throw new ContentServiceError(
      'INVALID_UTF8',
      '來源不是有效 UTF-8；原始檔案已保留。',
      422,
      [
        {
          severity: 'error',
          code: 'INVALID_UTF8',
          message: '請修正來源文字編碼。',
          resource,
        },
      ],
    );
  }
}
function json(raw: RawResource, maxBytes: number, resource: string): unknown {
  const value = text(raw, maxBytes, resource);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ContentServiceError(
      'INVALID_JSON',
      'JSON 格式錯誤；原始檔案已保留。',
      422,
      [
        {
          severity: 'error',
          code: 'INVALID_JSON',
          message: '請修正來源 JSON 語法。',
          resource,
        },
      ],
    );
  }
}
async function required(
  session: ReadSession,
  key: string,
  article = false,
): Promise<RawResource> {
  const raw = await session.read(key);
  if (raw === null)
    throw new ContentServiceError(
      article ? 'ARTICLE_NOT_FOUND' : 'SOURCE_MISSING',
      article ? '文章不存在或來源檔案不完整。' : '必要來源檔案不存在。',
      article ? 404 : 422,
      [
        {
          severity: 'error',
          code: 'SOURCE_MISSING',
          message: '必要來源檔案不存在。',
          resource: key,
        },
      ],
    );
  return raw;
}
function apiArticle(
  article: Article,
  diagnostics: readonly Diagnostic[],
): ArticleResource {
  return parseContract(ArticleResourceSchema, {
    id: article.articleId,
    contentHtml: article.contentHtml,
    meta: {
      ...article.meta,
      publishedAt:
        article.meta.publishedAt === null
          ? null
          : toUtcDateTime(article.meta.publishedAt),
      updatedAt:
        article.meta.updatedAt === null
          ? null
          : toUtcDateTime(article.meta.updatedAt),
    },
    diagnostics: [...diagnostics],
  });
}
function replayJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(replayJson);
  if (typeof value === 'object' && value !== null) {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) result[key] = replayJson(item);
    return result;
  }
  throw new ContentServiceError(
    'INVALID_OPERATION_RESPONSE',
    '冪等操作結果無法安全保存。',
    500,
  );
}
function validationFailure(
  diagnostics: readonly Diagnostic[],
): ContentServiceError {
  return new ContentServiceError(
    'VALIDATION_FAILED',
    '候選資料未符合完整內容、路由或媒體規則。',
    422,
    diagnostics,
  );
}
function referenceFailure(
  kind: 'category' | 'tag',
  key: string,
  references: ReturnType<typeof scanTaxonomyReferences>,
): ContentServiceError {
  const label = kind === 'category' ? '分類' : 'Tag';
  return new ContentServiceError(
    'TAXONOMY_IN_USE',
    `${label} ${key} 仍有 ${references.articleCount} 篇文章、${references.childCategoryPaths.length} 個子分類及 ${references.navigationReferences.length} 個導覽引用。`,
    409,
    references.articleIds.map((articleId) => ({
      severity: 'error',
      code: 'TAXONOMY_IN_USE',
      message: `文章仍引用此${label}。`,
      articleId,
    })),
    [
      ...references.articleIds.map((articleId) => ({
        path: ['articles', articleId],
        code: 'ARTICLE_REFERENCE',
        message: `文章 ${articleId} 仍在引用。`,
      })),
      ...references.childCategoryPaths.map((path) => ({
        path: ['categories', path],
        code: 'CHILD_CATEGORY_REFERENCE',
        message: `子分類 ${path} 仍存在。`,
      })),
      ...references.navigationReferences.map((index) => ({
        path: ['site', 'navigation', index],
        code: 'NAVIGATION_REFERENCE',
        message: `第 ${index + 1} 個導覽仍在引用。`,
      })),
    ],
  );
}
function deduplicate(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/** A missing/ambiguous owner is global and can never exempt a published write. */
function diagnosticArticleId(diagnostic: Diagnostic): string | undefined {
  const resourceId = /^content\/articles\/([a-z0-9-]+)\//u.exec(
    diagnostic.resource ?? '',
  )?.[1];
  if (
    diagnostic.articleId !== undefined &&
    resourceId !== undefined &&
    diagnostic.articleId !== resourceId
  )
    return undefined;
  return diagnostic.articleId ?? resourceId;
}
/** Include the complete diagnostic and multiplicity, rather than code alone. */
function diagnosticIdentity(diagnostic: Diagnostic): string {
  return JSON.stringify([
    diagnostic.severity,
    diagnostic.code,
    diagnostic.message,
    diagnostic.articleId ?? null,
    diagnostic.resource ?? null,
    diagnostic.field ?? null,
    diagnostic.line ?? null,
    diagnostic.column ?? null,
  ]);
}

export class ContentService {
  readonly #options: ContentServiceOptions;
  readonly #plans = new Map<string, StoredMigrationPlan>();
  constructor(options: ContentServiceOptions) {
    this.#options = options;
  }
  #now(): Date {
    return this.#options.clock?.() ?? new Date();
  }
  async #context(session: ReadSession): Promise<ContentSources> {
    try {
      return await session.loadContent({ mode: 'preview' });
    } catch (error) {
      return sourceError(error);
    }
  }
  async #manifest(session: ReadSession): Promise<MediaManifest | undefined> {
    return this.#options.getMediaManifest?.(session);
  }
  async #readArticle(session: ReadSession, id: string): Promise<Article> {
    const [htmlKey, metaKey] = articleKeys(id);
    const [html, meta] = await Promise.all([
      session.read(htmlKey),
      session.read(metaKey),
    ]);
    if (html === null && meta === null)
      throw new ContentServiceError('ARTICLE_NOT_FOUND', '文章不存在。', 404);
    if (html === null || meta === null) {
      const missingKey = html === null ? htmlKey : metaKey;
      throw new ContentServiceError(
        'SOURCE_INCOMPLETE',
        '文章來源不完整；請修正缺少的配對檔案，現有資料已保留。',
        422,
        [
          {
            severity: 'error',
            code: 'SOURCE_INCOMPLETE',
            message: '文章必須同時有 content.html 與 meta.json。',
            resource: missingKey,
            articleId: id,
          },
        ],
        [],
        await session.etag(articleKeys(id)),
      );
    }
    return {
      articleId: id,
      contentHtml: text(html, CONTENT_LIMITS.articleHtmlBytes, htmlKey),
      meta: parseContract(
        ArticleMetaSchema,
        json(meta, CONTENT_LIMITS.articleMetaBytes, metaKey),
        metaKey,
      ),
    };
  }
  #model(context: ContentSources, manifest: MediaManifest | undefined) {
    try {
      const model = buildSiteModel({
        ...context,
        fixedPages: this.#options.fixedPages,
        ...(manifest === undefined ? {} : { mediaManifest: manifest }),
        now: this.#now().toISOString(),
        ...(this.#options.htmlCache
          ? { htmlCache: this.#options.htmlCache }
          : {}),
      });
      if (model.mediaPending)
        throw validationFailure([
          {
            severity: 'error',
            code: 'MEDIA_VALIDATION_PENDING',
            message: '受管媒體尚未完成處理及驗證。',
          },
        ]);
      return model;
    } catch (error) {
      if (error instanceof ContentValidationError)
        throw validationFailure(error.diagnostics);
      throw error;
    }
  }
  #modelDiagnostics(
    context: ContentSources,
    manifest: MediaManifest | undefined,
  ): readonly Diagnostic[] {
    try {
      return this.#model(context, manifest).diagnostics;
    } catch (error) {
      // Only Core semantic failures are recoverable management data. Structural
      // source/IO failures occur before this call and must remain hard failures.
      if (
        error instanceof ContentServiceError &&
        error.code === 'VALIDATION_FAILED' &&
        error.diagnostics.length > 0
      )
        return error.diagnostics;
      throw error;
    }
  }
  #validatePublishedReplacement(
    context: ContentSources,
    article: Article,
    manifest: MediaManifest | undefined,
  ): void {
    const previous = this.#modelDiagnostics(context, manifest);
    const next = this.#modelDiagnostics(
      {
        ...context,
        articles: [
          ...context.articles.filter(
            (item) => item.articleId !== article.articleId,
          ),
          article,
        ],
      },
      manifest,
    );
    const unchangedOtherErrors = new Map<string, number>();
    for (const diagnostic of previous) {
      const owner = diagnosticArticleId(diagnostic);
      if (
        diagnostic.severity !== 'error' ||
        owner === undefined ||
        owner === article.articleId
      )
        continue;
      const identity = diagnosticIdentity(diagnostic);
      unchangedOtherErrors.set(
        identity,
        (unchangedOtherErrors.get(identity) ?? 0) + 1,
      );
    }
    const rejected = next.filter((diagnostic) => {
      if (diagnostic.severity !== 'error') return false;
      const owner = diagnosticArticleId(diagnostic);
      if (owner === undefined || owner === article.articleId) return true;
      const identity = diagnosticIdentity(diagnostic);
      const remaining = unchangedOtherErrors.get(identity) ?? 0;
      if (remaining === 0) return true;
      unchangedOtherErrors.set(identity, remaining - 1);
      return false;
    });
    if (rejected.length > 0) throw validationFailure(rejected);
  }
  async #diagnostics(
    session: ReadSession,
    article: Article,
  ): Promise<readonly Diagnostic[]> {
    try {
      const context = await this.#context(session);
      const manifest = await this.#manifest(session);
      return previewArticle({
        ...context,
        fixedPages: this.#options.fixedPages,
        article,
        ...(manifest === undefined ? {} : { mediaManifest: manifest }),
        now: this.#now().toISOString(),
        ...(this.#options.htmlCache
          ? { htmlCache: this.#options.htmlCache }
          : {}),
      }).diagnostics;
    } catch (error) {
      if (error instanceof ContentServiceError) return error.diagnostics;
      if (error instanceof ContentValidationError) return error.diagnostics;
      throw error;
    }
  }
  async #articleRepresentation(
    session: ReadSession,
    id: string,
    rawEtag?: string,
  ): Promise<Versioned<ArticleResource>> {
    const article = await this.#readArticle(session, id);
    const value = apiArticle(
      article,
      await this.#diagnostics(session, article),
    );
    return {
      value,
      etag: representationEtag(
        rawEtag ?? (await session.etag(articleKeys(id))),
        value,
      ),
    };
  }
  async getArticle(id: string): Promise<Versioned<ArticleResource>> {
    return this.#options.repository.withConsistentRead((session) =>
      this.#articleRepresentation(session, id),
    );
  }
  async listArticles(rawQuery: unknown = {}): Promise<ArticleList> {
    const query = parseContract(ArticleListQuerySchema, rawQuery);
    return this.#options.repository.withConsistentRead(async (session) => {
      const context = await this.#context(session);
      const manifest = await this.#manifest(session);
      const diagnostics = this.#modelDiagnostics(context, manifest);
      const selection = filterArticles(context.articles, query, context);
      return {
        items: selection.items.map((article) =>
          apiArticle(
            article,
            deduplicate([
              ...analyzeHtml(article.contentHtml, {
                articleId: article.articleId,
                mode: article.meta.status === 'draft' ? 'draft' : 'published',
              }).diagnostics,
              ...diagnostics.filter(
                (diagnostic) =>
                  diagnosticArticleId(diagnostic) === undefined ||
                  diagnosticArticleId(diagnostic) === article.articleId,
              ),
            ]),
          ),
        ),
        total: selection.total,
        page: selection.page,
        pageSize: selection.pageSize,
      };
    });
  }
  async listArticleOptions(rawQuery: unknown = {}): Promise<ArticleOptions> {
    const query = parseContract(ArticleOptionsQuerySchema, rawQuery);
    return this.#options.repository.withConsistentRead(async (session) => {
      const context = await this.#context(session);
      const selection = filterArticles(context.articles, query, context);
      const option = (article: Article): ArticleOption => ({
        id: article.articleId,
        title: article.meta.title,
        status: article.meta.status,
      });
      const byId = new Map(
        context.articles.map((article) => [article.articleId, article]),
      );
      return parseContract(ArticleOptionsSchema, {
        items: selection.items.map(option),
        selected: query.selected.flatMap((id) => {
          const article = byId.get(id);
          return article === undefined ? [] : [option(article)];
        }),
        total: selection.total,
        page: selection.page,
        pageSize: selection.pageSize,
      });
    });
  }
  async createArticle(
    payload: unknown,
    options: MutationOptions = {},
  ): Promise<Versioned<ArticleResource>> {
    const candidate = parseContract(ArticleWriteSchema, payload);
    if (candidate.meta.status !== 'draft')
      throw new ContentServiceError(
        'INITIAL_STATUS_MUST_BE_DRAFT',
        '新文章必須先以草稿建立。',
      );
    const id = `article-${randomUUID()}`;
    const keys = articleKeys(id);
    const article: Article = { articleId: id, ...candidate };
    const htmlBytes = Buffer.from(candidate.contentHtml, 'utf8');
    const metadataBytes = jsonBytes(candidate.meta, keys[1]);
    const rawEtag = etagForResources([
      { resourceKey: keys[0], bytes: htmlBytes },
      { resourceKey: keys[1], bytes: metadataBytes },
    ]);
    let etag = representationEtag(rawEtag, apiArticle(article, []));
    const resourceUrl = `/api/v1/articles/${id}`;
    const operation =
      options.operation === undefined
        ? undefined
        : {
            ...options.operation,
            httpStatus: 201,
            resourceUrl,
            response: replayJson(apiArticle(article, [])),
            headers: { ETag: etag, Location: resourceUrl },
          };
    let diagnostics: readonly Diagnostic[] = [];
    const result = await this.#options.repository.commit({
      kind: 'create',
      changes: [
        { resourceKey: keys[0], expectedRevision: null, content: htmlBytes },
        {
          resourceKey: keys[1],
          expectedRevision: null,
          content: metadataBytes,
        },
      ],
      ...(operation === undefined ? {} : { operation }),
      validate: async (session) => {
        if (
          (await session.listArticleIds()).length >= CONTENT_LIMITS.articleCount
        )
          throw new ContentServiceError(
            'ARTICLE_CAPACITY_EXCEEDED',
            '文章已達 10,000 件安全上限，未新增任何來源。',
            422,
            [
              {
                severity: 'error',
                code: 'ARTICLE_CAPACITY_EXCEEDED',
                message: '請先移除不需要的文章，或正式調整已驗證的容量限制。',
                resource: 'content/articles',
              },
            ],
          );
        diagnostics = await this.#diagnostics(session, article);
        etag = representationEtag(rawEtag, apiArticle(article, diagnostics));
        if (operation !== undefined) {
          operation.response = replayJson(apiArticle(article, diagnostics));
          operation.headers.ETag = etag;
        }
      },
    });
    return {
      value: apiArticle(article, diagnostics),
      etag,
      transactionId: result.transactionId,
    };
  }
  async #replace(
    id: string,
    transform: (current: Article) => ArticleWrite,
    ifMatch: string | undefined,
    options: MutationOptions,
  ): Promise<Versioned<ArticleResource>> {
    const keys = articleKeys(id);
    const current = await this.#options.repository.withConsistentRead(
      async (session) => ({
        article: await this.#readArticle(session, id),
        html: await required(session, keys[0], true),
        meta: await required(session, keys[1], true),
      }),
    );
    const candidate = parseContract(
      ArticleWriteSchema,
      transform(current.article),
    );
    const article: Article = { articleId: id, ...candidate };
    const htmlBytes = Buffer.from(candidate.contentHtml, 'utf8');
    const metadataBytes = jsonBytes(candidate.meta, keys[1]);
    const candidateRawEtag = etagForResources([
      { resourceKey: keys[0], bytes: htmlBytes },
      { resourceKey: keys[1], bytes: metadataBytes },
    ]);
    let diagnostics: readonly Diagnostic[] = [];
    const result = await this.#options.repository.commit({
      kind: 'save',
      changes: [
        {
          resourceKey: keys[0],
          expectedRevision: current.html.revision,
          content: htmlBytes,
        },
        {
          resourceKey: keys[1],
          expectedRevision: current.meta.revision,
          content: metadataBytes,
        },
      ],
      precondition: {
        ifMatch,
        resourceKeys: keys,
        representationEtag: async (session, raw) =>
          (await this.#articleRepresentation(session, id, raw)).etag,
      },
      ...(options.operation === undefined
        ? {}
        : { operation: options.operation }),
      validate: async (session) => {
        if (candidate.meta.status === 'published') {
          const context = await this.#context(session);
          this.#validatePublishedReplacement(
            context,
            article,
            await this.#manifest(session),
          );
        }
        diagnostics = await this.#diagnostics(session, article);
      },
    });
    return {
      value: apiArticle(article, diagnostics),
      etag: representationEtag(
        candidateRawEtag,
        apiArticle(article, diagnostics),
      ),
      transactionId: result.transactionId,
    };
  }
  async putArticle(
    id: string,
    payload: unknown,
    ifMatch: string | undefined,
    options: MutationOptions = {},
  ): Promise<Versioned<ArticleResource>> {
    const candidate = parseContract(ArticleWriteSchema, payload);
    return this.#replace(id, () => candidate, ifMatch, options);
  }
  async patchPublication(
    id: string,
    payload: unknown,
    ifMatch: string | undefined,
    options: MutationOptions = {},
  ): Promise<Versioned<ArticleResource>> {
    const publication = parseContract(PublicationUpdateSchema, payload);
    return this.#replace(
      id,
      (current) => ({
        contentHtml: current.contentHtml,
        meta: parseContract(ArticleMetaSchema, {
          ...current.meta,
          ...publication,
        }),
      }),
      ifMatch,
      options,
    );
  }
  async deleteArticle(
    id: string,
    ifMatch: string | undefined,
    options: MutationOptions = {},
  ): Promise<{ transactionId: string }> {
    const keys = articleKeys(id);
    const current = await this.#options.repository.withConsistentRead(
      async (session) => ({
        html: await required(session, keys[0], true),
        meta: await required(session, keys[1], true),
      }),
    );
    const result = await this.#options.repository.commit({
      kind: 'delete',
      changes: [
        {
          resourceKey: keys[0],
          expectedRevision: current.html.revision,
          content: null,
        },
        {
          resourceKey: keys[1],
          expectedRevision: current.meta.revision,
          content: null,
        },
      ],
      precondition: {
        ifMatch,
        resourceKeys: keys,
        representationEtag: async (session, raw) =>
          (await this.#articleRepresentation(session, id, raw)).etag,
      },
      trash: { kind: 'article', id },
      ...(options.operation === undefined
        ? {}
        : { operation: options.operation }),
      validate: async (session) => {
        const context = await this.#context(session);
        if (context.site.home.featuredArticleIds.includes(id))
          throw new ContentServiceError(
            'ARTICLE_IN_USE',
            '文章仍被首頁精選引用，請先調整全站設定。',
            409,
          );
        const relatedReferences = context.articles.filter(
          (article) =>
            article.articleId !== id &&
            article.meta.relatedReading.articleIds.includes(id),
        );
        if (relatedReferences.length > 0)
          throw new ContentServiceError(
            'ARTICLE_IN_USE',
            '文章仍被其他文章的延伸閱讀引用，請先移除引用。',
            409,
            relatedReferences.map((article) => ({
              severity: 'error',
              code: 'RELATED_ARTICLE_IN_USE',
              message: `文章 ${article.articleId} 的延伸閱讀仍引用此文章。`,
              articleId: article.articleId,
              resource: `content/articles/${article.articleId}/meta.json`,
              field: 'relatedReading.articleIds',
            })),
          );
        try {
          this.#model(
            {
              ...context,
              articles: context.articles.filter(
                (article) => article.articleId !== id,
              ),
            },
            await this.#manifest(session),
          );
        } catch (error) {
          if (error instanceof ContentServiceError)
            throw new ContentServiceError(
              'ARTICLE_IN_USE',
              '刪除後仍有站內引用或設定不完整，請先修正診斷。',
              409,
              error.diagnostics,
            );
          throw error;
        }
      },
    });
    return { transactionId: result.transactionId };
  }
  async getTaxonomy(): Promise<Versioned<Taxonomy>> {
    return this.#options.repository.withConsistentRead(async (session) => ({
      value: {
        categories: parseContract(
          CategoriesSchema,
          json(
            await required(session, taxonomyKeys[0]),
            CONTENT_LIMITS.taxonomyBytes,
            taxonomyKeys[0],
          ),
          taxonomyKeys[0],
        ),
        tags: parseContract(
          TagsSchema,
          json(
            await required(session, taxonomyKeys[1]),
            CONTENT_LIMITS.taxonomyBytes,
            taxonomyKeys[1],
          ),
          taxonomyKeys[1],
        ),
      },
      etag: await session.etag(taxonomyKeys),
    }));
  }
  async putTaxonomy(
    payload: unknown,
    ifMatch: string | undefined,
    options: MutationOptions = {},
  ): Promise<Versioned<Taxonomy>> {
    const candidate = parseContract(TaxonomySchema, payload);
    const current = await this.#options.repository.withConsistentRead(
      async (session) => ({
        categories: await required(session, taxonomyKeys[0]),
        tags: await required(session, taxonomyKeys[1]),
      }),
    );
    const result = await this.#options.repository.commit({
      kind: 'taxonomy',
      changes: [
        {
          resourceKey: taxonomyKeys[0],
          expectedRevision: current.categories.revision,
          content: jsonBytes(candidate.categories, taxonomyKeys[0]),
        },
        {
          resourceKey: taxonomyKeys[1],
          expectedRevision: current.tags.revision,
          content: jsonBytes(candidate.tags, taxonomyKeys[1]),
        },
      ],
      precondition: { ifMatch, resourceKeys: taxonomyKeys },
      ...(options.operation === undefined
        ? {}
        : { operation: options.operation }),
      validate: async (session) => {
        const context = await this.#context(session);
        for (const category of context.categories.filter(
          (item) =>
            !candidate.categories.some((next) => next.path === item.path),
        )) {
          const references = scanTaxonomyReferences({
            kind: 'category',
            key: category.path,
            articles: context.articles,
            categories: context.categories,
            site: context.site,
          });
          if (references.referenced)
            throw referenceFailure('category', category.path, references);
        }
        for (const tag of context.tags.filter(
          (item) => !candidate.tags.some((next) => next.slug === item.slug),
        )) {
          const references = scanTaxonomyReferences({
            kind: 'tag',
            key: tag.slug,
            articles: context.articles,
            categories: context.categories,
            site: context.site,
          });
          if (references.referenced)
            throw referenceFailure('tag', tag.slug, references);
        }
        this.#model(
          {
            ...context,
            categories: candidate.categories,
            tags: candidate.tags,
          },
          await this.#manifest(session),
        );
      },
    });
    return {
      value: candidate,
      etag: result.etag,
      transactionId: result.transactionId,
    };
  }
  async getSiteSettings(): Promise<Versioned<SiteConfig>> {
    return this.#options.repository.withConsistentRead(async (session) => ({
      value: parseContract(
        SiteConfigSchema,
        json(
          await required(session, siteKey),
          CONTENT_LIMITS.siteBytes,
          siteKey,
        ),
        siteKey,
      ),
      etag: await session.etag([siteKey]),
    }));
  }
  async putSiteSettings(
    payload: unknown,
    ifMatch: string | undefined,
    options: MutationOptions = {},
  ): Promise<Versioned<SiteConfig>> {
    const candidate = parseContract(SiteConfigSchema, payload);
    const current = await this.#options.repository.withConsistentRead(
      (session) => required(session, siteKey),
    );
    const result = await this.#options.repository.commit({
      kind: 'save',
      changes: [
        {
          resourceKey: siteKey,
          expectedRevision: current.revision,
          content: jsonBytes(candidate, siteKey),
        },
      ],
      precondition: { ifMatch, resourceKeys: [siteKey] },
      ...(options.operation === undefined
        ? {}
        : { operation: options.operation }),
      validate: async (session) => {
        const context = await this.#context(session);
        this.#model(
          { ...context, site: candidate },
          await this.#manifest(session),
        );
      },
    });
    return {
      value: candidate,
      etag: result.etag,
      transactionId: result.transactionId,
    };
  }
  #descriptor(descriptor: MigrationDescriptor) {
    return parseContract(TaxonomyMigrationRequestSchema, {
      ...descriptor,
      confirmed: false,
    });
  }
  async planMigration(
    descriptor: MigrationDescriptor,
  ): Promise<TaxonomyMigrationPlan> {
    const parsed = this.#descriptor(descriptor);
    for (const [id, plan] of this.#plans)
      if (Date.parse(plan.value.expiresAt) <= this.#now().getTime())
        this.#plans.delete(id);
    return this.#options.repository.withConsistentRead(async (session) => {
      if ((await this.#options.scanInputs()) !== parsed.workspaceRevision)
        throw new ContentServiceError(
          'MIGRATION_PLAN_STALE',
          '工作區版本已更新，請重新取得影響清單。',
          409,
        );
      const context = await this.#context(session);
      let impact: ReturnType<typeof planTaxonomyMigration>;
      try {
        impact = planTaxonomyMigration({
          ...context,
          kind: parsed.kind,
          from: parsed.from,
          to: parsed.to,
        });
      } catch {
        throw new ContentServiceError(
          'MIGRATION_CONFLICT',
          '分類或 Tag 不存在、目標已占用或變更不符合結構規則。',
          409,
        );
      }
      const value: TaxonomyMigrationPlan = {
        planId: randomUUID(),
        kind: parsed.kind,
        from: parsed.from,
        to: parsed.to,
        workspaceRevision: parsed.workspaceRevision,
        expiresAt: new Date(this.#now().getTime() + 600_000).toISOString(),
        affectedArticleIds: [...impact.affectedArticleIds],
        affectedCategoryPaths: [...impact.affectedCategoryPaths],
        navigationReferences: [...impact.navigationReferences],
        changedUrls: [...impact.changedUrls],
      };
      this.#plans.set(value.planId, { value, generation: session.generation });
      return value;
    });
  }
  async executeMigration(
    execution: MigrationExecution,
    options: MutationOptions = {},
  ): Promise<MigrationExecutionResult> {
    const descriptor = this.#descriptor({
      kind: execution.kind,
      from: execution.from,
      to: execution.to,
      workspaceRevision: execution.workspaceRevision,
    });
    parseContract(UuidSchema, execution.planId);
    const stored = this.#plans.get(execution.planId);
    if (
      stored === undefined ||
      Date.parse(stored.value.expiresAt) <= this.#now().getTime() ||
      stored.value.kind !== descriptor.kind ||
      stored.value.from !== descriptor.from ||
      stored.value.to !== descriptor.to ||
      stored.value.workspaceRevision !== descriptor.workspaceRevision
    )
      throw new ContentServiceError(
        'MIGRATION_PLAN_STALE',
        '影響計畫已過期或不符合目前提交，請重新預覽。',
        409,
      );
    const prepared = await this.#options.repository.withConsistentRead(
      async (session) => {
        if (
          session.generation !== stored.generation ||
          (await this.#options.scanInputs()) !== stored.value.workspaceRevision
        )
          throw new ContentServiceError(
            'MIGRATION_PLAN_STALE',
            '工作區已變更，請重新確認影響清單。',
            409,
          );
        const context = await this.#context(session);
        const impact = planTaxonomyMigration({
          ...context,
          kind: descriptor.kind,
          from: descriptor.from,
          to: descriptor.to,
        });
        const candidates = new Map<string, Buffer>();
        candidates.set(
          descriptor.kind === 'category' ? taxonomyKeys[0] : taxonomyKeys[1],
          jsonBytes(
            descriptor.kind === 'category'
              ? impact.next.categories
              : impact.next.tags,
            descriptor.kind === 'category' ? taxonomyKeys[0] : taxonomyKeys[1],
          ),
        );
        for (const id of impact.affectedArticleIds) {
          const article = impact.next.articles.find(
            (item) => item.articleId === id,
          );
          if (article === undefined)
            throw new ContentServiceError(
              'MIGRATION_CONFLICT',
              '影響文章無法建立完整候選。',
              409,
            );
          candidates.set(
            articleKeys(id)[1],
            jsonBytes(article.meta, articleKeys(id)[1]),
          );
        }
        if (impact.navigationReferences.length > 0)
          candidates.set(siteKey, jsonBytes(impact.next.site, siteKey));
        const changes: FileChange[] = [];
        for (const [resourceKey, content] of candidates)
          changes.push({
            resourceKey,
            expectedRevision: (await required(session, resourceKey)).revision,
            content,
          });
        return {
          changes,
          etag: await session.etag([...candidates.keys()]),
          impact,
        };
      },
    );
    let diagnostics: readonly Diagnostic[] = [];
    let result: CommitResult;
    const completion: TaxonomyResult = {
      kind: descriptor.kind,
      from: descriptor.from,
      to: descriptor.to,
      affectedArticleIds: [...prepared.impact.affectedArticleIds],
      changedUrls: [...prepared.impact.changedUrls],
    };
    if (options.jobId !== undefined) parseContract(UuidSchema, options.jobId);
    try {
      result = await this.#options.repository.commit({
        kind: 'taxonomy',
        ...(options.jobId
          ? {
              jobCompletion: {
                id: options.jobId,
                type: 'taxonomy' as const,
                result: completion,
              },
            }
          : {}),
        changes: prepared.changes,
        precondition: {
          ifMatch: prepared.etag,
          resourceKeys: prepared.changes.map((item) => item.resourceKey),
        },
        workspacePrecondition: {
          revision: stored.value.workspaceRevision,
          scanInputs: this.#options.scanInputs,
        },
        ...(options.operation === undefined
          ? {}
          : { operation: options.operation }),
        validate: async (session) => {
          if (session.generation !== stored.generation)
            throw new ContentServiceError(
              'MIGRATION_PLAN_STALE',
              '工作區狀態已更新，請重新確認計畫。',
              409,
            );
          const context = await this.#context(session);
          const currentImpact = planTaxonomyMigration({
            ...context,
            kind: descriptor.kind,
            from: descriptor.from,
            to: descriptor.to,
          });
          const manifest = await this.#manifest(session);
          this.#model(context, manifest);
          try {
            this.#model({ ...context, ...currentImpact.next }, manifest);
          } catch (error) {
            if (!(error instanceof ContentServiceError)) throw error;
            const blocking = error.diagnostics.filter(
              (diagnostic) =>
                diagnostic.severity === 'error' &&
                !['BROKEN_INTERNAL_LINK', 'BROKEN_FRAGMENT'].includes(
                  diagnostic.code,
                ),
            );
            if (blocking.length > 0) throw validationFailure(blocking);
            diagnostics = error.diagnostics;
          }
        },
      });
    } catch (error) {
      if (
        error instanceof RepositoryError &&
        ['WORKSPACE_CHANGED', 'PRECONDITION_FAILED'].includes(error.code)
      )
        throw new ContentServiceError(
          'MIGRATION_PLAN_STALE',
          '計畫來源版本已變更，請重新確認影響。',
          409,
        );
      throw error;
    }
    this.#plans.delete(execution.planId);
    return {
      value: completion,
      transactionId: result.transactionId,
      diagnostics,
    };
  }
}
