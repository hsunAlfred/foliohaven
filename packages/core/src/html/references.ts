import type { Diagnostic } from '../models/index.js';
import { ManagedMediaPathSchema } from '../schemas/common.js';
import {
  attr,
  diagnostic,
  elementLocation,
  isElement,
  type HtmlElement,
} from './parser.js';
import type { HtmlOptions } from './types.js';

export interface SrcsetCandidate {
  readonly url: string;
  readonly width?: number;
  readonly density?: number;
}

export function isSafeLink(href: string): boolean {
  if (href === '' || /[\s\p{Cc}\\]/u.test(href)) return false;
  if (href.startsWith('#')) {
    try {
      decodeURIComponent(href.slice(1));
      return true;
    } catch {
      return false;
    }
  }
  if (href.startsWith('/')) {
    if (href.startsWith('//')) return false;
    const path = href.split(/[?#]/u)[0] ?? '';
    try {
      return path.split('/').every((segment) => {
        const decoded = decodeURIComponent(segment);
        return (
          decoded !== '.' && decoded !== '..' && !/[\p{Cc}\\/]/u.test(decoded)
        );
      });
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:')
      return url.hostname !== '' && url.username === '' && url.password === '';
    return ['mailto:', 'tel:'].includes(url.protocol) && url.pathname !== '';
  } catch {
    return false;
  }
}

export function readSrcset(
  value: string,
  element: HtmlElement,
  diagnostics: Diagnostic[],
  options: HtmlOptions,
): readonly SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  const descriptors = new Set<string>();
  const families = new Set<'w' | 'x'>();
  let invalid = false;
  for (const part of value.split(',')) {
    const tokens = part.trim().split(/\s+/u);
    const url = tokens[0];
    const descriptor = tokens[1];
    if (url === undefined || url === '' || tokens.length > 2) {
      invalid = true;
      continue;
    }
    if (descriptor === undefined) {
      candidates.push({ url, density: 1 });
      families.add('x');
      if (descriptors.has('1x')) invalid = true;
      descriptors.add('1x');
    } else if (
      /^\d+w$/u.test(descriptor) &&
      Number.isSafeInteger(Number(descriptor.slice(0, -1))) &&
      Number(descriptor.slice(0, -1)) > 0
    ) {
      candidates.push({ url, width: Number(descriptor.slice(0, -1)) });
      families.add('w');
      const normalized = `${Number(descriptor.slice(0, -1))}w`;
      if (descriptors.has(normalized)) invalid = true;
      descriptors.add(normalized);
    } else if (
      /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?x$/u.test(descriptor) &&
      Number(descriptor.slice(0, -1)) > 0 &&
      Number.isFinite(Number(descriptor.slice(0, -1)))
    ) {
      const density = Number(descriptor.slice(0, -1));
      candidates.push({ url, density });
      families.add('x');
      const normalized = `${density}x`;
      if (descriptors.has(normalized)) invalid = true;
      descriptors.add(normalized);
    } else {
      candidates.push({ url });
      invalid = true;
    }
  }
  if (families.size > 1) invalid = true;
  if (invalid || candidates.length === 0) {
    diagnostics.push(
      diagnostic(
        'MEDIA_SRCSET_INVALID',
        'srcset 必須使用唯一的正寬度或密度描述，不可混用或有空候選。',
        options,
        elementLocation(element, 'srcset'),
      ),
    );
  }
  return candidates;
}

export function managedReference(
  value: string,
  element: HtmlElement,
  attribute: string,
  diagnostics: Diagnostic[],
  options: HtmlOptions,
): string | undefined {
  if (!ManagedMediaPathSchema.safeParse(value).success) {
    diagnostics.push(
      diagnostic(
        'MEDIA_REFERENCE_INVALID',
        '圖片與影片必須引用受管的本機媒體變體。',
        options,
        elementLocation(element, attribute),
      ),
    );
    return undefined;
  }
  return value;
}

export function mediaReferences(
  elements: readonly HtmlElement[],
  diagnostics: Diagnostic[],
  options: HtmlOptions,
): readonly string[] {
  const references = new Set<string>();
  for (const element of elements) {
    const tag = element.tagName;
    if (!['img', 'video', 'source', 'audio'].includes(tag)) continue;
    const src = attr(element, 'src');
    const srcset = attr(element, 'srcset');
    const poster = attr(element, 'poster');
    if (tag === 'img' && attr(element, 'alt') === undefined) {
      diagnostics.push(
        diagnostic(
          'MEDIA_ALT_REQUIRED',
          '圖片必須明確提供 alt；裝飾圖片可使用空字串。',
          options,
          elementLocation(element),
        ),
      );
    }
    if (tag === 'img' && src === undefined && srcset === undefined) {
      diagnostics.push(
        diagnostic(
          'MEDIA_SOURCE_REQUIRED',
          '圖片必須有 src 或 srcset。',
          options,
          elementLocation(element),
        ),
      );
    }
    if (
      tag === 'video' &&
      src === undefined &&
      !element.childNodes.some(
        (node) =>
          isElement(node) &&
          node.tagName === 'source' &&
          attr(node, 'src') !== undefined,
      )
    ) {
      diagnostics.push(
        diagnostic(
          'MEDIA_SOURCE_REQUIRED',
          '影片必須有 src 或 source 子元素。',
          options,
          elementLocation(element),
        ),
      );
    }
    if (
      tag === 'source' &&
      (element.parentNode == null ||
        !isElement(element.parentNode) ||
        !['picture', 'video'].includes(element.parentNode.tagName))
    ) {
      diagnostics.push(
        diagnostic(
          'MEDIA_SOURCE_CONTEXT',
          'source 只能用於 picture 或 video。',
          options,
          elementLocation(element),
        ),
      );
    }
    if (tag === 'audio') {
      diagnostics.push(
        diagnostic(
          'MEDIA_KIND_UNSUPPORTED',
          '此媒體系統只支援受管圖片與影片，不支援獨立 audio。',
          options,
          elementLocation(element),
        ),
      );
    }
    for (const [attribute, value] of [
      ['src', src],
      ['poster', poster],
    ] as const) {
      if (value === undefined) continue;
      const reference = managedReference(
        value,
        element,
        attribute,
        diagnostics,
        options,
      );
      if (reference !== undefined) references.add(reference);
    }
    if (srcset !== undefined) {
      for (const candidate of readSrcset(
        srcset,
        element,
        diagnostics,
        options,
      )) {
        const reference = managedReference(
          candidate.url,
          element,
          'srcset',
          diagnostics,
          options,
        );
        if (reference !== undefined) references.add(reference);
      }
    }
  }
  return [...references];
}

/** 不將不合法值當作可公開資源，仍保留作者正在編輯的引用。 */
export function mediaReferenceValues(
  elements: readonly HtmlElement[],
): readonly string[] {
  const values = new Set<string>();
  for (const element of elements) {
    if (!['img', 'video', 'source', 'audio'].includes(element.tagName))
      continue;
    for (const attribute of ['src', 'poster']) {
      const value = attr(element, attribute);
      if (value !== undefined) values.add(value);
    }
    const srcset = attr(element, 'srcset');
    if (srcset !== undefined)
      for (const candidate of srcset.split(',')) {
        const value = candidate.trim().split(/\s+/u)[0];
        if (value) values.add(value);
      }
  }
  return [...values];
}
