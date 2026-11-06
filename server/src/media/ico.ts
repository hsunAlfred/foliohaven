import sharp from 'sharp';
import { MediaError } from './errors.js';

interface IconFrame {
  width: number;
  height: number;
  bits: number;
  data: Buffer;
}
function invalid(message = 'ICO 容器、尺寸或像素資料無效。'): never {
  throw new MediaError('MEDIA_ICO_INVALID', message);
}
function staticPng(bytes: Buffer): void {
  let position = 8;
  while (position + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(position);
    const type = bytes.toString('ascii', position + 4, position + 8);
    if (
      position + 12 + length > bytes.length ||
      ['acTL', 'fcTL', 'fdAT'].includes(type)
    )
      invalid();
    position += 12 + length;
    if (type === 'IEND') {
      if (length !== 0 || position !== bytes.length) invalid();
      return;
    }
  }
  invalid();
}
function dibFrame(bytes: Buffer, width: number, height: number): IconFrame {
  if (bytes.length < 40) invalid();
  const header = bytes.readUInt32LE(0);
  if (
    ![40, 108, 124].includes(header) ||
    bytes.length < header ||
    bytes.readInt32LE(4) !== width ||
    bytes.readInt32LE(8) !== height * 2 ||
    bytes.readUInt16LE(12) !== 1 ||
    bytes.readUInt32LE(16) !== 0
  )
    invalid();
  const bits = bytes.readUInt16LE(14);
  if (![1, 4, 8, 24, 32].includes(bits))
    invalid('ICO DIB 只支援靜態 BI_RGB 圖片。');
  const colors = bits <= 8 ? bytes.readUInt32LE(32) || 2 ** bits : 0;
  if (colors > 2 ** Math.min(bits, 8)) invalid();
  const pixels = header + colors * 4;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const mask = pixels + stride * height;
  if (bytes.length < mask) invalid();
  const hasMask = bytes.length >= mask + maskStride * height;
  if (!hasMask && bits !== 32) invalid();
  const data = Buffer.alloc(width * height * 4);
  let hasAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixels + (height - y - 1) * stride;
    for (let x = 0; x < width; x++) {
      let red: number;
      let green: number;
      let blue: number;
      let alpha = 255;
      if (bits <= 8) {
        const pixel = bytes[row + Math.floor((x * bits) / 8)] ?? invalid();
        const index =
          bits === 8
            ? pixel
            : bits === 4
              ? (pixel >> ((1 - (x % 2)) * 4)) & 15
              : (pixel >> (7 - (x % 8))) & 1;
        if (index >= colors) invalid();
        const palette = header + index * 4;
        blue = bytes[palette] ?? invalid();
        green = bytes[palette + 1] ?? invalid();
        red = bytes[palette + 2] ?? invalid();
      } else {
        const pixel = row + x * (bits / 8);
        blue = bytes[pixel] ?? invalid();
        green = bytes[pixel + 1] ?? invalid();
        red = bytes[pixel + 2] ?? invalid();
        if (bits === 32) {
          alpha = bytes[pixel + 3] ?? invalid();
          hasAlpha ||= alpha !== 0;
        }
      }
      const target = (y * width + x) * 4;
      data[target] = red;
      data[target + 1] = green;
      data[target + 2] = blue;
      data[target + 3] = alpha;
    }
  }
  if (bits === 32 && !hasAlpha && !hasMask) invalid();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4 + 3;
      if (bits === 32 && !hasAlpha) data[target] = 255;
      if (hasMask) {
        const bit =
          bytes[mask + (height - y - 1) * maskStride + Math.floor(x / 8)] ??
          invalid();
        if ((bit >> (7 - (x % 8))) & 1) data[target] = 0;
      }
    }
  }
  return { width, height, bits, data };
}

