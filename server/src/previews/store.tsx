import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArticlePage, SiteFooter, SiteHeader } from '@foliohaven/ui';
import {
  PreviewRequestSchema,
  PreviewResponseSchema,
  UuidSchema,
  previewArticle,
} from '@foliohaven/core';
import type {
  FixedPage,
  MediaManifest,
  HtmlProcessingCache,
  PreviewResponse,
} from '@foliohaven/core';
import { parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { FileRepository, ReadSession } from '../files/index.js';
import { RepositoryError } from '../files/io.js';
import { parseContract, sourceError } from '../content/errors.js';
import { PreviewStylesCache } from './styles.js';

interface PreviewDocument {
  readonly html: string;
  readonly csp: string;
  readonly expiresAt: string;
  readonly editorId: string;
}
export interface PreviewStoreOptions {
  readonly repository: FileRepository;
  readonly fixedPages: readonly FixedPage[];
  readonly manifest: (session: ReadSession) => Promise<MediaManifest>;
  readonly clock?: () => Date;
  readonly htmlCache?: HtmlProcessingCache;
}
/** 預覽才映射媒體與導覽目標；作者的來源 HTML／Meta 皆不回寫。 */
function mapMedia(html: string, manifest: MediaManifest): string {
  const paths = new Map(
    manifest.assets.flatMap((asset) =>
      asset.outputs.map(
        (output) =>
          [
            output.publicPath,
            output.publicPath.replace('/media/', '/api/v1/media/files/'),
          ] as const,
      ),
    ),
  );
  const fragment = parseFragment(html);
  const visit = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node && ['a', 'area'].includes(node.tagName)) {
      const href = node.attrs.find((attr) => attr.name === 'href');
      if (href) {
        const local = href.value.startsWith('#');
        const target = node.attrs.find((attr) => attr.name === 'target');
        if (target) target.value = local ? '_self' : '_blank';
        else
          node.attrs.push({
            name: 'target',
            value: local ? '_self' : '_blank',
          });
        if (!local) {
          const rel = node.attrs.find((attr) => attr.name === 'rel');
          const tokens = new Set(rel?.value.split(/\s+/u).filter(Boolean));
          tokens.add('noopener');
          tokens.add('noreferrer');
          if (rel) rel.value = [...tokens].join(' ');
          else node.attrs.push({ name: 'rel', value: [...tokens].join(' ') });
          const hint = '這裡僅預覽版面；請在網站預覽中開啟其他頁面。';
          const title = node.attrs.find((attr) => attr.name === 'title');
          if (title) title.value = `${title.value}；${hint}`;
          else node.attrs.push({ name: 'title', value: hint });
        }
      }
    }
    if ('attrs' in node)
      for (const attr of node.attrs) {
        if (['src', 'poster', 'href'].includes(attr.name))
          attr.value = paths.get(attr.value) ?? attr.value;
        if (['srcset', 'imagesrcset'].includes(attr.name))
          attr.value = attr.value
            .split(',')
            .map((part) => {
              const tokens = part.trim().split(/\s+/u);
              const path = tokens[0];
              if (path !== undefined) tokens[0] = paths.get(path) ?? path;
              return tokens.join(' ');
            })
            .join(', ');
      }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
    if ('content' in node) visit(node.content);
  };
  visit(fragment);
  return serialize(fragment);
}
export class PreviewStore {
  readonly #options: PreviewStoreOptions;
  readonly #documents = new Map<string, PreviewDocument>();
  readonly #styles = new PreviewStylesCache();
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  constructor(options: PreviewStoreOptions) {
    this.#options = options;
  }
  #now(): number {
    return (this.#options.clock?.() ?? new Date()).getTime();
  }
  #prune(): void {
    for (const [id, document] of this.#documents)
      if (Date.parse(document.expiresAt) <= this.#now())
        this.#documents.delete(id);
  }
  async create(
    input: unknown,
    context: {
      readonly editorId: string;
      readonly studioOrigin: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<PreviewResponse> {
    const previous = this.#queue;
    let release: () => void = () => undefined;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#closed)
        throw new RepositoryError('PREVIEW_STOPPED', '預覽服務已停止。', 503);
      return await this.#create(input, context);
    } finally {
      release();
    }
  }
  async #create(
    input: unknown,
    context: {
      readonly editorId: string;
      readonly studioOrigin: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<PreviewResponse> {
    const request = parseContract(PreviewRequestSchema, input);
    parseContract(UuidSchema, context.editorId);
    const checkpoint = () => {
      if (context.signal?.aborted)
        throw new RepositoryError('PREVIEW_CANCELLED', '預覽已中止。', 408);
    };
    checkpoint();
    this.#prune();
    const old = [...this.#documents].find(
      ([, document]) => document.editorId === context.editorId,
    );
    if (!old && this.#documents.size >= 50)
      throw new RepositoryError(
        'PREVIEW_CAPACITY_EXCEEDED',
        '預覽已達50份，請關閉其他編輯器或等待到期。',
        429,
      );
    const prepared = await this.#options.repository
      .withConsistentRead(async (session) => {
        checkpoint();
        const sources = await session.loadContent({ mode: 'preview' });
        checkpoint();
        const manifest = await this.#options.manifest(session);
        checkpoint();
        const article = previewArticle({
          ...sources,
          fixedPages: this.#options.fixedPages,
          mediaManifest: manifest,
          ...(this.#options.htmlCache
            ? { htmlCache: this.#options.htmlCache }
            : {}),
          article: {
            articleId: request.articleId ?? `preview-${randomUUID()}`,
            contentHtml: request.contentHtml,
            meta: request.meta,
          },
        });
        const html = renderToStaticMarkup(
          createElement(
            Fragment,
            null,
            createElement(SiteHeader, {
              site: article.site,
              ...(article.url === null ? {} : { currentPath: article.url }),
            }),
            createElement(ArticlePage, { article }),
            createElement(SiteFooter, { site: article.site }),
          ),
        );
        return { article, html: mapMedia(html, manifest) };
      })
      .catch(sourceError);
    checkpoint();
    const id = randomUUID();
    const expiresAt = new Date(this.#now() + 600_000).toISOString();
    const origin = context.studioOrigin;
    const csp = [
      "default-src 'none'",
      `style-src ${origin}/api/v1/preview-assets/styles.css`,
      "style-src-attr 'none'",
      `img-src ${origin}/api/v1/media/files/`,
      `media-src ${origin}/api/v1/media/files/`,
      "script-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      'sandbox',
    ].join('; ');
    // CSP與iframe sandbox隔離HTML；不把原文清理後覆寫回作者來源。
    const html = `<!doctype html>${renderToStaticMarkup(
      createElement(
        'html',
        { lang: prepared.article.site.language },
        createElement(
          'head',
          null,
          createElement('meta', { charSet: 'utf-8' }),
          createElement('meta', {
            name: 'viewport',
            content: 'width=device-width,initial-scale=1',
          }),
          createElement('meta', {
            name: 'robots',
            content: prepared.article.seo.robots,
          }),
          createElement('title', null, prepared.article.seo.title),
          createElement('link', {
            rel: 'stylesheet',
            href: '/api/v1/preview-assets/styles.css',
          }),
        ),
        createElement('body', {
          dangerouslySetInnerHTML: { __html: prepared.html },
        }),
      ),
    )}`;
    if (old) this.#documents.delete(old[0]);
    this.#documents.set(id, {
      html,
      csp,
      expiresAt,
      editorId: context.editorId,
    });
    return PreviewResponseSchema.parse({
      id,
      documentUrl: `/api/v1/previews/${id}/document`,
      expiresAt,
      diagnostics: prepared.article.diagnostics,
    });
  }
  document(id: string): PreviewDocument {
    this.#prune();
    const document = this.#documents.get(id);
    if (!UuidSchema.safeParse(id).success || !document)
      throw new RepositoryError(
        'PREVIEW_NOT_FOUND',
        '預覽已到期或不存在。',
        404,
      );
    return document;
  }
  async styles(): Promise<Buffer> {
    return this.#styles.read(
      fileURLToPath(import.meta.resolve('@foliohaven/ui/styles.css')),
    );
  }
  close(): void {
    this.#closed = true;
    this.#documents.clear();
  }
}
