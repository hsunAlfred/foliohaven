import { describe, expect, it } from 'vitest';
import {
  analyzeHtml,
  MediaOutputSchema,
  MediaSourceResourceSchema,
} from '../../packages/core/src/index.js';

const image = {
  id: 'f2e005be-976b-4db0-a0bb-29376d64a024',
  kind: 'image',
  displayName: '透明圖片',
  posterTimeSeconds: null,
  mimeType: 'image/png',
  byteSize: 123,
  width: 1280,
  height: 720,
  durationSeconds: null,
  sourceSha256: 'a'.repeat(64),
  asset: null,
};
const video = {
  ...image,
  kind: 'video',
  mimeType: 'video/mp4',
  durationSeconds: 2,
};

describe('safe media source resource', () => {
  it('keeps invalid draft URL values visible for conservative deletion checks', () => {
    const ref = `/media/${image.id}/image.webp?editing=1`;
    const result = analyzeHtml(
      `<img alt="" src="${ref}"><source srcset="/media/${image.id}/image-480.webp#draft 480w junk, ${ref} 1x">`,
      { mode: 'draft' },
    );
    expect(result.mediaReferenceValues).toContain(ref);
    expect(result.mediaReferenceValues).toContain(
      `/media/${image.id}/image-480.webp#draft`,
    );
    expect(result.mediaRefs).not.toContain(ref);
    expect(
      result.diagnostics.some(
        (item) => item.code === 'MEDIA_REFERENCE_INVALID',
      ),
    ).toBe(true);
  });
  it('records real output container padding while keeping the 600-second source limit', () => {
    const output = {
      publicPath: `/media/${image.id}/video.webm`,
      mimeType: 'video/webm',
      width: 16,
      height: 16,
      byteSize: 100,
      sha256: 'a'.repeat(64),
      durationSeconds: 600.008,
    };
    expect(MediaOutputSchema.safeParse(output).success).toBe(true);
    expect(
      MediaOutputSchema.safeParse({ ...output, durationSeconds: 601.001 })
        .success,
    ).toBe(false);
    expect(
      MediaSourceResourceSchema.safeParse({
        ...video,
        durationSeconds: 600.008,
      }).success,
    ).toBe(false);
  });
  it('accepts measured image and video data with explicit nullable fields', () => {
    expect(MediaSourceResourceSchema.parse(image)).toEqual(image);
    expect(MediaSourceResourceSchema.parse(video)).toEqual(video);
  });
  it('rejects private paths and MIME mismatches', () => {
    expect(
      MediaSourceResourceSchema.safeParse({
        ...image,
        sourcePath: '/private/original.png',
      }).success,
    ).toBe(false);
    expect(
      MediaSourceResourceSchema.safeParse({ ...image, mimeType: 'video/webm' })
        .success,
    ).toBe(false);
  });
  it('rejects image timing data and excessive source bytes or pixels', () => {
    for (const override of [
      { posterTimeSeconds: 0 },
      { durationSeconds: 1 },
      { byteSize: 25 * 1024 ** 2 + 1 },
      { width: 10_000, height: 5_000 },
    ])
      expect(
        MediaSourceResourceSchema.safeParse({ ...image, ...override }).success,
      ).toBe(false);
  });
  it('requires real duration and a valid poster time for video', () => {
    expect(
      MediaSourceResourceSchema.safeParse({ ...video, durationSeconds: null })
        .success,
    ).toBe(false);
    expect(
      MediaSourceResourceSchema.safeParse({ ...video, posterTimeSeconds: 2 })
        .success,
    ).toBe(false);
    expect(
      MediaSourceResourceSchema.safeParse({ ...video, posterTimeSeconds: 1 })
        .success,
    ).toBe(true);
  });
  it('rejects video dimensions that cannot fit the fixed preset', () => {
    for (const override of [
      { width: 1 },
      { height: 4097 },
      { width: 4096, height: 2160 },
    ])
      expect(
        MediaSourceResourceSchema.safeParse({ ...video, ...override }).success,
      ).toBe(false);
  });
  it('rejects a completed asset belonging to another source version', () => {
    const asset = {
      id: image.id,
      kind: 'image',
      sourceSha256: 'b'.repeat(64),
      presetVersion: 'test-1',
      tools: { sharp: '0.35.5' },
      outputs: [
        {
          publicPath: `/media/${image.id}/image.webp`,
          mimeType: 'image/webp',
          width: 1280,
          height: 720,
          byteSize: 123,
          sha256: 'c'.repeat(64),
        },
      ],
    };
    expect(
      MediaSourceResourceSchema.safeParse({ ...image, asset }).success,
    ).toBe(false);
  });
});