/** Decode every frame, then publish a clean PNG-backed ICO container. */
export async function normalizeIco(bytes: Buffer): Promise<{
  bytes: Buffer;
  image: Buffer;
  width: number;
  height: number;
  frameCount: number;
}> {
  if (
    bytes.length < 22 ||
    bytes.readUInt16LE(0) !== 0 ||
    bytes.readUInt16LE(2) !== 1
  )
    invalid();
  const count = bytes.readUInt16LE(4);
  if (count < 1 || count > 64 || bytes.length < 6 + count * 16) invalid();
  const directoryEnd = 6 + count * 16;
  const ranges: { start: number; end: number }[] = [];
  const frames: IconFrame[] = [];
  let totalPixels = 0;
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const width = bytes[entry] || 256;
    const height = bytes[entry + 1] || 256;
    const planes = bytes.readUInt16LE(entry + 4);
    const declaredBits = bytes.readUInt16LE(entry + 6);
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    totalPixels += width * height;
    if (
      bytes[entry + 3] !== 0 ||
      ![0, 1].includes(planes) ||
      totalPixels > 4_000_000 ||
      length === 0 ||
      offset < directoryEnd ||
      offset + length > bytes.length ||
      ranges.some(
        (range) => offset < range.end && offset + length > range.start,
      )
    )
      invalid();
    ranges.push({ start: offset, end: offset + length });
    const payload = bytes.subarray(offset, offset + length);
    if (
      payload
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      staticPng(payload);
      const metadata = await sharp(payload, {
        failOn: 'warning',
        limitInputPixels: 65_536,
      }).metadata();
      if (
        metadata.width !== width ||
        metadata.height !== height ||
        (metadata.pages ?? 1) !== 1 ||
        metadata.delay !== undefined ||
        metadata.loop !== undefined
      )
        invalid();
      const decoded = await sharp(payload, {
        failOn: 'warning',
        limitInputPixels: 65_536,
      })
        .toColourspace('srgb')
        .ensureAlpha()
        .raw({ depth: 'uchar' })
        .toBuffer();
      if (decoded.length !== width * height * 4) invalid();
      frames.push({ width, height, bits: 32, data: decoded });
    } else {
      const frame = dibFrame(payload, width, height);
      if (declaredBits !== 0 && declaredBits !== frame.bits) invalid();
      frames.push(frame);
    }
  }
  const encoded: Buffer[] = [];
  for (const frame of frames)
    encoded.push(
      await sharp(frame.data, {
        raw: { width: frame.width, height: frame.height, channels: 4 },
      })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    );
  const header = Buffer.alloc(directoryEnd);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = directoryEnd;
  let best = 0;
  for (const [index, frame] of frames.entries()) {
    const payload = encoded[index];
    const previous = frames[best];
    if (payload === undefined || previous === undefined) invalid();
    if (
      frame.width * frame.height > previous.width * previous.height ||
      (frame.width * frame.height === previous.width * previous.height &&
        frame.bits > previous.bits)
    )
      best = index;
    const entry = 6 + index * 16;
    header[entry] = frame.width % 256;
    header[entry + 1] = frame.height % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(payload.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += payload.length;
  }
  const selected = frames[best];
  const image = encoded[best];
  if (selected === undefined || image === undefined) invalid();
  return {
    bytes: Buffer.concat([header, ...encoded]),
    image,
    width: selected.width,
    height: selected.height,
    frameCount: count,
  };
}

/** Assemble generated PNG sizes and run the same complete native-icon checks. */
export async function pngFramesToIco(
  frames: readonly Buffer[],
): Promise<Buffer> {
  if (frames.length < 1 || frames.length > 64) invalid();
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  for (const [index, bytes] of frames.entries()) {
    staticPng(bytes);
    const metadata = await sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: 65_536,
    }).metadata();
    if (
      metadata.format !== 'png' ||
      metadata.width < 1 ||
      metadata.height < 1 ||
      metadata.width > 256 ||
      metadata.height > 256
    )
      invalid();
    const entry = 6 + index * 16;
    directory[entry] = metadata.width % 256;
    directory[entry + 1] = metadata.height % 256;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(bytes.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  }
  return (await normalizeIco(Buffer.concat([directory, ...frames]))).bytes;
}
