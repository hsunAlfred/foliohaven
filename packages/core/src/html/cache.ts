import type { MediaManifest } from '../models/index.js';
import { analyzeHtml } from './analyze.js';
import { enhanceHtmlMedia } from './media.js';
import type { EnhancedHtml, HtmlAnalysis, HtmlOptions } from './types.js';

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}

/** Optional Studio optimization for pure HTML processing; no source/model cache. */
export class HtmlProcessingCache {
  readonly #entries = new Map<
    string,
    { readonly value: HtmlAnalysis | EnhancedHtml; readonly bytes: number }
  >();
  #bytes = 0;
  constructor(
    readonly maximumEntries = 256,
    readonly maximumBytes = 32 * 1024 * 1024,
  ) {}

  #read<T extends HtmlAnalysis | EnhancedHtml>(key: string, load: () => T): T {
    const cached = this.#entries.get(key);
    if (cached !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      return cached.value as T;
    }
    const value = immutable(load());
    // Count retained input and output strings, including the exact manifest.
    const bytes = (key.length + JSON.stringify(value).length) * 2;
    if (bytes > this.maximumBytes || this.maximumEntries < 1) return value;
    while (
      this.#entries.size >= this.maximumEntries ||
      this.#bytes + bytes > this.maximumBytes
    ) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.#entries.get(oldest);
      if (entry !== undefined) this.#bytes -= entry.bytes;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, bytes });
    this.#bytes += bytes;
    return value;
  }

  analyze(contentHtml: string, options: HtmlOptions = {}): HtmlAnalysis {
    return this.#read(
      JSON.stringify([
        'analysis',
        contentHtml,
        options.articleId,
        options.mode,
      ]),
      () => analyzeHtml(contentHtml, options),
    );
  }

  enhance(
    contentHtml: string,
    manifest: MediaManifest,
    options: HtmlOptions = {},
  ): EnhancedHtml {
    return this.#read(
      JSON.stringify([
        'media',
        contentHtml,
        options.articleId,
        options.mode,
        manifest,
      ]),
      () => enhanceHtmlMedia(contentHtml, manifest, options),
    );
  }
}
