import type { Diagnostic, TocEntry } from '../models/index.js';

export interface HtmlOptions {
  readonly articleId?: string;
  readonly mode?: 'published' | 'draft';
}

export interface HtmlLink {
  readonly href: string;
  readonly line?: number;
  readonly column?: number;
}

export interface HtmlAnalysis {
  readonly toc: readonly TocEntry[];
  readonly ids: readonly string[];
  readonly links: readonly HtmlLink[];
  readonly mediaRefs: readonly string[];
  /** parser讀出的引用原值，包含尚未合法的草稿URL，供保守刪除檢查。 */
  readonly mediaReferenceValues: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface EnhancedHtml {
  readonly contentHtml: string;
  readonly mediaRefs: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}
