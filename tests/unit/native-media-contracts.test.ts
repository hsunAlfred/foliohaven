import { describe, expect, it } from 'vitest';
import {
  ManagedImagePathSchema,
  MediaAssetSchema,
  MediaOutputSchema,
  MediaSourceResourceSchema,
  MediaSourceSchema,
  SiteConfigSchema,
  enhanceHtmlMedia,
  mediaImageGroup,
} from '../../packages/core/src/index.js';

const id = '19803324-6940-47ed-b689-c0e7503a0786';
const prefix = `/media/${id}/`;
const output = (
  variant: string,
  mimeType: string,
  width = 512,
  height = width,
) => ({
  publicPath: prefix + variant,
  mimeType,
  width,
  height,
  byteSize: 123,
  sha256: 'a'.repeat(64),
});
const source = {
  id,
  kind: 'image',
  displayName: 'Native brand icon',
  posterTimeSeconds: null,
  byteSize: 123,
  width: 512,
  height: 512,
  durationSeconds: null,
  sourceSha256: 'b'.repeat(64),
  asset: null,
};

describe('native SVG and ICO media contracts', () => {
  it.each([
    ['svg', 'image.svg', 'image/svg+xml', 512],
    ['ico', 'favicon.ico', 'image/x-icon', 256],
  ] as const)(
    'accepts managed %s sources and their actual MIME',
    (extension, variant, mimeType, width) => {
      expect(
        MediaSourceSchema.safeParse({
          schemaVersion: 1,
          id,
          kind: 'image',
          source: `original.${extension}`,
        }).success,
      ).toBe(true);
      expect(
        MediaSourceSchema.safeParse({
          schemaVersion: 1,
          id,
          kind: 'video',
          source: `original.${extension}`,
        }).success,
      ).toBe(false);
      expect(
        MediaSourceResourceSchema.safeParse({
          ...source,
          mimeType,
          width,
          height: width,
        }).success,
      ).toBe(true);
      expect(
        MediaOutputSchema.safeParse(output(variant, mimeType, width)).success,
      ).toBe(true);
      expect(ManagedImagePathSchema.safeParse(prefix + variant).success).toBe(
        true,
      );
      expect(mediaImageGroup(prefix + variant)).toBe('native');
      expect(
        MediaOutputSchema.safeParse(output(variant, 'image/webp', width))
          .success,
      ).toBe(false);
      expect(
        MediaOutputSchema.safeParse(output('image.webp', mimeType, width))
          .success,
      ).toBe(false);
      expect(
        MediaSourceResourceSchema.safeParse({
          ...source,
          kind: 'video',
          mimeType,
          width,
          height: width,
        }).success,
      ).toBe(false);
    },
  );

  it('does not allow arbitrary native filenames or oversized ICO outputs', () => {
    for (const variant of [
      'original.svg',
      'favicon.svg',
      'image.ico',
      'favicon-64.ico',
    ])
      expect(ManagedImagePathSchema.safeParse(prefix + variant).success).toBe(
        false,
      );
    expect(
      MediaOutputSchema.safeParse(output('favicon.ico', 'image/x-icon', 257))
        .success,
    ).toBe(false);
  });

  it.each([
    ['image.svg', 'image/svg+xml', 512],
    ['favicon.ico', 'image/x-icon', 256],
  ] as const)(
    'keeps %s separate from all responsive compositions',
    (variant, mimeType, width) => {
      const asset = MediaAssetSchema.parse({
        id,
        kind: 'image',
        sourceSha256: 'b'.repeat(64),
        presetVersion: 'article-image-v3',
        tools: { sharp: 'test' },
        outputs: [
          output('image.webp', 'image/webp'),
          output('image-480.webp', 'image/webp', 480),
          output('favicon.png', 'image/png', 32),
          output(variant, mimeType, width),
        ],
      });
      const manifest = { schemaVersion: 1 as const, assets: [asset] };
      const native = enhanceHtmlMedia(
        `<img src="${prefix}${variant}" alt="Brand">`,
        manifest,
      );
      expect(native.diagnostics).toEqual([]);
      expect(native.contentHtml).not.toContain('image-480.webp');
      const regular = enhanceHtmlMedia(
        `<img src="${prefix}image.webp" alt="Brand">`,
        manifest,
      );
      expect(regular.diagnostics).toEqual([]);
      expect(regular.contentHtml).toContain('image-480.webp');
      expect(regular.contentHtml).not.toContain(variant);
      expect(regular.contentHtml).not.toContain('favicon.png');
    },
  );

  it('accepts native favicon fields through the same site contract', () => {
    for (const variant of ['image.svg', 'favicon.ico']) {
      const result = SiteConfigSchema.safeParse({
        siteName: 'Native media fixture',
        siteDescription: 'Brand settings',
        siteUrl: 'https://example.invalid/',
        author: { name: 'Author' },
        favicon: prefix + variant,
      });
      expect(result.success).toBe(true);
    }
  });
});
