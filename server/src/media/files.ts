import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { safePath } from '../files/io.js';
import { MediaError } from './errors.js';
import type { Binding, MediaFile } from './types.js';

export async function openMediaVariant(
  root: string,
  binding: Binding,
  variant: string,
  range?: string,
): Promise<MediaFile> {
  if (
    !/^(?:image(?:-(?:[1-9]\d*|social(?:-crop)?))?\.webp|(?:image|mask-icon)\.svg|favicon\.(?:png|ico)|favicon-(?:16|48)\.png|apple-touch-icon\.png|icon-(?:192|512)\.png|video\.webm|poster\.webp)$/u.test(
      variant,
    )
  )
    throw new MediaError('MEDIA_NOT_FOUND', '媒體變體不存在。', 404);
  const output = binding.asset.outputs.find(
    (item) => item.publicPath === `/media/${binding.asset.id}/${variant}`,
  );
  if (output === undefined)
    throw new MediaError('MEDIA_NOT_FOUND', '媒體變體不存在。', 404);
  const handle = await open(
    await safePath(root, `.alfred/media/${binding.processingHash}/${variant}`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== output.byteSize)
      throw new MediaError('MEDIA_NOT_FOUND', '媒體變體無法讀取。', 404);
    let start = 0;
    let end = stat.size - 1;
    let status: 200 | 206 = 200;
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
      if (
        match === null ||
        ((match[1] ?? '') === '' && (match[2] ?? '') === '')
      )
        throw new MediaRangeError(stat.size);
      if (match[1] === '') {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0)
          throw new MediaRangeError(stat.size);
        start = Math.max(0, stat.size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? end : Number(match[2]);
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start >= stat.size ||
          start > end
        )
          throw new MediaRangeError(stat.size);
        end = Math.min(end, stat.size - 1);
      }
      status = 206;
    }
    return {
      stream: handle.createReadStream({ start, end, autoClose: true }),
      output,
      status,
      headers: {
        'Content-Type': output.mimeType,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        ...(output.mimeType === 'image/svg+xml'
          ? {
              'Content-Security-Policy':
                "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            }
          : {}),
        ...(status === 206
          ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` }
          : {}),
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export class MediaRangeError extends MediaError {
  readonly contentRange: string;
  constructor(size: number) {
    super('MEDIA_RANGE_NOT_SATISFIABLE', '媒體範圍無效或超出檔案。', 416);
    this.contentRange = `bytes */${size}`;
  }
}
