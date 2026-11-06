import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProcessFailure, runControlledProcess } from '../runtime/process.js';
import { buildProcessEnvironment } from '../runtime/environment.js';
import { MediaError } from './errors.js';
import type { MediaInspection } from './types.js';
import type { WorkerInput, WorkerOutput, WorkerResult } from './process.js';
import { maskIconSvg, normalizeSvg } from './svg.js';
import { normalizeIco, pngFramesToIco } from './ico.js';
export type NativeImageFactory = typeof sharp;

const controller = new AbortController();
let activeCommands = 0;
let stopping = false;
let inheritedDescriptors = [3];
function stop() {
  stopping = true;
  controller.abort();
  // Sharp runs inside this process. External encoders must finish their
  // TERM/KILL-and-close lifecycle before the worker releases the inherited fd.
  if (activeCommands === 0) process.exit(1);
}
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
const progress = (stage: string, completed: number, total: number | null) =>
  process.stdout.write(
    `${JSON.stringify({ progress: { stage, completed, total } })}\n`,
  );
sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 20 });

async function command(
  name: 'ffmpeg' | 'ffprobe',
  args: readonly string[],
  timeoutMs = 10_000,
  maxOutputBytes = 1024 * 1024,
  onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void,
) {
  activeCommands++;
  try {
    return await runControlledProcess({
      command: name,
      args,
      cwd: process.cwd(),
      env: buildProcessEnvironment(),
      timeoutMs,
      signal: controller.signal,
      passFds: inheritedDescriptors,
      maxOutputBytes,
      ...(onOutput === undefined ? {} : { onOutput }),
    });
  } catch (error) {
    if (
      error instanceof ProcessFailure &&
      ['PROCESS_CANCELLED', 'PROCESS_TIMEOUT', 'PROCESS_UNAVAILABLE'].includes(
        error.code,
      )
    )
      throw error;
    throw new MediaError(
      'MEDIA_DECODE_FAILED',
      '媒體內容損壞、codec不支援或工具無法解碼。',
    );
  } finally {
    activeCommands--;
    if (stopping && activeCommands === 0) process.exit(1);
  }
}

