import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MediaError } from './errors.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 50_000;
const MAX_DEPTH = 64;
const elements = new Set([
  'svg',
  'g',
  'defs',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'title',
  'desc',
]);
const presentation = new Set([
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'clip-rule',
  'clip-path',
  'mask',
  'opacity',
  'color',
  'display',
  'visibility',
  'paint-order',
  'vector-effect',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'word-spacing',
  'text-anchor',
  'dominant-baseline',
  'stop-color',
  'stop-opacity',
  'color-interpolation',
]);
const attributes = new Set([
  ...presentation,
  'id',
  'class',
  'role',
  'focusable',
  'style',
  'transform',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'dx',
  'dy',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'd',
  'points',
  'pathLength',
  'offset',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'textLength',
  'lengthAdjust',
  'startOffset',
  'method',
  'spacing',
  'href',
  'xlink:href',
  'xmlns',
  'xmlns:xlink',
  'xml:space',
  'xml:lang',
  'version',
]);
const reference = /^#[A-Za-z_][\w:.-]*$/u;
const paintReference = /^url\(\s*(["']?)(#[A-Za-z_][\w:.-]*)\1\s*\)$/u;
const xmlEntity = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|apos|quot);/giu;

function invalid(message = 'SVG 含不支援的結構或外部資源。'): never {
  throw new MediaError('MEDIA_SVG_UNSAFE', message);
}
function xmlCharacter(value: number): boolean {
  return (
    value === 9 ||
    value === 10 ||
    value === 13 ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  );
}
function decode(value: string): string {
  if (value.replace(xmlEntity, '').includes('&'))
    invalid('SVG 含未知 XML entity。');
  return value.replace(xmlEntity, (_whole: string, entity: string) => {
    const named: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      apos: "'",
      quot: '"',
    };
    if (!entity.startsWith('#')) return named[entity] ?? invalid();
    const point = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!xmlCharacter(point)) invalid('SVG 含無效 XML 字元。');
    return String.fromCodePoint(point);
  });
}
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
function staticValue(value: string): void {
  if (
    value.includes('\\') ||
    /\/\*|\*\/|@|expression\s*\(|(?:https?|data|javascript|file):/iu.test(value)
  )
    invalid();
  if (/url\s*\(/iu.test(value) && !paintReference.test(value.trim())) invalid();
}
function inlineStyle(value: string): void {
  for (const declaration of value.split(';')) {
    if (declaration.trim() === '') continue;
    const colon = declaration.indexOf(':');
    if (colon < 1) invalid('SVG style 只接受靜態繪圖屬性。');
    const property = declaration.slice(0, colon).trim();
    const content = declaration.slice(colon + 1).trim();
    if (!presentation.has(property) || content === '') invalid();
    staticValue(content);
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse XML and serialize a deliberately static, self-contained SVG subset. */
function normalizeSvgDocument(
  bytes: Buffer,
  viewport?: { width: number; height: number },
): { bytes: Buffer; ids: ReadonlySet<string> } {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SVG_BYTES)
    throw new MediaError(
      'MEDIA_SOURCE_TOO_LARGE',
      'SVG 原檔上限為 2 MiB。',
      413,
    );
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid('SVG 必須使用 UTF-8。');
  }
  for (const character of source) {
    const point = character.codePointAt(0);
    if (point === undefined || !xmlCharacter(point))
      invalid('SVG 含無效 XML 字元。');
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)|<!\[CDATA\[/iu.test(source)) invalid();
  const instructions = source.match(/<\?[\s\S]*?\?>/gu) ?? [];
  if (
    instructions.length > 1 ||
    instructions.some(
      (instruction) =>
        !/^<\?xml\s/u.test(instruction) ||
        !source.trimStart().startsWith(instruction),
    )
  )
    invalid();
  if (XMLValidator.validate(source, { allowBooleanAttributes: false }) !== true)
    invalid('SVG 不是有效 XML。');
  let parsed: unknown;
  try {
    parsed = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      processEntities: false,
      maxNestedTags: MAX_DEPTH,
      ignoreDeclaration: false,
    }).parse(source);
  } catch {
    return invalid('SVG XML 無法解析或層數過多。');
  }
  if (!Array.isArray(parsed)) invalid();
  let nodes = 0;
  let roots = 0;
  const ids = new Map<string, number>();
  const references: { from: number; id: string }[] = [];
  const edges = new Map<number, Set<number>>();
  const connect = (from: number, to: number) => {
    const children = edges.get(from) ?? new Set<number>();
    children.add(to);
    edges.set(from, children);
  };
  const render = (node: unknown, depth: number, parent?: number): string => {
    if (!record(node) || ++nodes > MAX_NODES || depth > MAX_DEPTH) invalid();
    const current = nodes;
    if (parent !== undefined) connect(parent, current);
    const keys = Object.keys(node).filter((key) => key !== ':@');
    if (keys.length !== 1) invalid();
    const tag = keys[0];
    if (tag === undefined) invalid();
    if (tag === '?xml' && depth === 0) return '';
    if (tag === '#text') {
      if (typeof node[tag] !== 'string') invalid();
      const text = decode(node[tag]);
      if (depth === 0 && text.trim() !== '') invalid();
      return escape(text);
    }
    if (!elements.has(tag)) invalid(`SVG 不支援 ${tag} 元素。`);
    if (depth === 0) {
      if (tag !== 'svg' || ++roots !== 1) invalid();
    } else if (tag === 'svg') invalid('SVG 不支援巢狀文件。');
    const children = node[tag];
    if (!Array.isArray(children)) invalid();
    const rawAttributes = node[':@'];
    if (rawAttributes !== undefined && !record(rawAttributes)) invalid();
    const attrs = Object.entries(rawAttributes ?? {});
    if (attrs.length > 128) invalid();
    const output: [string, string][] = [];
    for (const [key, raw] of attrs) {
      if (!key.startsWith('@_') || typeof raw !== 'string') invalid();
      const name = key.slice(2);
      if (!attributes.has(name) && !/^aria-[a-z-]+$/u.test(name)) invalid();
      const value = decode(raw);
      if (name === 'xmlns') {
        if (depth !== 0 || value !== SVG_NAMESPACE) invalid();
      } else if (name === 'xmlns:xlink') {
        if (depth !== 0 || value !== XLINK_NAMESPACE) invalid();
      } else if (name === 'style') inlineStyle(value);
      else if (name === 'href' || name === 'xlink:href') {
        if (
          !['linearGradient', 'radialGradient', 'textPath'].includes(tag) ||
          !reference.test(value)
        )
          invalid();
        references.push({ from: current, id: value.slice(1) });
      } else if (name === 'id') {
        if (!/^[A-Za-z_][\w:.-]*$/u.test(value) || ids.has(value)) invalid();
        ids.set(value, current);
      } else if (!name.startsWith('aria-')) staticValue(value);
      for (const ref of value.matchAll(
        /url\(\s*(["']?)(#[A-Za-z_][\w:.-]*)\1\s*\)/gu,
      ))
        if (ref[2]) references.push({ from: current, id: ref[2].slice(1) });
      output.push([name, value]);
    }
    if (depth === 0 && !output.some(([name]) => name === 'xmlns'))
      output.unshift(['xmlns', SVG_NAMESPACE]);
    if (depth === 0 && viewport !== undefined) {
      for (const name of ['width', 'height', 'x', 'y']) {
        const index = output.findIndex(([attribute]) => attribute === name);
        if (index !== -1) output.splice(index, 1);
      }
      output.push(
        ['width', String(viewport.width)],
        ['height', String(viewport.height)],
        ['x', '0'],
        ['y', '0'],
      );
    }
    return (
      `<${tag}${output.map(([name, value]) => ` ${name}="${escape(value)}"`).join('')}>` +
      children.map((child) => render(child, depth + 1, current)).join('') +
      `</${tag}>`
    );
  };
  const result = parsed.map((node) => render(node, 0)).join('');
  if (roots !== 1) invalid();
  for (const { from, id } of references) {
    const to = ids.get(id);
    if (to === undefined) invalid('SVG 引用不存在的內部圖形。');
    connect(from, to);
  }
  const done = new Set<number>();
  const active = new Set<number>();
  for (const start of edges.keys()) {
    if (done.has(start)) continue;
    const stack = [
      { node: start, children: (edges.get(start) ?? []).values() },
    ];
    active.add(start);
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) invalid();
      const next = frame.children.next();
      if (next.done) {
        active.delete(frame.node);
        done.add(frame.node);
        stack.pop();
      } else if (active.has(next.value)) invalid('SVG 不允許循環圖形引用。');
      else if (!done.has(next.value)) {
        if (stack.length > MAX_DEPTH) invalid('SVG 圖形引用層數過多。');
        active.add(next.value);
        stack.push({
          node: next.value,
          children: (edges.get(next.value) ?? []).values(),
        });
      }
    }
  }
  return { bytes: Buffer.from(result, 'utf8'), ids: new Set(ids.keys()) };
}

export function normalizeSvg(bytes: Buffer): Buffer {
  return normalizeSvgDocument(bytes).bytes;
}

/** Preserve the original vector alpha, including none paints and luminance masks. */
export function maskIconSvg(
  bytes: Buffer,
  width: number,
  height: number,
): Buffer {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width > 12_000 ||
    height > 12_000 ||
    width * height > 40_000_000
  )
    invalid('SVG 圖示尺寸無效。');
  const original = normalizeSvgDocument(bytes, { width, height });
  let id = 'site-icon-mask';
  while (original.ids.has(id)) id += '-x';
  const scale = Math.min(16 / width, 16 / height);
  const x = (16 - width * scale) / 2;
  const y = (16 - height * scale) / 2;
  // The nested SVG is already validated. Only fixed local alpha-mask markup is
  // added here; the general SVG upload parser still refuses nested documents.
  return Buffer.from(
    `<svg xmlns="${SVG_NAMESPACE}" width="16" height="16" viewBox="0 0 16 16">` +
      `<defs><mask id="${id}" x="0" y="0" width="16" height="16" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" mask-type="alpha" style="mask-type:alpha">` +
      `<g transform="translate(${x} ${y}) scale(${scale})">${original.bytes.toString('utf8')}</g>` +
      `</mask></defs><rect x="0" y="0" width="16" height="16" fill="#000000" mask="url(#${id})"></rect></svg>`,
    'utf8',
  );
}
