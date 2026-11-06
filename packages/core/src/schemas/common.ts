import { z } from 'zod';

export const CONTENT_LIMITS = Object.freeze({
  articleMetaBytes: 64 * 1024,
  articleHtmlBytes: 5 * 1024 * 1024,
  siteBytes: 256 * 1024,
  pageBytes: 256 * 1024,
  mediaMetaBytes: 16 * 1024,
  taxonomyBytes: 4 * 1024 * 1024,
  articleCount: 10_000,
  publishedHtmlBytes: 256 * 1024 * 1024,
  loaderConcurrency: 8,
  imageSourceBytes: 25 * 1024 * 1024,
  videoSourceBytes: 512 * 1024 * 1024,
});
export const RESERVED_ROOTS: readonly string[] = Object.freeze([
  'category',
  'tag',
  'articles',
  'assets',
  'media',
  '_astro',
  'rss.xml',
  'search-index.json',
  'robots.txt',
  'sitemap-index.xml',
  '404.html',
  'site.webmanifest',
]);
const kebabPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ArticleIdSchema = z.string().min(1).max(80).regex(kebabPattern);
export const SlugSchema = ArticleIdSchema.refine(
  (value) => !/^\d+$/.test(value),
  'Slug 不得為純數字',
);
export const CategoryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, ctx) => {
    const segments = value.split('/');
    if (segments.some((segment) => !SlugSchema.safeParse(segment).success)) {
      ctx.addIssue({
        code: 'custom',
        message: '分類每段必須為合法且非純數字的 slug',
      });
    }
    if (segments[0] !== undefined && RESERVED_ROOTS.includes(segments[0])) {
      ctx.addIssue({ code: 'custom', message: '分類不得占用系統根命名空間' });
    }
  });
export const UuidSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), 'UUID 必須為小寫');
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const RevisionSchema = Sha256Schema;
export const ETagSchema = z.string().regex(/^"[a-f0-9]{64}"$/);
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
export const RelativeResourceSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !hasControlCharacters(value) &&
      value
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    '資源必須是安全的相對識別路徑',
  );
export const RootPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      value.endsWith('/') &&
      !/[\\?#%\s]/u.test(value) &&
      !hasControlCharacters(value) &&
      (value === '/' ||
        value
          .slice(1, -1)
          .split('/')
          .every((part) => part !== '' && part !== '.' && part !== '..')),
    '頁面 URL 必須為有尾斜線的站內絕對路徑',
  );
export const HttpUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (/[\s\\]/u.test(value) || hasControlCharacters(value)) return false;
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.username === '' &&
        url.password === ''
      );
    } catch {
      return false;
    }
  }, '必須為不含帳密的 HTTP(S) URL');
export const SiteUrlSchema = HttpUrlSchema.refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      value.endsWith('/')
    );
  } catch {
    return false;
  }
}, '網站網址必須為帶尾斜線、無子路徑或查詢的 origin');
export const ManagedMediaPathSchema = z
  .string()
  .regex(
    /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:image(?:-(?:[1-9]\d*|social(?:-crop)?))?\.webp|(?:image|mask-icon)\.svg|favicon\.(?:png|ico)|favicon-(?:16|48)\.png|apple-touch-icon\.png|icon-(?:192|512)\.png|video\.webm|poster\.webp)$/,
  );
export const ManagedImagePathSchema = ManagedMediaPathSchema.refine(
  (value) => /\.(?:webp|svg|ico|png)$/.test(value),
  '必須引用受管圖片',
);

/** Different image compositions must never become one responsive srcset. */
export function mediaImageGroup(
  path: string,
): 'responsive' | 'social' | 'favicon' | 'poster' | 'native' {
  if (/\/(?:image\.svg|favicon\.ico)$/u.test(path)) return 'native';
  if (
    /\/(?:mask-icon\.svg|favicon-(?:16|48)\.png|apple-touch-icon\.png|icon-(?:192|512)\.png)$/u.test(
      path,
    )
  )
    return 'favicon';
  if (/\/image-social(?:-crop)?\.webp$/u.test(path)) return 'social';
  if (path.endsWith('/favicon.png')) return 'favicon';
  if (path.endsWith('/poster.webp')) return 'poster';
  return 'responsive';
}
export const NonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, '不可只含空白');
export const DateTimeSchema = z
  .string()
  .max(64)
  .refine((value) => {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
        value,
      );
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    )
      return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day > (days[month - 1] ?? 0)) return false;
    const zone = match[8];
    if (
      zone !== 'Z' &&
      zone !== undefined &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)
    )
      return false;
    return Number.isFinite(Date.parse(value));
  }, '日期必須有真實年月日、明確時區，且精度最多毫秒（三位小數）');
export const UtcDateTimeSchema = DateTimeSchema.refine(
  (value) => value.endsWith('Z'),
  'API 日期必須使用 UTC Z',
);
export function toUtcDateTime(value: string): string {
  return new Date(DateTimeSchema.parse(value)).toISOString();
}
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
export const HtmlContentSchema = z.string().superRefine((value, ctx) => {
  if (value.includes('\r'))
    ctx.addIssue({
      code: 'custom',
      message: 'HTML 正文必須使用 LF，不接受 CRLF 或 CR',
    });
  if (value.includes('\u0000'))
    ctx.addIssue({ code: 'custom', message: 'HTML 正文不可含 NUL' });
  if (utf8ByteLength(value) > CONTENT_LIMITS.articleHtmlBytes)
    ctx.addIssue({ code: 'custom', message: 'HTML 正文超過 5 MiB' });
});
export const LanguageSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      return new Intl.Locale(value).toString().length > 0;
    } catch {
      return false;
    }
  }, '語言必須為有效 BCP 47');
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(value)) return false;
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, '時區必須為有效 IANA 名稱');
export function uniqueStrings(value: readonly string[]): boolean {
  return new Set(value).size === value.length;
}
export const PageSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const PageSizeSchema = z.number().int().min(1).max(100);
