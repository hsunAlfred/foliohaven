import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMediaWorker } from '../../server/src/media/process.js';
import type { WorkerInput } from '../../server/src/media/process.js';
import type { NativeImageFactory } from '../../server/src/media/worker.js';
import { maskIconSvg, normalizeSvg } from '../../server/src/media/svg.js';
import { normalizeIco, pngFramesToIco } from '../../server/src/media/ico.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(bytes: Buffer, extension: string) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-site-icons-'));
  roots.push(root);
  const sourcePath = join(root, `original.${extension}`);
  await writeFile(sourcePath, bytes);
  const run = async (
    name: string,
    iconSet: boolean,
    action: WorkerInput['action'] = 'process',
  ) => {
    const outputDirectory = join(root, name);
    await mkdir(outputDirectory, { recursive: true });
    const lease = await open(join(root, 'worker.lease'), 'a+');
    try {
      const result = await runMediaWorker(
        {
          sourcePath,
          extension,
          kind: 'image',
          outputDirectory,
          iconSet,
          action,
          timeoutMs: 60_000,
        },
        lease.fd,
      );
      return { ...result, outputDirectory, sourcePath };
    } finally {
      await lease.close();
    }
  };
  return { root, sourcePath, run };
}
const pixel = (data: Buffer, width: number, x: number, y: number) => [
  ...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
];

