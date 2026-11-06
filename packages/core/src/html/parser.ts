import {
  Parser,
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  type Token,
} from 'parse5';
import type { Diagnostic } from '../models/index.js';
import type { HtmlOptions } from './types.js';

export type HtmlElement = DefaultTreeAdapterTypes.Element;
export type HtmlNode = DefaultTreeAdapterTypes.Node;
type Location = Token.Location;

interface SourceTag {
  readonly name: string;
  readonly selfClosing: boolean;
  readonly location: Location | null;
}

export interface ParsedHtml {
  readonly elements: readonly HtmlElement[];
  readonly diagnostics: readonly Diagnostic[];
}

const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const paragraphFollowers = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'search',
  'section',
  'table',
  'ul',
]);
const forbiddenParagraphParents = new Set([
  'a',
  'audio',
  'del',
  'ins',
  'map',
  'noscript',
  'video',
]);

export function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}

export function attr(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

export function diagnostic(
  code: string,
  message: string,
  options: HtmlOptions,
  location?: { readonly startLine: number; readonly startCol: number } | null,
  severity: Diagnostic['severity'] = 'error',
): Diagnostic {
  return {
    severity,
    code,
    message,
    ...(options.articleId === undefined
      ? {}
      : { articleId: options.articleId }),
    ...(location == null
      ? {}
      : { line: location.startLine, column: location.startCol }),
  };
}

export function elementLocation(element: HtmlElement, attribute?: string) {
  return (
    (attribute === undefined
      ? undefined
      : element.sourceCodeLocation?.attrs?.[attribute]) ??
    element.sourceCodeLocation?.startTag ??
    element.sourceCodeLocation
  );
}

function walk(node: HtmlNode, elements: HtmlElement[]): void {
  const stack: HtmlNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (isElement(current)) elements.push(current);
    if ('content' in current && current.tagName === 'template')
      stack.push(current.content);
    if ('childNodes' in current) {
      for (let index = current.childNodes.length - 1; index >= 0; index -= 1) {
        const child = current.childNodes[index];
        if (child !== undefined) stack.push(child);
      }
    }
  }
}

export function plainText(node: HtmlNode): string {
  const text: string[] = [];
  const stack: HtmlNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current.nodeName === '#text' && 'value' in current)
      text.push(current.value);
    else if ('childNodes' in current) {
      for (let index = current.childNodes.length - 1; index >= 0; index -= 1) {
        const child = current.childNodes[index];
        if (child !== undefined) stack.push(child);
      }
    }
  }
  return text.join('');
}

function mayOmitEndTag(element: HtmlElement, sourceParent?: string): boolean {
  const siblings = element.parentNode?.childNodes ?? [];
  const next = siblings[siblings.indexOf(element) + 1];
  const nextTag =
    next !== undefined && isElement(next) ? next.tagName : undefined;
  const last = next === undefined;
  switch (element.tagName) {
    case 'li':
      return nextTag === 'li' || last;
    case 'dt':
      return nextTag === 'dt' || nextTag === 'dd';
    case 'dd':
      return nextTag === 'dt' || nextTag === 'dd' || last;
    case 'p': {
      const parent = element.parentNode;
      const parentTag =
        sourceParent ??
        (parent != null && isElement(parent) ? parent.tagName : '');
      return (
        (nextTag !== undefined && paragraphFollowers.has(nextTag)) ||
        (last &&
          !forbiddenParagraphParents.has(parentTag) &&
          !parentTag.includes('-'))
      );
    }
    case 'rt':
    case 'rp':
      return nextTag === 'rt' || nextTag === 'rp' || last;
    case 'optgroup':
      return nextTag === 'optgroup' || last;
    case 'option':
      return nextTag === 'option' || nextTag === 'optgroup' || last;
    case 'colgroup':
      return (
        next === undefined ||
        (next.nodeName !== '#comment' &&
          !(
            next.nodeName === '#text' &&
            'value' in next &&
            /^\s/u.test(next.value)
          ))
      );
    case 'thead':
      return nextTag === 'tbody' || nextTag === 'tfoot';
    case 'tbody':
      return nextTag === 'tbody' || nextTag === 'tfoot' || last;
    case 'tfoot':
      return last;
    case 'tr':
      return nextTag === 'tr' || last;
    case 'td':
    case 'th':
      return nextTag === 'td' || nextTag === 'th' || last;
    default:
      return false;
  }
}

