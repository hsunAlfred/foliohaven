import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { normalizeSvg } from '../../server/src/media/svg.js';
import { normalizeIco } from '../../server/src/media/ico.js';
import type { NativeImageFactory } from '../../server/src/media/worker.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const svg = (content: string, attributes = '') =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16" ${attributes}>${content}</svg>`,
  );
interface Frame {
  width: number;
  height: number;
  bits: number;
  bytes: Buffer;
}
function icon(frames: readonly Frame[]): Buffer {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  for (const [index, frame] of frames.entries()) {
    const entry = 6 + index * 16;
    header[entry] = frame.width % 256;
    header[entry + 1] = frame.height % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(frame.bits, entry + 6);
    header.writeUInt32LE(frame.bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.bytes.length;
  }
  return Buffer.concat([header, ...frames.map((frame) => frame.bytes)]);
}
function dib(bits: number, alpha = 128): Frame {
  const width = 2;
  const height = 2;
  const colors = bits <= 8 ? 2 ** bits : 0;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const bytes = Buffer.alloc(40 + colors * 4 + stride * height + 8);
  bytes.writeUInt32LE(40);
  bytes.writeInt32LE(width, 4);
  bytes.writeInt32LE(height * 2, 8);
  bytes.writeUInt16LE(1, 12);
  bytes.writeUInt16LE(bits, 14);
  if (colors > 0) {
    bytes[40] = 255;
    bytes[46] = 255;
  }
  const pixels = 40 + colors * 4;
  for (let y = 0; y < height; y++) {
    const row = pixels + (height - y - 1) * stride;
    if (bits <= 8) bytes[row] = bits === 1 ? 128 : bits === 4 ? 16 : 1;
    else
      for (let x = 0; x < width; x++) {
        bytes[row + x * (bits / 8) + 2] = 255;
        if (bits === 32) bytes[row + x * 4 + 3] = alpha;
      }
  }
  // The second pixel of the first displayed row is transparent in the AND mask.
  bytes[pixels + stride * height + 4] = 64;
  return { width, height, bits, bytes };
}

describe('static SVG sources', () => {
  it('preserves path geometry, local gradients, currentColor and XML text while decoding real pixels', async () => {
    const source = svg(
      '<title>Reader&#x27;s &amp; Notes</title><defs><linearGradient id="ink"><stop stop-color="#613033"/></linearGradient></defs><g color="#613033" transform="translate(1 0)"><path d="M0 0H30V16H0Z" style="fill:url(&#x23;ink);opacity:1"/><circle cx="8" cy="8" r="2" fill="currentColor"/></g>',
    );
    const normalized = normalizeSvg(source);
    expect(normalized.toString()).toContain('Reader&apos;s &amp; Notes');
    expect(normalized.toString()).toContain('currentColor');
    const decoded = await sharp(normalized)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 32, height: 16, channels: 4 });
    expect([
      ...decoded.data.subarray((8 * 32 + 8) * 4, (8 * 32 + 8) * 4 + 4),
    ]).toEqual([97, 48, 51, 255]);
  });

  it.each([
    '<script>alert(1)</script>',
    '<path d="M0 0" onload="alert(1)"/>',
    '<foreignObject><div>HTML</div></foreignObject>',
    '<image href="https://example.invalid/track.png"/>',
    '<use href="#x"/>',
    '<style>@import "https://example.invalid/x.css";</style>',
    '<path style="fill:url(https://example.invalid/x.svg)"/>',
    '<path style="fill:u\\72l(https://example.invalid/x.svg)"/>',
    '<path fill="url(&#x68;ttps://example.invalid/x.svg)"/>',
    '<path fill="url(#absent)"/>',
    '<defs><linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/></defs>',
    '<mask id="a"><rect width="1" height="1" style="mask:url(#a)"/></mask>',
    '<g xmlns="https://example.invalid/foreign"><path/></g>',
    '<![CDATA[<script>bad</script>]]>',
  ])('rejects active, external or recursive markup: %s', (content) => {
    expect(() => normalizeSvg(svg(content))).toThrow();
  });

  it('rejects malformed XML, DTD, processing instructions and parser resource limits', () => {
    for (const source of [
      Buffer.from('<svg><path></svg>'),
      Buffer.from(
        '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]><svg>&secret;</svg>',
      ),
      Buffer.from(
        '<?xml-stylesheet href="https://example.invalid/a.css"?><svg/>',
      ),
      svg('<g>'.repeat(65) + '</g>'.repeat(65)),
      Buffer.alloc(2 * 1024 * 1024 + 1, 32),
      Buffer.from([0xff, 0xfe, 0x00]),
      svg('<title>bad\u0000text</title>'),
      svg(
        '<defs>' +
          Array.from(
            { length: 70 },
            (_, index) =>
              `<linearGradient id="g${index}" ${index < 69 ? `href="#g${index + 1}"` : ''}/>`,
          ).join('') +
          '</defs>',
      ),
    ])
      expect(() => normalizeSvg(source)).toThrow();
  });
});

