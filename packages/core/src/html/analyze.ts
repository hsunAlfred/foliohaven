import type { Diagnostic, TocEntry } from '../models/index.js';
import {
  attr,
  diagnostic,
  elementLocation,
  parseHtml,
  plainText,
} from './parser.js';
import {
  isSafeLink,
  mediaReferences,
  mediaReferenceValues,
} from './references.js';
import type { HtmlAnalysis, HtmlLink, HtmlOptions } from './types.js';

export function analyzeHtml(
  contentHtml: string,
  options: HtmlOptions = {},
): HtmlAnalysis {
  const parsed = parseHtml(contentHtml, options);
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  const ids = new Set<string>();
  const toc: TocEntry[] = [];
  const links: HtmlLink[] = [];
  let previousHeading = 1;
  for (const element of parsed.elements) {
    const id = attr(element, 'id');
    const validId = id !== undefined && id !== '' && !/[\s\p{Cc}]/u.test(id);
    if (id !== undefined) {
      if (!validId)
        diagnostics.push(
          diagnostic(
            'HTML_ID_INVALID',
            'id 必須非空且不可包含空白或控制字元。',
            options,
            elementLocation(element, 'id'),
          ),
        );
      else {
        if (ids.has(id))
          diagnostics.push(
            diagnostic(
              'HTML_ID_DUPLICATE',
              '同一篇正文中的 id 不可重複。',
              options,
              elementLocation(element, 'id'),
            ),
          );
        if (id.startsWith('ui-'))
          diagnostics.push(
            diagnostic(
              'HTML_ID_RESERVED',
              'id 不可占用共用介面的 ui- 前綴。',
              options,
              elementLocation(element, 'id'),
            ),
          );
        ids.add(id);
      }
    }
    if (element.tagName === 'h1')
      diagnostics.push(
        diagnostic(
          'HTML_H1_FORBIDDEN',
          '正文不可包含 H1，文章主標題由 ArticlePage 輸出。',
          options,
          elementLocation(element),
        ),
      );
    if (/^h[2-6]$/u.test(element.tagName)) {
      const level = Number(element.tagName.slice(1)) as TocEntry['level'];
      if (!validId)
        diagnostics.push(
          diagnostic(
            'HTML_HEADING_ID_REQUIRED',
            'H2 至 H6 必須提供合法 id。',
            options,
            elementLocation(element),
          ),
        );
      if (level > previousHeading + 1)
        diagnostics.push(
          diagnostic(
            'HTML_HEADING_LEVEL_JUMP',
            '章節標題層級跳級，建議按順序組織。',
            options,
            elementLocation(element),
            'warning',
          ),
        );
      previousHeading = level;
      if (validId && (level === 2 || level === 3))
        toc.push({
          id,
          text: plainText(element).replace(/\s+/gu, ' ').trim(),
          level,
        });
    }
    if (['a', 'area'].includes(element.tagName)) {
      const href = attr(element, 'href');
      if (href !== undefined) {
        const location = elementLocation(element, 'href');
        links.push({
          href,
          ...(location == null
            ? {}
            : { line: location.startLine, column: location.startCol }),
        });
        if (!isSafeLink(href))
          diagnostics.push(
            diagnostic(
              'HTML_LINK_INVALID',
              '連結必須為站內根路徑、fragment 或合法 HTTP(S)、mailto、tel URL。',
              options,
              location,
            ),
          );
      }
    }
  }
  const mediaRefs = mediaReferences(parsed.elements, diagnostics, options);
  return {
    toc,
    ids: [...ids],
    links,
    mediaRefs,
    mediaReferenceValues: mediaReferenceValues(parsed.elements),
    diagnostics,
  };
}
