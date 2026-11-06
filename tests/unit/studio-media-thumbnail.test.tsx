import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MediaOutput, MediaSourceResource } from '@foliohaven/core';
import { MediaThumbnail } from '../../studio/src/MediaThumbnail.js';
import {
  primaryImage,
  thumbnailImage,
} from '../../studio/src/media-display.js';

const id = 'b9b5681a-36f0-49bf-a715-7604db77a32f';
function output(
  name: string,
  width: number,
  height = Math.round(width * 0.75),
) {
  return {
    publicPath: `/media/${id}/${name}`,
    mimeType: name.endsWith('.png') ? 'image/png' : 'image/webp',
    width,
    height,
    byteSize: 100,
    sha256: 'a'.repeat(64),
  } satisfies MediaOutput;
}
function source(
  outputs: MediaOutput[],
  kind: MediaSourceResource['kind'] = 'image',
): MediaSourceResource {
  return {
    id,
    kind,
    displayName: '縮圖測試',
    posterTimeSeconds: null,
    mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
    byteSize: 1000,
    width: 2400,
    height: 1800,
    durationSeconds: kind === 'video' ? 2 : null,
    sourceSha256: 'a'.repeat(64),
    asset: {
      id,
      kind,
      sourceSha256: 'a'.repeat(64),
      presetVersion: 'test',
      tools: { sharp: 'test' },
      outputs,
    },
  };
}

describe('Studio media thumbnails', () => {
  it('selects the smallest standard image at least 480px wide without changing the primary image or output order', () => {
    const primary = output('image.webp', 1280);
    const small = output('image-480.webp', 480);
    const outputs = [
      output('image-1920.webp', 1920),
      primary,
      output('image-768.webp', 768),
      small,
    ];
    const originalOrder = [...outputs];
    const media = source(outputs);
    expect(thumbnailImage(media)).toBe(small);
    expect(primaryImage(media)).toBe(primary);
    expect(media.asset?.outputs).toEqual(originalOrder);
    const html = renderToStaticMarkup(<MediaThumbnail source={media} />);
    expect(html).toContain(`/api/v1/media/files/${id}/image-480.webp`);
    expect(html).toContain('width="480" height="360"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it('uses the next available standard size when no 480px output exists', () => {
    const medium = output('image-768.webp', 768);
    expect(
      thumbnailImage(
        source([
          output('image-320.webp', 320),
          output('image.webp', 1280),
          medium,
        ]),
      ),
    ).toBe(medium);
  });

  it('keeps small originals at their largest available standard size', () => {
    const primary = output('image.webp', 320);
    const media = {
      ...source([output('image-240.webp', 240), primary]),
      width: 320,
      height: 240,
    };
    expect(thumbnailImage(media)).toBe(primary);
  });

  it('falls back to a primary image when no smaller responsive variant is available', () => {
    const primary = output('image.webp', 1280);
    expect(thumbnailImage(source([primary]))).toBe(primary);
  });

  it('excludes favicon and both social compositions from default thumbnails', () => {
    const primary = output('image.webp', 1280);
    const media = source([
      output('favicon.png', 32, 32),
      output('image-social.webp', 1200, 630),
      output('image-social-crop.webp', 1200, 630),
      primary,
    ]);
    expect(thumbnailImage(media)).toBe(primary);
  });

  it('continues to use the poster for videos', () => {
    const poster = output('poster.webp', 1280, 720);
    const video: MediaOutput = {
      ...output('video.webm', 1280, 720),
      mimeType: 'video/webm',
      durationSeconds: 2,
    };
    const media = source([video, poster], 'video');
    expect(thumbnailImage(media)).toBe(poster);
    const html = renderToStaticMarkup(<MediaThumbnail source={media} />);
    expect(html).toContain(`/api/v1/media/files/${id}/poster.webp`);
    expect(html).toContain('width="1280" height="720"');
    expect(html).toContain('aria-label="影片"');
  });

  it.each([
    ['image-768.webp', 768, 576],
    ['image-social-crop.webp', 1200, 630],
    ['favicon.png', 32, 32],
  ] as const)(
    'preserves an explicit %s selection and its dimensions',
    (name, width, height) => {
      const selected = output(name, width, height);
      const media = source([
        output('image.webp', 1280),
        output('image-480.webp', 480),
        selected,
      ]);
      const html = renderToStaticMarkup(
        <MediaThumbnail source={media} path={selected.publicPath} />,
      );
      expect(html).toContain(`/api/v1/media/files/${id}/${name}`);
      expect(html).toContain(`width="${width}" height="${height}"`);
    },
  );

  it('leaves unavailable media in the waiting state', () => {
    const media = { ...source([]), asset: null };
    expect(thumbnailImage(media)).toBeUndefined();
    const html = renderToStaticMarkup(<MediaThumbnail source={media} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('等待處理');
  });
});