/** Uses parse5's own tokenizer so text inside script/comments is never mistaken for tags. */
export function parseHtml(
  contentHtml: string,
  options: HtmlOptions = {},
): ParsedHtml {
  const diagnostics: Diagnostic[] = [];
  const startTags = new Map<number, SourceTag>();
  const endTags = new Map<number, SourceTag>();
  const parser = Parser.getFragmentParser<DefaultTreeAdapterMap>(null, {
    sourceCodeLocationInfo: true,
    onParseError(error) {
      diagnostics.push(
        diagnostic(
          'HTML_PARSE_ERROR',
          `HTML 解析錯誤：${error.code}。`,
          options,
          error,
        ),
      );
    },
  });
  const originalStart = parser.onStartTag.bind(parser);
  const originalEnd = parser.onEndTag.bind(parser);
  const originalDoctype = parser.onDoctype.bind(parser);
  parser.onStartTag = (token) => {
    if (token.location !== null)
      startTags.set(token.location.startOffset, {
        name: token.tagName,
        selfClosing: token.selfClosing,
        location: { ...token.location },
      });
    originalStart(token);
  };
  parser.onEndTag = (token) => {
    if (token.location !== null)
      endTags.set(token.location.startOffset, {
        name: token.tagName,
        selfClosing: false,
        location: { ...token.location },
      });
    originalEnd(token);
  };
  parser.onDoctype = (token) => {
    diagnostics.push(
      diagnostic(
        'HTML_DOCUMENT_FORBIDDEN',
        '文章正文不可包含 Document 或 DOCTYPE。',
        options,
        token.location,
      ),
    );
    originalDoctype(token);
  };
  parser.tokenizer.write(contentHtml, true);
  const fragment = parser.getFragment();
  const elements: HtmlElement[] = [];
  walk(fragment, elements);
  for (const tag of [...startTags.values(), ...endTags.values()]) {
    if (['html', 'head', 'body'].includes(tag.name)) {
      diagnostics.push(
        diagnostic(
          'HTML_DOCUMENT_FORBIDDEN',
          '文章正文不可包含 html、head 或 body 標記。',
          options,
          tag.location,
        ),
      );
    }
  }
  const matchedEnds = new Set<number>();
  // Adoption-agency repair can move p out of its authored a parent.
  // Keep the source parent for optional-end-tag conditions.
  const sourceParents = new Map<HtmlElement, string>();
  const sourceStack: HtmlElement[] = [];
  const sourcedElements = elements
    .filter((element) => element.sourceCodeLocation?.startTag !== undefined)
    .sort(
      (left, right) =>
        (left.sourceCodeLocation?.startOffset ?? 0) -
        (right.sourceCodeLocation?.startOffset ?? 0),
    );
  for (const element of sourcedElements) {
    const start = element.sourceCodeLocation?.startOffset ?? 0;
    while (
      sourceStack.length > 0 &&
      (sourceStack.at(-1)?.sourceCodeLocation?.endOffset ?? -1) <= start
    )
      sourceStack.pop();
    const sourceParent = sourceStack.at(-1);
    if (sourceParent !== undefined)
      sourceParents.set(element, sourceParent.tagName);
    if (!voidElements.has(element.tagName)) sourceStack.push(element);
  }
  for (const element of elements) {
    const location = element.sourceCodeLocation;
    if (location?.endTag !== undefined)
      matchedEnds.add(location.endTag.startOffset);
    if (location?.startTag === undefined || location.endTag !== undefined)
      continue;
    const tag = startTags.get(location.startTag.startOffset);
    const foreignSelfClosing =
      element.namespaceURI !== htmlNamespace && tag?.selfClosing === true;
    const htmlVoid =
      element.namespaceURI === htmlNamespace &&
      voidElements.has(element.tagName);
    if (foreignSelfClosing || htmlVoid) continue;
    if (
      element.namespaceURI === htmlNamespace &&
      mayOmitEndTag(element, sourceParents.get(element))
    )
      continue;
    diagnostics.push(
      diagnostic(
        'HTML_END_TAG_REQUIRED',
        '非 void 元素缺少必要結束標記。',
        options,
        location.startTag,
      ),
    );
  }
  for (const [offset, tag] of endTags) {
    if (
      !matchedEnds.has(offset) &&
      !['html', 'head', 'body'].includes(tag.name)
    ) {
      diagnostics.push(
        diagnostic(
          'HTML_UNMATCHED_END_TAG',
          '結束標記沒有對應的開始標記。',
          options,
          tag.location,
        ),
      );
    }
  }
  if (contentHtml.includes('\r')) {
    diagnostics.push(
      diagnostic(
        'HTML_LINE_ENDINGS',
        '正文必須使用 LF 換行，不可包含 CRLF 或 CR。',
        options,
      ),
    );
  }
  return { elements, diagnostics };
}
