import { z } from 'zod';
import {
  CONTENT_LIMITS,
  ManagedMediaPathSchema,
  NonBlankStringSchema,
  Sha256Schema,
  UuidSchema,
  uniqueStrings,
} from './common.js';

const sourceName = z
  .string()
  .max(255)
  .regex(/^original\.(?:jpe?g|png|webp|avif|svg|ico|mp4|mov|webm)$/);
const mediaBase = z.strictObject({
  schemaVersion: z.literal(1),
  id: UuidSchema,
  kind: z.enum(['image', 'video']),
  source: sourceName,
  displayName: NonBlankStringSchema.max(200).optional(),
  posterTimeSeconds: z.number().finite().min(0).optional(),
});
export const MediaSourceSchema = mediaBase
  .superRefine((value, ctx) => {
    const extension = value.source.split('.').at(-1);
    const image = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'svg', 'ico'].includes(
      extension ?? '',
    );
    if ((value.kind === 'image') !== image)
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: '來源副檔名與媒體種類不符',
      });
    if (value.kind === 'image' && value.posterTimeSeconds !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['posterTimeSeconds'],
        message: '圖片不可指定 poster 時間',
      });
  })
  .transform((value) => ({
    ...value,
    displayName: value.displayName ?? value.source,
  }));
export const MediaOutputSchema = z
  .strictObject({
    publicPath: ManagedMediaPathSchema,
    mimeType: z.enum([
      'image/webp',
      'image/png',
      'image/svg+xml',
      'image/x-icon',
      'video/webm',
    ]),
    width: z.number().int().min(1).max(12_000),
    height: z.number().int().min(1).max(12_000),
    byteSize: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sha256: Sha256Schema,
    durationSeconds: z.number().finite().positive().max(601).optional(),
  })
  .superRefine((value, ctx) => {
    const video = value.publicPath.endsWith('video.webm');
    if (video !== (value.mimeType === 'video/webm'))
      ctx.addIssue({
        code: 'custom',
        path: ['mimeType'],
        message: '媒體路徑與 MIME 不符',
      });
    const pngSizes: Readonly<Record<string, number>> = {
      'favicon.png': 32,
      'favicon-16.png': 16,
      'favicon-48.png': 48,
      'apple-touch-icon.png': 180,
      'icon-192.png': 192,
      'icon-512.png': 512,
    };
    const expectedPngSize = pngSizes[value.publicPath.split('/').at(-1) ?? ''];
    if ((expectedPngSize !== undefined) !== (value.mimeType === 'image/png'))
      ctx.addIssue({
        code: 'custom',
        path: ['mimeType'],
        message: 'PNG 輸出必須使用已註冊圖示檔名',
      });
    if (
      expectedPngSize !== undefined &&
      (value.width !== expectedPngSize || value.height !== expectedPngSize)
    )
      ctx.addIssue({
        code: 'custom',
        message: `圖示必須為 ${expectedPngSize} × ${expectedPngSize}`,
      });
    const svg = /\/(?:image|mask-icon)\.svg$/u.test(value.publicPath);
    const ico = value.publicPath.endsWith('/favicon.ico');
    if (
      svg !== (value.mimeType === 'image/svg+xml') ||
      ico !== (value.mimeType === 'image/x-icon')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['mimeType'],
        message: '原生圖片路徑與 MIME 不符',
      });
    if (
      value.publicPath.endsWith('/mask-icon.svg') &&
      (value.width !== 16 || value.height !== 16)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Safari mask 圖示必須為 16 × 16',
      });
    if (ico && (value.width > 256 || value.height > 256))
      ctx.addIssue({
        code: 'custom',
        message: 'ICO 圖示尺寸不得超過 256 × 256',
      });
    if (
      /\/image-social(?:-crop)?\.webp$/u.test(value.publicPath) &&
      (value.width !== 1200 || value.height !== 630)
    )
      ctx.addIssue({
        code: 'custom',
        message: '分享圖片必須為 1200 × 630',
      });
    if (video && value.durationSeconds === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message: '影片輸出必須有時長',
      });
    if (!video && value.durationSeconds !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message: '靜態圖片不可有時長',
      });
  });