describe('ICO sources', () => {
  it.each([1, 4, 8, 24, 32])(
    'decodes %i-bit Windows DIB color, alpha and AND-mask pixels',
    async (bits) => {
      const normalized = await normalizeIco(icon([dib(bits)]));
      const pixels = await sharp(normalized.image)
        .ensureAlpha()
        .raw()
        .toBuffer();
      expect(normalized).toMatchObject({ width: 2, height: 2, frameCount: 1 });
      expect([...pixels.subarray(0, 4)]).toEqual([
        255,
        0,
        0,
        bits === 32 ? 128 : 255,
      ]);
      expect(pixels[7]).toBe(0);
      const again = await normalizeIco(normalized.bytes);
      expect(again.bytes).toEqual(normalized.bytes);
    },
  );

  it('uses the highest-resolution actual frame and preserves all sizes in a clean native icon', async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: '#61303380' },
    })
      .png()
      .toBuffer();
    const normalized = await normalizeIco(
      icon([dib(32), { width: 64, height: 64, bits: 32, bytes: png }]),
    );
    expect(normalized).toMatchObject({ width: 64, height: 64, frameCount: 2 });
    expect(await sharp(normalized.image).metadata()).toMatchObject({
      width: 64,
      height: 64,
    });
    expect((await normalizeIco(normalized.bytes)).frameCount).toBe(2);
  });

  it('uses the AND mask for old 32-bit icons without meaningful alpha', async () => {
    const normalized = await normalizeIco(icon([dib(32, 0)]));
    const pixels = await sharp(normalized.image).ensureAlpha().raw().toBuffer();
    expect(pixels[3]).toBe(255);
    expect(pixels[7]).toBe(0);
  });

  it('rejects directory overlaps, fake dimensions, malformed frames and oversized frame sets', async () => {
    const good = icon([dib(32)]);
    const badOffset = Buffer.from(good);
    badOffset.writeUInt32LE(6, 18);
    const badDimensions = Buffer.from(good);
    badDimensions[6] = 255;
    const badCompression = Buffer.from(good);
    badCompression.writeUInt32LE(3, 22 + 16);
    const overlap = icon([dib(32), dib(24)]);
    overlap.writeUInt32LE(38, 6 + 16 + 12);
    for (const source of [
      Buffer.alloc(22),
      good.subarray(0, -10),
      badOffset,
      badDimensions,
      badCompression,
      overlap,
      icon(Array.from({ length: 65 }, () => dib(1))),
    ])
      await expect(normalizeIco(source)).rejects.toThrow();
  });

  it('rejects animated PNG payloads even when the directory claims a static frame', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#613033' },
    })
      .png()
      .toBuffer();
    const animation = Buffer.alloc(20);
    animation.writeUInt32BE(8);
    animation.write('acTL', 4, 'ascii');
    animation.writeUInt32BE(2, 8);
    const payload = Buffer.concat([
      png.subarray(0, 33),
      animation,
      png.subarray(33),
    ]);
    await expect(
      normalizeIco(icon([{ width: 2, height: 2, bits: 32, bytes: payload }])),
    ).rejects.toMatchObject({ code: 'MEDIA_ICO_INVALID' });
  });
});
