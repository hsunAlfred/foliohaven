import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// 只使用程式產生幾何色塊與測試影像，沒有下載素材或個人資料。
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(root, 'server/package.json'));
const sharp = require('sharp');
const image = join(
  root,
  'media/source/d65927b5-381f-4d2e-90d8-f6a8c5e38e57/original.png',
);
const video = join(
  root,
  'media/source/68789bc2-e491-4dbe-81de-f1a42adb7234/original.mp4',
);
await mkdir(dirname(image), { recursive: true });
await mkdir(dirname(video), { recursive: true });
const width = 1440;
const height = 900;
const pixels = Buffer.alloc(width * height * 3);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    let color = [27, 52, 82];
    if (x >= 120 && x < 1320 && y >= 120 && y < 780) color = [224, 237, 241];
    if (x >= 200 && x < 720 && y >= 200 && y < 700) color = [41, 111, 139];
    if ((x - 1000) ** 2 + (y - 360) ** 2 <= 135 ** 2) color = [237, 169, 80];
    if (x >= 820 && x < 1200 && y >= 590 && y < 630) color = [65, 107, 117];
    const offset = (y * width + x) * 3;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
  }
}
await sharp(pixels, { raw: { width, height, channels: 3 } })
  .png({ compressionLevel: 9 })
  .toFile(image);
await new Promise((resolve, reject) => {
  const child = spawn(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24:duration=2',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      '-flags:v',
      '+bitexact',
      '-movflags',
      '+faststart',
      '-y',
      video,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.once('error', (error) => {
    clearTimeout(timeout);
    reject(new Error('合成範例影片失敗。', { cause: error }));
  });
  child.once('close', (code) => {
    clearTimeout(timeout);
    if (code === 0) resolve();
    else reject(new Error('合成範例影片未完成。'));
  });
});
process.stdout.write('已重新產生本機合成圖片與兩秒影片。\n');