export const MediaToolsSchema = z
  .strictObject({
    sharp: NonBlankStringSchema.max(100).optional(),
    libvips: NonBlankStringSchema.max(100).optional(),
    ffmpeg: NonBlankStringSchema.max(200).optional(),
    ffprobe: NonBlankStringSchema.max(200).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '必須記錄實際處理工具版本');
export const MediaAssetSchema = z
  .strictObject({
    id: UuidSchema,
    kind: z.enum(['image', 'video']),
    sourceSha256: Sha256Schema,
    presetVersion: NonBlankStringSchema.max(100),
    tools: MediaToolsSchema,
    outputs: z.array(MediaOutputSchema).min(1).max(20),
  })
  .superRefine((value, ctx) => {
    if (!uniqueStrings(value.outputs.map((output) => output.publicPath)))
      ctx.addIssue({
        code: 'custom',
        path: ['outputs'],
        message: '媒體輸出路徑不可重複',
      });
    for (const [index, output] of value.outputs.entries()) {
      if (!output.publicPath.startsWith(`/media/${value.id}/`))
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', index, 'publicPath'],
          message: '輸出必須屬於同一媒體 ID',
        });
      if (
        value.kind === 'image' &&
        !/\/(?:image(?:-(?:[1-9]\d*|social(?:-crop)?))?\.webp|(?:image|mask-icon)\.svg|favicon\.(?:png|ico)|favicon-(?:16|48)\.png|apple-touch-icon\.png|icon-(?:192|512)\.png)$/.test(
          output.publicPath,
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', index, 'publicPath'],
          message: '圖片 asset 只允許 image 與 favicon 變體',
        });
      if (
        value.kind === 'video' &&
        (/\/image-social(?:-crop)?\.webp$/u.test(output.publicPath) ||
          output.mimeType === 'image/png' ||
          output.mimeType === 'image/svg+xml' ||
          output.mimeType === 'image/x-icon')
      )
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', index, 'publicPath'],
          message: '分享圖片與 favicon 只允許圖片來源',
        });
    }
    if (
      value.kind === 'video' &&
      (!value.outputs.some((output) =>
        output.publicPath.endsWith('/video.webm'),
      ) ||
        !value.outputs.some((output) =>
          output.publicPath.endsWith('/poster.webp'),
        ))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['outputs'],
        message: '影片 asset 必須同時有 video 與 poster',
      });
    }
    if (
      value.kind === 'image' &&
      !value.outputs.some((output) => output.publicPath.endsWith('/image.webp'))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['outputs'],
        message: '圖片 asset 必須有標準 image.webp',
      });
  });
export const MediaManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    assets: z.array(MediaAssetSchema),
  })
  .refine(
    (value) => uniqueStrings(value.assets.map((asset) => asset.id)),
    '媒體 ID 不可重複',
  );
export const MediaSourceUpdateSchema = z.strictObject({
  displayName: NonBlankStringSchema.max(200),
  posterTimeSeconds: z.number().finite().min(0).optional(),
});

/** 媒體庫對外資料；原檔位置與私有 cache／binding 不在此契約。 */
export const MediaSourceResourceSchema = z
  .strictObject({
    id: UuidSchema,
    kind: z.enum(['image', 'video']),
    displayName: NonBlankStringSchema.max(200),
    posterTimeSeconds: z.number().finite().min(0).nullable(),
    mimeType: z.enum([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/avif',
      'image/svg+xml',
      'image/x-icon',
      'video/mp4',
      'video/quicktime',
      'video/webm',
    ]),
    byteSize: z.number().int().positive().max(CONTENT_LIMITS.videoSourceBytes),
    width: z.number().int().positive().max(12_000),
    height: z.number().int().positive().max(12_000),
    durationSeconds: z.number().finite().positive().max(600).nullable(),
    sourceSha256: Sha256Schema,
    asset: MediaAssetSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const image = value.kind === 'image';
    if (image !== value.mimeType.startsWith('image/'))
      ctx.addIssue({
        code: 'custom',
        path: ['mimeType'],
        message: '來源種類與實際 MIME 不符',
      });
    if (image) {
      if (value.durationSeconds !== null || value.posterTimeSeconds !== null)
        ctx.addIssue({
          code: 'custom',
          message: '靜態圖片不可有片長或 poster 時間',
        });
      if (
        value.byteSize > CONTENT_LIMITS.imageSourceBytes ||
        value.width * value.height > 40_000_000
      )
        ctx.addIssue({ code: 'custom', message: '圖片超出來源大小或像素上限' });
    } else {
      if (
        value.width < 2 ||
        value.height < 2 ||
        value.width > 4096 ||
        value.height > 4096 ||
        value.width * value.height > 8_300_000
      )
        ctx.addIssue({ code: 'custom', message: '影片超出來源尺寸或像素限制' });
      if (value.durationSeconds === null)
        ctx.addIssue({
          code: 'custom',
          path: ['durationSeconds'],
          message: '影片必須有實際片長',
        });
      else if (
        value.posterTimeSeconds !== null &&
        value.posterTimeSeconds >= value.durationSeconds
      )
        ctx.addIssue({
          code: 'custom',
          path: ['posterTimeSeconds'],
          message: 'Poster 時間必須小於片長',
        });
    }
    if (
      value.asset !== null &&
      (value.asset.id !== value.id ||
        value.asset.kind !== value.kind ||
        value.asset.sourceSha256 !== value.sourceSha256)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['asset'],
        message: '處理結果必須屬於目前來源及版本',
      });
  });