describe('complete site-icon worker preset', () => {
  it('keeps article PNG bytes unchanged and adds transparent icons, opaque Apple artwork and a multi-size ICO', async () => {
    const source = await sharp({
      create: {
        width: 32,
        height: 16,
        channels: 4,
        background: { r: 97, g: 48, b: 51, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const { run, sourcePath } = await fixture(source, 'png');
    const article = await run('article', false);
    const icons = await run('icons', true);
    for (const output of article.outputs)
      expect(
        await readFile(join(icons.outputDirectory, output.variant)),
      ).toEqual(await readFile(join(article.outputDirectory, output.variant)));
    const expected = new Map([
      ['favicon-16.png', 16],
      ['favicon.png', 32],
      ['favicon-48.png', 48],
      ['apple-touch-icon.png', 180],
      ['icon-192.png', 192],
      ['icon-512.png', 512],
    ]);
    for (const [variant, size] of expected) {
      expect(
        icons.outputs.find((output) => output.variant === variant),
      ).toMatchObject({
        width: size,
        height: size,
        mimeType: 'image/png',
      });
      const png = await sharp(join(icons.outputDirectory, variant))
        .ensureAlpha()
        .raw()
        .toBuffer();
      expect(pixel(png, size, 0, 0)[3]).toBe(
        variant === 'apple-touch-icon.png' ? 255 : 0,
      );
      if (variant === 'apple-touch-icon.png') {
        expect(pixel(png, size, 0, 0)).toEqual([255, 255, 255, 255]);
        expect(
          (await sharp(join(icons.outputDirectory, variant)).metadata())
            .hasAlpha,
        ).toBe(false);
      } else
        expect(
          pixel(png, size, Math.floor(size / 2), Math.floor(size / 2))[3],
        ).toBe(128);
    }
    const native = await readFile(join(icons.outputDirectory, 'favicon.ico'));
    expect(await normalizeIco(native)).toMatchObject({
      width: 48,
      height: 48,
      frameCount: 3,
    });
    expect(
      Array.from({ length: 3 }, (_, index) => native[6 + index * 16]),
    ).toEqual([16, 32, 48]);
    expect(
      icons.outputs.filter((output) => output.variant === 'favicon.ico'),
    ).toHaveLength(1);
    expect(
      icons.outputs.some((output) => output.variant === 'mask-icon.svg'),
    ).toBe(false);
    expect((await run('icons', true, 'verify')).outputs).toEqual(icons.outputs);
    expect(await readFile(sourcePath)).toEqual(source);
  });

  it('adds a monochrome vector mask without changing legacy SVG outputs or its alpha geometry', async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16" viewBox="0 0 32 16"><defs><linearGradient id="site-icon-mask"><stop stop-color="#613033" stop-opacity="0.5"/></linearGradient></defs><rect x="4" y="2" width="24" height="12" fill="url(#site-icon-mask)"/><path d="M8 4H24V12H8Z" fill="none" stroke="#d3a656"/></svg>',
    );
    const { run, sourcePath } = await fixture(source, 'svg');
    const article = await run('article', false);
    const icons = await run('icons', true);
    for (const output of article.outputs)
      expect(
        await readFile(join(icons.outputDirectory, output.variant)),
      ).toEqual(await readFile(join(article.outputDirectory, output.variant)));
    const mask = await readFile(join(icons.outputDirectory, 'mask-icon.svg'));
    expect(
      icons.outputs.find((output) => output.variant === 'mask-icon.svg'),
    ).toMatchObject({
      width: 16,
      height: 16,
      mimeType: 'image/svg+xml',
    });
    expect(mask.toString()).toContain('viewBox="0 0 16 16"');
    expect(mask.toString()).toContain('id="site-icon-mask-x"');
    expect(mask.toString()).toContain('fill="none"');
    const actual = await sharp(mask).ensureAlpha().raw().toBuffer();
    const reference = await sharp(normalizeSvg(source))
      .resize({
        width: 16,
        height: 16,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .ensureAlpha()
      .raw()
      .toBuffer();
    for (let offset = 0; offset < actual.length; offset += 4) {
      expect([...actual.subarray(offset, offset + 3)]).toEqual([0, 0, 0]);
      expect(
        Math.abs((actual[offset + 3] ?? 0) - (reference[offset + 3] ?? 0)),
      ).toBeLessThanOrEqual(1);
    }
    expect((await run('icons', true, 'verify')).outputs).toEqual(icons.outputs);
    expect(await readFile(sourcePath)).toEqual(source);
  });

  it('preserves an ICO source native frame set without appending a duplicate icon', async () => {
    const frames = await Promise.all(
      [16, 32, 64].map((size) =>
        sharp({
          create: {
            width: size,
            height: size,
            channels: 4,
            background: '#613033',
          },
        })
          .png()
          .toBuffer(),
      ),
    );
    const source = await pngFramesToIco(frames);
    const { run, sourcePath } = await fixture(source, 'ico');
    const article = await run('article', false);
    const icons = await run('icons', true);
    const native = await readFile(join(icons.outputDirectory, 'favicon.ico'));
    expect(native).toEqual(
      await readFile(join(article.outputDirectory, 'favicon.ico')),
    );
    expect(
      icons.outputs.filter((output) => output.variant === 'favicon.ico'),
    ).toHaveLength(1);
    expect(await normalizeIco(native)).toMatchObject({
      width: 64,
      height: 64,
      frameCount: 3,
    });
    expect(await readFile(sourcePath)).toEqual(source);
  });

  it('does not let a mask wrapper introduce external or active SVG content', () => {
    for (const source of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>bad</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(https://example.invalid/a.svg)"/></svg>',
    ])
      expect(() => maskIconSvg(Buffer.from(source), 32, 32)).toThrow();
  });

  it('preserves original luminance-mask cutouts while making visible artwork black', async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16" viewBox="0 0 32 16"><defs><mask id="cut"><rect width="32" height="16" fill="white"/><rect x="16" width="16" height="16" fill="black"/></mask></defs><rect width="32" height="16" fill="#d3a656" mask="url(#cut)"/></svg>',
    );
    const actual = await sharp(maskIconSvg(source, 32, 16))
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(pixel(actual, 16, 4, 8)).toEqual([0, 0, 0, 255]);
    expect(pixel(actual, 16, 12, 8)[3]).toBe(0);
    expect(pixel(actual, 16, 0, 0)[3]).toBe(0);
  });
});
