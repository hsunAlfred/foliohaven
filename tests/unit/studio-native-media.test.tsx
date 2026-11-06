import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MediaOutput, MediaSourceResource } from '@foliohaven/core';
import { StudioApi } from '../../studio/src/api.js';
import { MediaUploadDialog } from '../../studio/src/MediaUpload.js';
import {
  canPreviewMediaUpload,
  imageOutputs,
  imageSizeLabel,
  mediaUploadFile,
  nativeImage,
  needsPreferredImages,
  preferredImage,
  primaryImage,
  thumbnailImage,
} from '../../studio/src/media-display.js';
import { mediaMarkup } from '../../studio/src/media-markup.js';

const id = '1791257a-aa80-4d3e-9a57-6bd43999e023';
function output(
  variant: string,
  width: number,
  height: number,
  mimeType: MediaOutput['mimeType'] = 'image/webp',
): MediaOutput {
  return {
    publicPath: `/media/${id}/${variant}`,
    mimeType,
    width,
    height,
    byteSize: 100,
    sha256: 'a'.repeat(64),
  };
}
function source(
  mimeType: MediaSourceResource['mimeType'],
  native: MediaOutput,
): MediaSourceResource {
  const width = Math.min(1280, native.width);
  const height = Math.round((native.height * width) / native.width);
  return {
    id,
    kind: 'image',
    displayName: '原生品牌圖示',
    mimeType,
    byteSize: 2000,
    width: native.width,
    height: native.height,
    posterTimeSeconds: null,
    durationSeconds: null,
    sourceSha256: 'b'.repeat(64),
    asset: {
      id,
      kind: 'image',
      sourceSha256: 'b'.repeat(64),
      presetVersion: 'article-image-v3',
      tools: { sharp: 'test' },
      outputs: [
        native,
        output('image.webp', width, height),
        ...(native.width > 480
          ? [
              output(
                'image-480.webp',
                480,
                Math.round((native.height * 480) / native.width),
              ),
            ]
          : []),
        output('image-social.webp', 1200, 630),
        output('image-social-crop.webp', 1200, 630),
        output('favicon.png', 32, 32, 'image/png'),
      ],
    },
  };
}

describe('Studio SVG and ICO media support', () => {
  it.each([
    ['logo.svg', 'image/svg+xml'],
    ['ICON.ICO', 'image/x-icon'],
    ['icon.bin', 'image/vnd.microsoft.icon'],
    ['image.png', 'image/svg+xml'],
    ['logo.svg', 'image/png'],
    ['icon.ico', ''],
  ])('does not render an unverified local %s (%s) upload', (name, type) => {
    expect(canPreviewMediaUpload({ name, type })).toBe(false);
  });

  it('keeps existing raster and video upload previews available', () => {
    expect(
      canPreviewMediaUpload({ name: 'photo.png', type: 'image/png' }),
    ).toBe(true);
    expect(
      canPreviewMediaUpload({ name: 'video.mp4', type: 'video/mp4' }),
    ).toBe(true);
  });

  it.each([
    ['logo.svg', 'image/svg+xml'],
    ['icon.ICO', 'image/x-icon'],
  ])(
    'declares a missing browser MIME for %s without changing the bytes',
    async (name, mimeType) => {
      const original = new File([new Uint8Array([1, 2, 3])], name, {
        lastModified: 123,
      });
      const prepared = mediaUploadFile(original);
      expect(prepared.type).toBe(mimeType);
      expect(prepared.name).toBe(name);
      expect(prepared.lastModified).toBe(123);
      expect(await prepared.arrayBuffer()).toEqual(
        await original.arrayBuffer(),
      );
      expect(original.type).toBe('');
    },
  );

  it('does not rewrite an explicit or unrelated upload MIME', () => {
    for (const file of [
      new File(['data'], 'logo.svg', { type: 'image/png' }),
      new File(['data'], 'icon.ico', { type: 'image/vnd.microsoft.icon' }),
      new File(['data'], 'icon.ico', { type: 'application/octet-stream' }),
      new File(['data'], 'photo.png'),
    ])
      expect(mediaUploadFile(file)).toBe(file);
  });

  it('offers SVG and ICO in both upload modes while keeping the image-only video restriction', () => {
    for (const imagesOnly of [false, true]) {
      const html = renderToStaticMarkup(
        <MediaUploadDialog
          api={new StudioApi()}
          writable
          imagesOnly={imagesOnly}
          onClose={() => undefined}
          onUploaded={() => undefined}
        />,
      );
      expect(html).toContain('.avif,.svg,.ico');
      expect(html.includes('.mp4,.mov,.webm')).toBe(!imagesOnly);
      expect(html).toContain('SVG、ICO');
    }
  });

  it.each([
    ['image/svg+xml', 'image.svg', 'SVG・向量圖'],
    ['image/x-icon', 'favicon.ico', 'ICO・原生圖示'],
  ] as const)(
    'offers the native %s favicon while retaining the PNG option',
    (mimeType, variant, label) => {
      const native =
        mimeType === 'image/x-icon'
          ? output(variant, 256, 256, mimeType)
          : output(variant, 1600, 900, mimeType);
      const media = source(mimeType, native);
      expect(imageOutputs(media)).toContain(native);
      expect(nativeImage(media)).toBe(native);
      expect(preferredImage(media, 'favicon')).toBe(native);
      expect(imageSizeLabel(native.publicPath)).toBe(label);
      expect(
        imageOutputs(media).some((item) =>
          item.publicPath.endsWith('/favicon.png'),
        ),
      ).toBe(true);
      expect(needsPreferredImages(media, 'favicon')).toBe(false);
      expect(preferredImage(media, 'social')?.publicPath).toMatch(
        /\/image-social\.webp$/u,
      );
      expect(preferredImage(media, undefined)).toBe(primaryImage(media));
    },
  );

  it('continues to preview ordinary WebP derivatives of a native source', () => {
    const media = source(
      'image/svg+xml',
      output('image.svg', 1600, 900, 'image/svg+xml'),
    );
    expect(thumbnailImage(media)?.publicPath).toMatch(/\/image-480\.webp$/u);
    expect(primaryImage(media)?.publicPath).toMatch(/\/image\.webp$/u);
  });

  it('does not mix native images, favicon or sharing compositions into copied responsive HTML', () => {
    const media = source(
      'image/svg+xml',
      output('image.svg', 1600, 900, 'image/svg+xml'),
    );
    if (!media.asset) throw new Error('Missing fixture asset');
    const html = mediaMarkup({
      ...media.asset,
      outputs: [
        ...media.asset.outputs,
        output('favicon.ico', 256, 256, 'image/x-icon'),
      ],
    });
    expect(html).toContain(`src="/media/${id}/image.webp"`);
    expect(html).toContain(
      `srcset="/media/${id}/image-480.webp 480w, /media/${id}/image.webp 1280w"`,
    );
    expect(html).not.toMatch(/image\.svg|favicon\.(?:png|ico)|image-social/u);
  });
});
