import type {
  Diagnostic,
  MediaAsset,
  MediaManifest,
  MediaOutput,
} from '../models/index.js';
import { MediaManifestSchema } from '../schemas/media.js';
import { mediaImageGroup } from '../schemas/common.js';
import { analyzeHtml } from './analyze.js';
import {
  attr,
  diagnostic,
  elementLocation,
  isElement,
  parseHtml,
  type HtmlElement,
} from './parser.js';
import { readSrcset } from './references.js';
import type { EnhancedHtml, HtmlOptions } from './types.js';

interface AvailableOutput {
  readonly asset: MediaAsset;
  readonly output: MediaOutput;
}
interface Insertion {
  readonly offset: number;
  readonly text: string;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function dimensions(
  element: HtmlElement,
  output: MediaOutput,
  additions: Map<string, string>,
  diagnostics: Diagnostic[],
  options: HtmlOptions,
): void {
  const rawWidth = attr(element, 'width');
  const rawHeight = attr(element, 'height');
  const width = positiveInteger(rawWidth);
  const height = positiveInteger(rawHeight);
  if (
    (rawWidth !== undefined && width === undefined) ||
    (rawHeight !== undefined && height === undefined)
  ) {
    diagnostics.push(
      diagnostic(
        'MEDIA_DIMENSION_INVALID',
        '媒體 width 與 height 必須為正整數。',
        options,
        elementLocation(element),
      ),
    );
    return;
  }
  if (
    width !== undefined &&
    height !== undefined &&
    Math.abs(width * output.height - height * output.width) >
      Math.max(output.width, output.height)
  ) {
    diagnostics.push(
      diagnostic(
        'MEDIA_ASPECT_RATIO',
        '媒體 width／height 必須符合實際比例，僅容許整數取整差異。',
        options,
        elementLocation(element),
      ),
    );
  }
  if (width === undefined)
    additions.set(
      'width',
      String(
        height === undefined
          ? output.width
          : Math.max(1, Math.round((height * output.width) / output.height)),
      ),
    );
  if (height === undefined)
    additions.set(
      'height',
      String(
        width === undefined
          ? output.height
          : Math.max(1, Math.round((width * output.height) / output.width)),
      ),
    );
}

/** Adds only missing attributes at parse5 source offsets; author bytes are never reserialized. */
export function enhanceHtmlMedia(
  contentHtml: string,
  manifest: MediaManifest,
  options: HtmlOptions = {},
): EnhancedHtml {
  const analysis = analyzeHtml(contentHtml, options);
  const diagnostics: Diagnostic[] = [...analysis.diagnostics];
  const checkedManifest = MediaManifestSchema.safeParse(manifest);
  if (!checkedManifest.success) {
    diagnostics.push(
      diagnostic(
        'MEDIA_MANIFEST_INVALID',
        '媒體 manifest 不符合完整契約。',
        options,
      ),
    );
    return { contentHtml, mediaRefs: analysis.mediaRefs, diagnostics };
  }
  const available = new Map<string, AvailableOutput>();
  for (const asset of checkedManifest.data.assets) {
    for (const output of asset.outputs)
      available.set(output.publicPath, { asset, output });
  }
  const refs = new Set(analysis.mediaRefs);
  const elements = parseHtml(contentHtml, options).elements;
  const insertions: Insertion[] = [];
  const lookup = (
    url: string,
    mime: MediaOutput['mimeType'],
    element: HtmlElement,
    attribute: string,
  ): AvailableOutput | undefined => {
    const found = available.get(url);
    if (found === undefined) {
      // Invalid managed-path syntax is already reported by analyzeHtml.
      if (refs.has(url))
        diagnostics.push(
          diagnostic(
            'MEDIA_NOT_FOUND',
            '引用的媒體變體不存在或尚未處理完成。',
            options,
            elementLocation(element, attribute),
          ),
        );
      return undefined;
    }
    if (
      mime === 'video/webm'
        ? found.output.mimeType !== mime
        : !found.output.mimeType.startsWith('image/')
    ) {
      diagnostics.push(
        diagnostic(
          'MEDIA_TYPE_MISMATCH',
          '媒體引用的實際類型與元素用途不符。',
          options,
          elementLocation(element, attribute),
        ),
      );
      return undefined;
    }
    return found;
  };
  for (const element of elements) {
    if (!['img', 'video', 'source'].includes(element.tagName)) continue;
    const tag = element.tagName;
    const parent = element.parentNode;
    const pictureSource =
      tag === 'source' &&
      parent != null &&
      isElement(parent) &&
      parent.tagName === 'picture';
    const videoSource =
      tag === 'source' &&
      parent != null &&
      isElement(parent) &&
      parent.tagName === 'video';
    if (tag === 'source' && !pictureSource && !videoSource) continue;
    const mime = tag === 'video' || videoSource ? 'video/webm' : 'image/webp';
    const additions = new Map<string, string>();
    const src = attr(element, 'src');
    const srcset = attr(element, 'srcset');
    const poster = attr(element, 'poster');
    let primary: AvailableOutput | undefined;
    if (src !== undefined) {
      primary = lookup(src, mime, element, 'src');
      if (pictureSource)
        diagnostics.push(
          diagnostic(
            'MEDIA_ATTRIBUTE_INVALID',
            'picture 的 source 使用 srcset，不使用 src。',
            options,
            elementLocation(element, 'src'),
          ),
        );
    }
    if (srcset !== undefined) {
      if (mime === 'video/webm')
        diagnostics.push(
          diagnostic(
            'MEDIA_ATTRIBUTE_INVALID',
            '影片使用 src，不使用 srcset。',
            options,
            elementLocation(element, 'srcset'),
          ),
        );
      // Syntax has already been diagnosed; this pass validates each real output.
      for (const candidate of readSrcset(srcset, element, [], options)) {
        const found = lookup(candidate.url, 'image/webp', element, 'srcset');
        if (primary === undefined && found !== undefined) primary = found;
        if (
          found !== undefined &&
          candidate.width !== undefined &&
          candidate.width !== found.output.width
        ) {
          diagnostics.push(
            diagnostic(
              'MEDIA_SRCSET_WIDTH',
              'srcset 的寬度描述與實際媒體寬度不符。',
              options,
              elementLocation(element, 'srcset'),
            ),
          );
        }
      }
    } else if (pictureSource)
      diagnostics.push(
        diagnostic(
          'MEDIA_SOURCE_REQUIRED',
          'picture 的 source 必須有 srcset。',
          options,
          elementLocation(element),
        ),
      );
    if (videoSource && src === undefined)
      diagnostics.push(
        diagnostic(
          'MEDIA_SOURCE_REQUIRED',
          'video 的 source 必須有 src。',
          options,
          elementLocation(element),
        ),
      );
    if (tag === 'video' && primary === undefined && src === undefined) {
      for (const child of element.childNodes) {
        if (!isElement(child) || child.tagName !== 'source') continue;
        const childSrc = attr(child, 'src');
        if (childSrc !== undefined) {
          const found = available.get(childSrc);
          if (found?.output.mimeType === 'video/webm') {
            primary = found;
            break;
          }
        }
      }
    }
    if (poster !== undefined) {
      lookup(poster, 'image/webp', element, 'poster');
      if (tag !== 'video')
        diagnostics.push(
          diagnostic(
            'MEDIA_ATTRIBUTE_INVALID',
            'poster 只允許用於 video。',
            options,
            elementLocation(element, 'poster'),
          ),
        );
    }
    const declaredType = attr(element, 'type');
    if (
      declaredType !== undefined &&
      declaredType.split(';')[0]?.trim().toLowerCase() !==
        (primary?.output.mimeType ?? mime)
    ) {
      diagnostics.push(
        diagnostic(
          'MEDIA_TYPE_MISMATCH',
          '宣告的媒體 MIME 與正式變體不符。',
          options,
          elementLocation(element, 'type'),
        ),
      );
    }
    if (primary === undefined) continue;
    if (tag === 'img' || tag === 'video' || pictureSource)
      dimensions(element, primary.output, additions, diagnostics, options);
    if (mime === 'image/webp') {
      if (srcset === undefined && tag === 'img') {
        const widths = new Map<number, MediaOutput>();
        for (const output of primary.asset.outputs) {
          if (
            output.mimeType.startsWith('image/') &&
            mediaImageGroup(output.publicPath) ===
              mediaImageGroup(primary.output.publicPath) &&
            (mediaImageGroup(primary.output.publicPath) === 'responsive' ||
              output.publicPath === primary.output.publicPath) &&
            (primary.asset.kind === 'image' ||
              output.publicPath === primary.output.publicPath)
          ) {
            const previous = widths.get(output.width);
            if (
              previous === undefined ||
              output.publicPath.endsWith('/image.webp')
            )
              widths.set(output.width, output);
          }
        }
        const responsive = [...widths.values()].sort(
          (left, right) => left.width - right.width,
        );
        additions.set(
          'srcset',
          responsive
            .map((output) => `${output.publicPath} ${output.width}w`)
            .join(', '),
        );
      }
      const hasWidthCandidates =
        srcset === undefined
          ? additions.has('srcset')
          : readSrcset(srcset, element, [], options).some(
              (candidate) => candidate.width !== undefined,
            );
      if (attr(element, 'sizes') === undefined && hasWidthCandidates) {
        const displayWidth =
          positiveInteger(attr(element, 'width')) ??
          positiveInteger(additions.get('width')) ??
          primary.output.width;
        additions.set(
          'sizes',
          `(max-width: ${displayWidth}px) 100vw, ${displayWidth}px`,
        );
      } else if (attr(element, 'sizes')?.trim() === '')
        diagnostics.push(
          diagnostic(
            'MEDIA_SIZES_INVALID',
            'sizes 不可為空字串。',
            options,
            elementLocation(element, 'sizes'),
          ),
        );
    }
    if (mime === 'video/webm' && primary.output.mimeType === 'video/webm') {
      const dependentPoster = primary.asset.outputs.find((output) =>
        output.publicPath.endsWith('/poster.webp'),
      );
      if (dependentPoster !== undefined) {
        refs.add(dependentPoster.publicPath);
        if (tag === 'video' && poster === undefined)
          additions.set('poster', dependentPoster.publicPath);
      }
    }
    const startTag = element.sourceCodeLocation?.startTag;
    if (startTag === undefined || additions.size === 0) continue;
    let offset = startTag.endOffset - 1;
    if (contentHtml[offset - 1] === '/') offset -= 1;
    insertions.push({
      offset,
      text: [...additions]
        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
        .join(''),
    });
  }
  let enhanced = contentHtml;
  for (const insertion of insertions.sort(
    (left, right) => right.offset - left.offset,
  )) {
    enhanced =
      enhanced.slice(0, insertion.offset) +
      insertion.text +
      enhanced.slice(insertion.offset);
  }
  for (const reference of analyzeHtml(enhanced, options).mediaRefs)
    refs.add(reference);
  return { contentHtml: enhanced, mediaRefs: [...refs], diagnostics };
}