async function header(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(65536);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
  }
}
function imageType(
  bytes: Buffer,
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif' {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    let position = 8;
    while (position + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(position);
      const type = bytes.toString('ascii', position + 4, position + 8);
      if (type === 'acTL')
        throw new MediaError('MEDIA_ANIMATION_UNSUPPORTED', '不支援動畫圖片。');
      if (type === 'IDAT') break;
      position += length + 12;
    }
    return 'image/png';
  }
  if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (
    bytes.toString('ascii', 4, 8) === 'ftyp' &&
    /avif|avis/u.test(
      bytes.toString('ascii', 8, Math.min(bytes.length, bytes.readUInt32BE(0))),
    )
  ) {
    if (bytes.toString('ascii', 8, 64).includes('avis'))
      throw new MediaError('MEDIA_ANIMATION_UNSUPPORTED', '不支援動畫AVIF。');
    return 'image/avif';
  }
  throw new MediaError(
    'MEDIA_FORMAT_UNSUPPORTED',
    '僅支援靜態JPEG、PNG、WebP與AVIF圖片。',
  );
}
const extensions: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
interface PreparedImage {
  readonly image: Buffer;
  readonly mimeType: 'image/svg+xml' | 'image/x-icon';
  readonly native: {
    readonly bytes: Buffer;
    readonly variant: 'image.svg' | 'favicon.ico';
    readonly mimeType: 'image/svg+xml' | 'image/x-icon';
  };
}
async function prepareImage(
  input: WorkerInput,
): Promise<PreparedImage | undefined> {
  if (input.extension === 'svg') {
    const bytes = normalizeSvg(await readFile(input.sourcePath));
    return {
      image: bytes,
      mimeType: 'image/svg+xml',
      native: { bytes, variant: 'image.svg', mimeType: 'image/svg+xml' },
    };
  }
  if (input.extension === 'ico') {
    const icon = await normalizeIco(await readFile(input.sourcePath));
    return {
      image: icon.image,
      mimeType: 'image/x-icon',
      native: {
        bytes: icon.bytes,
        variant: 'favicon.ico',
        mimeType: 'image/x-icon',
      },
    };
  }
  return undefined;
}
async function inspectImage(
  input: WorkerInput,
  prepared?: PreparedImage,
): Promise<MediaInspection> {
  const source = prepared?.image ?? input.sourcePath;
  const mimeType =
    prepared?.mimeType ?? imageType(await header(input.sourcePath));
  if (extensions[input.extension] !== mimeType)
    throw new MediaError(
      'MEDIA_EXTENSION_MISMATCH',
      '副檔名與實際圖片格式不符。',
    );
  const metadata = await sharp(source, {
    limitInputPixels: 40_000_000,
    failOn: 'warning',
  }).metadata();
  if (
    (metadata.pages ?? 1) !== 1 ||
    metadata.delay !== undefined ||
    metadata.loop !== undefined
  )
    throw new MediaError('MEDIA_ANIMATION_UNSUPPORTED', '不支援動畫圖片。');
  if (mimeType === 'image/avif' && metadata.compression !== 'av1')
    throw new MediaError('MEDIA_FORMAT_UNSUPPORTED', '不支援HEIC圖片。');
  const { width, height } = metadata.autoOrient;
  if (
    width < 1 ||
    height < 1 ||
    width > 12000 ||
    height > 12000 ||
    width * height > 40_000_000
  )
    throw new MediaError(
      'MEDIA_DIMENSIONS_EXCEEDED',
      '圖片超過單邊12000或4000萬像素限制。',
    );
  await sharp(source, {
    limitInputPixels: 40_000_000,
    failOn: 'warning',
  }).stats();
  return {
    kind: 'image',
    aspectRatio: width / height,
    mimeType,
    width,
    height,
    durationSeconds: null,
    fps: null,
    audio: false,
    streamIndex: null,
  };
}
interface ProbeStream {
  pix_fmt?: string;
  index: number;
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_aspect_ratio?: string;
  channels?: number;
  sample_rate?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number }[];
}
interface Probe {
  streams: ProbeStream[];
  format: {
    duration?: string;
    format_name?: string;
    tags?: { major_brand?: string };
  };
}
async function probe(path: string): Promise<Probe> {
  const result = await command('ffprobe', [
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-show_entries',
    'stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_aspect_ratio,channels,sample_rate:stream_disposition=attached_pic:stream_side_data=rotation:format=duration,format_name:format_tags=major_brand',
    '-of',
    'json',
    path,
  ]);
  const value: unknown = JSON.parse(result.stdout.toString('utf8'));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('streams' in value) ||
    !Array.isArray(value.streams) ||
    !('format' in value)
  )
    throw new MediaError('MEDIA_PROBE_INVALID', '影片無法取得完整軌道與時長。');
  return value as Probe;
}
function rational(value: string | undefined, fallback = NaN): number {
  if (value === undefined || value === 'N/A') return fallback;
  const parts = value.split(/[/:]/u).map(Number);
  return parts.length === 2
    ? Number(parts[0]) / Number(parts[1])
    : Number(parts[0]);
}
function ebmlValue(
  bytes: Buffer,
  offset: number,
  id = false,
): { value: number; length: number } | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  let mask = 0x80;
  let length = 1;
  while ((first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (length > (id ? 4 : 8) || offset + length > bytes.length) return null;
  let value = id ? first : first & (mask - 1);
  for (let index = 1; index < length; index++)
    value = value * 256 + (bytes[offset + index] ?? 0);
  if (!Number.isSafeInteger(value) || (!id && value === 2 ** (7 * length) - 1))
    return null;
  return { value, length };
}
/** Only the actual EBML header DocType identifies WebM, never a metadata string. */
function isWebm(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return false;
  const size = ebmlValue(bytes, 4);
  if (size === null) return false;
  let position = 4 + size.length;
  const end = position + size.value;
  if (end > bytes.length) return false;
  let docType: Buffer | undefined;
  while (position < end) {
    const id = ebmlValue(bytes, position, true);
    if (id === null) return false;
    position += id.length;
    const length = ebmlValue(bytes, position);
    if (length === null) return false;
    position += length.length;
    const next = position + length.value;
    if (next > end) return false;
    if (id.value === 0x4282) {
      if (docType !== undefined) return false;
      docType = bytes.subarray(position, next);
    }
    position = next;
  }
  return position === end && (docType?.equals(Buffer.from('webm')) ?? false);
}
async function inspectVideo(input: WorkerInput): Promise<MediaInspection> {
  const bytes = await header(input.sourcePath);
  const information = await probe(input.sourcePath);
  let mimeType: MediaInspection['mimeType'];
  if (information.format.format_name?.includes('matroska') && isWebm(bytes))
    mimeType = 'video/webm';
  else if (information.format.format_name?.includes('mov'))
    mimeType =
      information.format.tags?.major_brand?.trim() === 'qt' ||
      bytes.toString('ascii', 4, 8) !== 'ftyp'
        ? 'video/quicktime'
        : 'video/mp4';
  else
    throw new MediaError(
      'MEDIA_FORMAT_UNSUPPORTED',
      '僅支援MP4、MOV與WebM影片。',
    );
  if (extensions[input.extension] !== mimeType)
    throw new MediaError(
      'MEDIA_EXTENSION_MISMATCH',
      '副檔名與實際影片容器不符。',
    );
  const video = information.streams.find(
    (stream) =>
      stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  );
  if (video === undefined)
    throw new MediaError(
      'MEDIA_VIDEO_TRACK_REQUIRED',
      '影片必須有可解碼的影像軌。',
    );
  const duration = Number(information.format.duration);
  const fps = rational(video?.avg_frame_rate);
  let width = video?.width ?? 0;
  let height = video?.height ?? 0;
  const rotation =
    Math.abs(
      video?.side_data_list?.find((side) => side.rotation !== undefined)
        ?.rotation ?? 0,
    ) % 180;
  if (rotation === 90) [width, height] = [height, width];
  const sar = rational(video?.sample_aspect_ratio, 1);
  const aspectRatio = (width / height) * (rotation === 90 ? 1 / sar : sar);
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0)
    throw new MediaError('MEDIA_ASPECT_RATIO', '影片像素比例無法解析。');
  if (
    width < 2 ||
    height < 2 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 8_300_000
  )
    throw new MediaError(
      'MEDIA_DIMENSIONS_EXCEEDED',
      '影片尺寸必須至少2像素、單邊不超過4096且不超過830萬像素。',
    );
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 600 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > 60
  )
    throw new MediaError(
      'MEDIA_VIDEO_LIMIT',
      '影片必須有有效片長與幀率，最多600秒、60fps。',
    );
  if (
    input.posterTimeSeconds !== undefined &&
    (!Number.isFinite(input.posterTimeSeconds) ||
      input.posterTimeSeconds < 0 ||
      input.posterTimeSeconds >= duration)
  )
    throw new MediaError(
      'MEDIA_POSTER_TIME',
      'Poster時間必須大於等於零且小於片長。',
    );
  await command('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-protocol_whitelist',
    'file,pipe',
    '-i',
    input.sourcePath,
    '-map',
    `0:${video.index}`,
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ]);
  return {
    kind: 'video',
    aspectRatio,
    mimeType,
    width,
    height,
    durationSeconds: duration,
    fps,
    audio: information.streams.some((stream) => stream.codec_type === 'audio'),
    streamIndex: video.index,
  };
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function imageOutput(
  path: string,
  variant: string,
): Promise<WorkerOutput> {
  const metadata = await sharp(path, {
    failOn: 'warning',
    limitInputPixels: 40_000_000,
  }).metadata();
  const png = variant.endsWith('.png');
  if (metadata.format !== (png ? 'png' : 'webp') || (metadata.pages ?? 1) !== 1)
    throw new MediaError(
      'MEDIA_OUTPUT_INVALID',
      '圖片輸出不是有效的靜態圖片。',
      500,
    );
  await sharp(path, {
    failOn: 'warning',
    limitInputPixels: 40_000_000,
  }).stats();
  return {
    variant,
    mimeType: png ? 'image/png' : 'image/webp',
    width: metadata.width,
    height: metadata.height,
    byteSize: (await stat(path)).size,
    sha256: await digest(path),
  };
}
async function execute(input: WorkerInput): Promise<WorkerResult> {
  if (input.iconSet === true && input.kind !== 'image')
    throw new MediaError(
      'MEDIA_WORKER_PROTOCOL',
      '網站圖示只能使用圖片來源。',
      422,
    );
  const byteSize = (await stat(input.sourcePath)).size;
  if (
    byteSize <= 0 ||
    byteSize > (input.kind === 'image' ? 25 : 512) * 1024 * 1024
  )
    throw new MediaError(
      'MEDIA_SOURCE_TOO_LARGE',
      '來源檔案超出允許大小。',
      413,
    );
  const prepared =
    input.kind === 'image' ? await prepareImage(input) : undefined;
  const imageSource = prepared?.image ?? input.sourcePath;
  const inspection =
    input.kind === 'image'
      ? await inspectImage(input, prepared)
      : await inspectVideo(input);
  const tools: WorkerResult['tools'] = {
    sharp: sharp.versions.sharp,
    libvips: sharp.versions.vips,
    ...(input.kind === 'video'
      ? {
          ffmpeg:
            (await command('ffmpeg', ['-version'])).stdout
              .toString('utf8')
              .split('\n')[0] ?? 'unknown',
          ffprobe:
            (await command('ffprobe', ['-version'])).stdout
              .toString('utf8')
              .split('\n')[0] ?? 'unknown',
        }
      : {}),
  };
  if (input.action === 'inspect') return { inspection, outputs: [], tools };
  if (input.outputDirectory === undefined)
    throw new MediaError('MEDIA_WORKER_PROTOCOL', '媒體輸出設定不完整。', 500);
  const outputDirectory = input.outputDirectory;
  const outputs: WorkerOutput[] = [];
  if (input.kind === 'image') {
    const standard = Math.min(1280, inspection.width);
    const widths = [
      standard,
      ...[480, 768, 1920].filter(
        (width) => width < inspection.width && width !== standard,
      ),
    ];
    const iconSet = input.iconSet === true;
    const total =
      widths.length +
      3 +
      (prepared ? 1 : 0) +
      (iconSet
        ? 5 +
          (input.extension === 'ico' ? 0 : 1) +
          (input.extension === 'svg' ? 1 : 0)
        : 0);
    for (const [index, width] of widths.entries()) {
      const variant = width === standard ? 'image.webp' : `image-${width}.webp`;
      const path = join(input.outputDirectory, variant);
      if (input.action !== 'verify')
        await sharp(imageSource, {
          limitInputPixels: 40_000_000,
          failOn: 'warning',
        })
          .autoOrient()
          .toColourspace('srgb')
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: 80, alphaQuality: 100, effort: 4 })
          .toFile(path);
      const output = await imageOutput(path, variant);
      if (
        output.width !== width ||
        Math.abs(
          output.height - (inspection.height * width) / inspection.width,
        ) > 1
      )
        throw new MediaError(
          'MEDIA_OUTPUT_INVALID',
          '圖片輸出尺寸不符合固定preset。',
          500,
        );
      outputs.push(output);
      progress('images', index + 1, total);
    }
    for (const [index, variant] of [
      'image-social.webp',
      'image-social-crop.webp',
      'favicon.png',
    ].entries()) {
      const favicon = variant === 'favicon.png';
      const width = favicon ? 32 : 1200;
      const height = favicon ? 32 : 630;
      const path = join(input.outputDirectory, variant);
      if (input.action !== 'verify') {
        const background = favicon ? { r: 0, g: 0, b: 0, alpha: 0 } : '#ffffff';
        const pipeline = sharp(imageSource, {
          limitInputPixels: 40_000_000,
          failOn: 'warning',
        })
          .autoOrient()
          .toColourspace('srgb');
        if (!favicon) pipeline.flatten({ background });
        pipeline.resize({
          width,
          height,
          fit: variant === 'image-social-crop.webp' ? 'cover' : 'contain',
          withoutEnlargement: variant === 'image-social.webp',
          background,
        });
        if (favicon)
          await pipeline
            .ensureAlpha()
            .png({ compressionLevel: 9 })
            .toFile(path);
        else
          await pipeline
            .webp({ quality: 80, alphaQuality: 100, effort: 4 })
            .toFile(path);
      }
      const output = await imageOutput(path, variant);
      if (output.width !== width || output.height !== height)
        throw new MediaError(
          'MEDIA_OUTPUT_INVALID',
          '分享圖片或 favicon 尺寸不符合固定 preset。',
          500,
        );
      outputs.push(output);
      progress('images', widths.length + index + 1, total);
    }
    if (prepared !== undefined) {
      const path = join(input.outputDirectory, prepared.native.variant);
      if (input.action !== 'verify')
        await writeFile(path, prepared.native.bytes, { flag: 'wx' });
      const actual = await readFile(path);
      if (!actual.equals(prepared.native.bytes))
        throw new MediaError(
          'MEDIA_OUTPUT_INVALID',
          '原生圖片輸出不符合已驗證來源。',
          500,
        );
      outputs.push({
        variant: prepared.native.variant,
        mimeType: prepared.native.mimeType,
        width: inspection.width,
        height: inspection.height,
        byteSize: actual.length,
        sha256: await digest(path),
      });
      progress('images', widths.length + 4, total);
    }
    if (iconSet) {
      const recipes = [
        { variant: 'favicon-16.png', size: 16, opaque: false },
        { variant: 'favicon-48.png', size: 48, opaque: false },
        { variant: 'apple-touch-icon.png', size: 180, opaque: true },
        { variant: 'icon-192.png', size: 192, opaque: false },
        { variant: 'icon-512.png', size: 512, opaque: false },
      ];
      for (const recipe of recipes) {
        const path = join(input.outputDirectory, recipe.variant);
        if (input.action !== 'verify') {
          const background = recipe.opaque
            ? '#ffffff'
            : { r: 0, g: 0, b: 0, alpha: 0 };
          const pipeline = sharp(imageSource, {
            limitInputPixels: 40_000_000,
            failOn: 'warning',
          })
            .autoOrient()
            .toColourspace('srgb');
          if (recipe.opaque) pipeline.flatten({ background });
          pipeline.resize({
            width: recipe.size,
            height: recipe.size,
            fit: 'contain',
            background,
          });
          if (recipe.opaque) pipeline.removeAlpha();
          else pipeline.ensureAlpha();
          await pipeline.png({ compressionLevel: 9 }).toFile(path);
        }
        const output = await imageOutput(path, recipe.variant);
        if (output.width !== recipe.size || output.height !== recipe.size)
          throw new MediaError(
            'MEDIA_OUTPUT_INVALID',
            '網站圖示尺寸不符合固定 preset。',
            500,
          );
        if (recipe.opaque && (await sharp(path).metadata()).hasAlpha)
          throw new MediaError(
            'MEDIA_OUTPUT_INVALID',
            'Apple Touch Icon 必須使用不透明底色。',
            500,
          );
        outputs.push(output);
        progress('images', outputs.length, total);
      }
      if (input.extension !== 'ico') {
        const bytes = await pngFramesToIco(
          await Promise.all(
            ['favicon-16.png', 'favicon.png', 'favicon-48.png'].map((variant) =>
              readFile(join(outputDirectory, variant)),
            ),
          ),
        );
        const path = join(input.outputDirectory, 'favicon.ico');
        if (input.action !== 'verify')
          await writeFile(path, bytes, { flag: 'wx' });
        const actual = await readFile(path);
        if (!actual.equals(bytes))
          throw new MediaError(
            'MEDIA_OUTPUT_INVALID',
            'ICO 輸出不符合已驗證圖示尺寸。',
            500,
          );
        const icon = await normalizeIco(actual);
        outputs.push({
          variant: 'favicon.ico',
          mimeType: 'image/x-icon',
          width: icon.width,
          height: icon.height,
          byteSize: actual.length,
          sha256: await digest(path),
        });
        progress('images', outputs.length, total);
      }
      if (prepared?.mimeType === 'image/svg+xml') {
        const bytes = maskIconSvg(
          prepared.native.bytes,
          inspection.width,
          inspection.height,
        );
        const path = join(input.outputDirectory, 'mask-icon.svg');
        if (input.action !== 'verify')
          await writeFile(path, bytes, { flag: 'wx' });
        const actual = await readFile(path);
        const metadata = await sharp(actual, {
          failOn: 'warning',
          limitInputPixels: 40_000_000,
        }).metadata();
        if (
          !actual.equals(bytes) ||
          metadata.format !== 'svg' ||
          metadata.width !== 16 ||
          metadata.height !== 16
        )
          throw new MediaError(
            'MEDIA_OUTPUT_INVALID',
            'Safari 圖示不是有效的 16 × 16 靜態向量。',
            500,
          );
        await sharp(actual, {
          failOn: 'warning',
          limitInputPixels: 40_000_000,
        }).stats();
        outputs.push({
          variant: 'mask-icon.svg',
          mimeType: 'image/svg+xml',
          width: 16,
          height: 16,
          byteSize: actual.length,
          sha256: await digest(path),
        });
        progress('images', outputs.length, total);
      }
    }
  } else {
    const ratio = inspection.aspectRatio;
    const squareWidth = Math.min(inspection.width, inspection.height * ratio);
    const squareHeight = squareWidth / ratio;
    const factor = Math.min(
      1,
      1920 / Math.max(squareWidth, squareHeight),
      1080 / Math.min(squareWidth, squareHeight),
    );
    const width = Math.floor((squareWidth * factor) / 2) * 2;
    const height = Math.floor((squareHeight * factor) / 2) * 2;
    if (width < 2 || height < 2)
      throw new MediaError(
        'MEDIA_DIMENSIONS_EXCEEDED',
        '影片比例無法在不放大的條件下符合偶數輸出尺寸。',
      );
    const fps = Math.min(inspection.fps ?? 30, 30);
    const path = join(input.outputDirectory, 'video.webm');
    if (input.action !== 'verify') {
      const totalMilliseconds = Math.ceil(
        (inspection.durationSeconds ?? 0) * 1000,
      );
      let bufferedProgress = '';
      progress('encoding-video', 0, totalMilliseconds);
      const encoded = await command(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-y',
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          input.sourcePath,
          '-map',
          `0:${inspection.streamIndex}`,
          ...(inspection.audio ? ['-map', '0:a:0'] : []),
          '-vf',
          `scale=${width}:${height}:flags=lanczos,setsar=1,fps=${fps}`,
          '-c:v',
          'libvpx-vp9',
          '-crf',
          '32',
          '-b:v',
          '0',
          '-deadline',
          'good',
          '-cpu-used',
          '2',
          '-row-mt',
          '1',
          '-threads',
          '2',
          '-progress',
          'pipe:1',
          '-stats_period',
          '5',
          '-nostats',
          '-pix_fmt',
          'yuv420p',
          ...(inspection.audio
            ? ['-c:a', 'libopus', '-b:a', '96k', '-ac', '2', '-ar', '48000']
            : ['-an']),
          '-sn',
          '-dn',
          '-map_metadata',
          '-1',
          '-map_chapters',
          '-1',
          path,
        ],
        input.timeoutMs,
        1024 * 1024,
        (stream, bytes) => {
          if (stream !== 'stdout') return;
          bufferedProgress += bytes.toString('utf8');
          const lines = bufferedProgress.split('\n');
          bufferedProgress = lines.pop() ?? '';
          for (const line of lines) {
            const value = /^out_time_us=(\d+)$/u.exec(line)?.[1];
            if (value !== undefined)
              progress(
                'encoding-video',
                Math.min(totalMilliseconds, Math.floor(Number(value) / 1000)),
                totalMilliseconds,
              );
          }
        },
      );
      const at =
        input.posterTimeSeconds ??
        Math.min(1, (inspection.durationSeconds ?? 0) / 2);
      const lastCount = [
        ...encoded.stdout.toString('utf8').matchAll(/^frame=(\d+)$/gmu),
      ].at(-1)?.[1];
      const lastFrame =
        lastCount === undefined
          ? Math.max(0, (inspection.durationSeconds ?? 0) - 2 / fps)
          : Math.max(0, (Number(lastCount) - 1) / fps);
      const posterPng = await command(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-protocol_whitelist',
          'file,pipe',
          '-ss',
          String(Math.min(at, lastFrame)),
          '-i',
          path,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-vcodec',
          'png',
          '-',
        ],
        input.timeoutMs,
        32 * 1024 * 1024,
      );
      await sharp(posterPng.stdout, { limitInputPixels: 40_000_000 })
        .autoOrient()
        .toColourspace('srgb')
        .resize({
          width: Math.min(1280, inspection.width),
          withoutEnlargement: true,
        })
        .webp({ quality: 80, alphaQuality: 100, effort: 4 })
        .toFile(join(input.outputDirectory, 'poster.webp'));
    }
    const generated = await probe(path);
    const generatedVideo = generated.streams.find(
      (stream) => stream.codec_type === 'video',
    );
    const audio = generated.streams.find(
      (stream) => stream.codec_type === 'audio',
    );
    if (
      generatedVideo?.codec_name !== 'vp9' ||
      generatedVideo.pix_fmt !== 'yuv420p' ||
      generatedVideo.width !== width ||
      generatedVideo.height !== height ||
      rational(generatedVideo.sample_aspect_ratio, 1) !== 1 ||
      Math.abs(rational(generatedVideo.avg_frame_rate) - fps) > 0.02 ||
      (inspection.audio &&
        (audio?.codec_name !== 'opus' ||
          audio.channels !== 2 ||
          audio.sample_rate !== '48000')) ||
      (!inspection.audio && audio !== undefined)
    )
      throw new MediaError(
        'MEDIA_OUTPUT_INVALID',
        '影片輸出codec、尺寸、幀率或音軌不符合preset。',
        500,
      );
    await command(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        path,
        '-f',
        'null',
        '-',
      ],
      input.timeoutMs,
    );
    outputs.push({
      variant: 'video.webm',
      mimeType: 'video/webm',
      width,
      height,
      byteSize: (await stat(path)).size,
      sha256: await digest(path),
      durationSeconds: Number(generated.format.duration),
    });
    outputs.push(
      await imageOutput(
        join(input.outputDirectory, 'poster.webp'),
        'poster.webp',
      ),
    );
    progress('video', 1, 1);
  }
  return { inspection, outputs, tools };
}

try {
  const raw = process.argv[2];
  if (raw === undefined)
    throw new MediaError('MEDIA_WORKER_PROTOCOL', '缺少媒體工作設定。', 500);
  const input = JSON.parse(raw) as WorkerInput;
  if (input.hasJobLease === true) inheritedDescriptors = [3, 4];
  const timer = setTimeout(stop, input.timeoutMs);
  timer.unref();
  try {
    process.stdout.write(
      `${JSON.stringify({ ok: true, result: await execute(input) })}\n`,
    );
  } finally {
    clearTimeout(timer);
  }
} catch (error) {
  const failure =
    error instanceof MediaError
      ? error
      : error instanceof ProcessFailure
        ? new MediaError(error.code, error.message, 503)
        : new MediaError('MEDIA_DECODE_FAILED', '媒體內容損壞或無法解碼。');
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message, status: failure.status } })}\n`,
  );
} finally {
  process.stdin.destroy();
}
