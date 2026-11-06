import { describe, expect, it } from 'vitest';
import {
  ManagedImagePathSchema,
  MediaAssetSchema,
  MediaOutputSchema,
  enhanceHtmlMedia,
  mediaImageGroup,
} from '../../packages/core/src/index.js';

const id = '1791257a-aa80-4d3e-9a57-6bd43999e023';
const prefix = `/media/${id}/`;
const output = (variant: string, width: number, height: number) => ({
  publicPath: prefix + variant,
  mimeType: variant === 'favicon.png' ? 'image/png' : 'image/webp',
  width,
  height,
  byteSize: 123,
  sha256: 'a'.repeat(64),
});
const legacy = MediaAssetSchema.parse({
  id,
  kind: 'image',
  sourceSha256: 'b'.repeat(64),
  presetVersion: 'article-image-v1',
  tools: { sharp: 'test' },
  outputs: [
    output('image.webp', 1280, 640),
    output('image-480.webp', 480, 240),
  ],
});
const asset = MediaAssetSchema.parse({
  ...legacy,
  presetVersion: 'article-image-v2',
  outputs: [
    ...legacy.outputs,
    output('image-social.webp', 1200, 630),
    output('image-social-crop.webp', 1200, 630),
    output('favicon.png', 32, 32),
  ],
});
const manifest = { schemaVersion: 1 as const, assets: [asset] };

describe('dedicated sharing and favicon image contracts', () => {
  it('accepts the exact variants and keeps legacy v1 assets valid', () => {
    for (const item of asset.outputs)
      expect(ManagedImagePathSchema.safeParse(item.publicPath).success).toBe(
        true,
      );
    expect(MediaAssetSchema.safeParse(legacy).success).toBe(true);
    for (const variant of ['favicon-64.png', 'image-social.png', 'favicon.svg'])
      expect(ManagedImagePathSchema.safeParse(prefix + variant).success).toBe(
        false,
      );
    expect(mediaImageGroup(prefix + 'image-social-crop.webp')).toBe('social');
  });

  it('enforces dedicated dimensions and the real PNG MIME', () => {
    for (const variant of ['image-social.webp', 'image-social-crop.webp'])
      expect(
        MediaOutputSchema.safeParse(output(variant, 1200, 629)).success,
      ).toBe(false);
    for (const change of [
      { width: 16 },
      { height: 31 },
      { mimeType: 'image/webp' },
    ])
      expect(
        MediaOutputSchema.safeParse({
          ...output('favicon.png', 32, 32),
          ...change,
        }).success,
      ).toBe(false);
    expect(
      MediaOutputSchema.safeParse({
        ...output('image.webp', 32, 32),
        mimeType: 'image/png',
      }).success,
    ).toBe(false);
  });

  it('keeps article, padded, cropped and favicon compositions out of each other’s srcset', () => {
    const standard = enhanceHtmlMedia(
      `<img src="${prefix}image.webp" alt="一般文章圖片">`,
      manifest,
    );
    expect(standard.diagnostics).toEqual([]);
    expect(standard.contentHtml).toContain(
      `srcset="${prefix}image-480.webp 480w, ${prefix}image.webp 1280w"`,
    );
    expect(standard.contentHtml).not.toContain('image-social');
    expect(standard.contentHtml).not.toContain('favicon.png');
    for (const variant of [
      'image-social.webp',
      'image-social-crop.webp',
      'favicon.png',
    ]) {
      const selected = asset.outputs.find(
        (item) => item.publicPath === prefix + variant,
      );
      if (!selected) throw new Error('Missing special fixture');
      const enhanced = enhanceHtmlMedia(
        `<img src="${selected.publicPath}" type="${selected.mimeType}" alt="獨立尺寸">`,
        manifest,
      );
      expect(enhanced.diagnostics).toEqual([]);
      expect(enhanced.contentHtml).toContain(
        `srcset="${selected.publicPath} ${selected.width}w"`,
      );
      expect(enhanced.mediaRefs).toEqual([selected.publicPath]);
    }
    const png = enhanceHtmlMedia(
      `<picture><source type="image/png" srcset="${prefix}favicon.png 32w"><img src="${prefix}favicon.png" alt="PNG"></picture>`,
      manifest,
    );
    expect(png.diagnostics).toEqual([]);
    // A picture source compares its declaration against the actual PNG output.
    const wrongPicture = enhanceHtmlMedia(
      `<picture><source type="image/webp" srcset="${prefix}favicon.png 32w"><img src="${prefix}favicon.png" alt="PNG"></picture>`,
      manifest,
    );
    expect(wrongPicture.diagnostics.map(({ code }) => code)).toContain(
      'MEDIA_TYPE_MISMATCH',
    );
  });
});
