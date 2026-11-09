import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { FileRepository } from '../../server/dist/files/index.js';
import {
  MediaService,
  acquireMediaSlot,
} from '../../server/dist/media/index.js';
import type { MediaProgress } from '../../server/dist/media/index.js';
import { acquireFileLease } from '../../server/dist/runtime/lease.js';
import { runControlledProcess } from '../../server/dist/runtime/process.js';
import { buildProcessEnvironment } from '../../server/dist/runtime/environment.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-media-runtime-'));
  roots.push(root);
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  return {
    root,
    repository,
    service: new MediaService({ repositoryRoot: root, repository }),
  };
}
async function add(
  service: MediaService,
  bytes: Buffer,
  filename: string,
  mimeType: string,
  posterTimeSeconds?: number,
) {
  return service.register(
    await service.stageSource(Readable.from([bytes]), {
      filename,
      mimeType,
      ...(posterTimeSeconds === undefined ? {} : { posterTimeSeconds }),
    }),
  );
}
async function ffmpeg(root: string, args: readonly string[]) {
  return runControlledProcess({
    command: 'ffmpeg',
    args: ['-v', 'error', '-nostdin', '-y', ...args],
    cwd: root,
    env: buildProcessEnvironment(),
    timeoutMs: 30_000,
  });
}
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([size, payload, crc]);
}

describe('MEDIA-01/02: real native limits, source and compiled workers, cross-process slots', () => {
  it('awaits asynchronous progress persistence and safely aborts on a rejected observer before creating a job receipt', async () => {
    const { root, service, repository } = await fixture();
    const source = await add(
      service,
      await sharp({
        create: { width: 640, height: 320, channels: 3, background: 'red' },
      })
        .png()
        .toBuffer(),
      'async.png',
      'image/png',
    );
    const progress: MediaProgress[] = [];
    const expectedProgress = [1, 2, 3, 4, 5].map((completed) => ({
      stage: 'images',
      completed,
      total: 5,
    }));
    let bindingChecked = false;
    const observing = new MediaService({
      repositoryRoot: root,
      repository,
      onPhase: (phase) => {
        if (phase === 'before-binding') {
          expect(progress).toEqual(expectedProgress);
          bindingChecked = true;
        }
      },
    });
    await observing.process(source.value.id, {
      onProgress: async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        progress.push(value);
      },
    });
    expect(bindingChecked).toBe(true);
    expect(progress).toEqual(expectedProgress);
    const jobId = crypto.randomUUID();
    await expect(
      service.process(source.value.id, {
        jobId,
        onProgress: async () => {
          await Promise.resolve();
          throw new Error('private observer implementation detail');
        },
      }),
    ).rejects.toMatchObject({
      code: 'MEDIA_PROGRESS_FAILED',
      message: '媒體工作進度無法保存。',
    });
    expect(
      await service.committedResult(jobId, {
        sourceId: source.value.id,
        preset: 'article-image',
      }),
    ).toBeNull();
    const first = await acquireMediaSlot(root, 'image', 1000);
    const second = await acquireMediaSlot(root, 'image', 1000);
    await first.release();
    await second.release();
  });
  it('stops an inherited native image worker after its actual parent is killed and releases its slot', async () => {
    const { root } = await fixture();
    const sample = join(root, 'parent-lifecycle.png');
    await writeFile(
      sample,
      await sharp({
        create: { width: 5000, height: 3000, channels: 3, background: 'blue' },
      })
        .png()
        .toBuffer(),
    );
    const held = await acquireFileLease({
      root,
      name: 'media-image-0',
      owner: 'media-test',
    });
    let killed = false;
    let output = '';
    const script = `const {MediaService}=await import(process.argv[3]);const {FileRepository}=await import(process.argv[4]);const {createReadStream}=await import('node:fs');const repository=new FileRepository({repositoryRoot:process.argv[1]});await repository.initialize();const media=new MediaService({repositoryRoot:process.argv[1],repository});const source=await media.register(await media.stageSource(createReadStream(process.argv[2]),{filename:'sample.png',mimeType:'image/png'}));await media.process(source.value.id,{onProgress:progress=>{if(progress.stage==='images'&&progress.completed===1)process.stdout.write(JSON.stringify({stop:true,pid:process.pid})+'\\n');}});process.stdout.write('unexpected-completion');`;
    try {
      await expect(
        runControlledProcess({
          command: process.execPath,
          args: [
            '--input-type=module',
            '-e',
            script,
            root,
            sample,
            new URL('../../server/dist/media/index.js', import.meta.url).href,
            new URL('../../server/dist/files/index.js', import.meta.url).href,
          ],
          cwd: root,
          env: buildProcessEnvironment(),
          timeoutMs: 30000,
          onOutput(stream, bytes) {
            if (stream !== 'stdout') return;
            output += bytes.toString();
            const match = /"stop":true,"pid":(\d+)/u.exec(output);
            if (match !== null && !killed) {
              killed = true;
              process.kill(Number(match[1]), 'SIGKILL');
            }
          },
        }),
      ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
      expect(killed).toBe(true);
      expect(output).not.toContain('unexpected-completion');
      const released = await acquireMediaSlot(root, 'image', 2000);
      await released.release();
    } finally {
      await held?.release();
    }
  });
  it('executes the complete same pipeline through Node+tsx source worker and compiled JS worker', async () => {
    const { root, service } = await fixture();
    const sample = join(root, 'sample.png');
    await writeFile(
      sample,
      await sharp({
        create: { width: 32, height: 16, channels: 3, background: 'blue' },
      })
        .png()
        .toBuffer(),
    );
    const moduleUrl = new URL(
      '../../server/src/media/index.ts',
      import.meta.url,
    ).href;
    const repoUrl = new URL('../../server/src/files/index.ts', import.meta.url)
      .href;
    const script = `const {MediaService}=await import(process.argv[3]);const {FileRepository}=await import(process.argv[4]);const {createReadStream}=await import('node:fs');const repository=new FileRepository({repositoryRoot:process.argv[1]});await repository.initialize();const media=new MediaService({repositoryRoot:process.argv[1],repository});const staged=await media.stageSource(createReadStream(process.argv[2]),{filename:'sample.png',mimeType:'image/png'});const source=await media.register(staged);const asset=await media.process(source.value.id);process.stdout.write(JSON.stringify({id:asset.id,width:asset.outputs[0].width,height:asset.outputs[0].height}));`;
    const output = await runControlledProcess({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        root,
        sample,
        moduleUrl,
        repoUrl,
      ],
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: buildProcessEnvironment(),
      timeoutMs: 30_000,
    });
    const result = JSON.parse(output.stdout.toString()) as {
      id: string;
      width: number;
      height: number;
    };
    expect(result).toMatchObject({ width: 32, height: 16 });
    expect((await service.get(result.id)).value.asset?.outputs[0]?.width).toBe(
      32,
    );
  });
  it('enforces image two and video one slots across a genuinely separate native worker process', async () => {
    const { root } = await fixture();
    const first = await acquireMediaSlot(root, 'image', 1000);
    const second = await acquireMediaSlot(root, 'image', 1000);
    const sample = join(root, 'sample.png');
    await writeFile(
      sample,
      await sharp({
        create: { width: 16, height: 8, channels: 3, background: 'red' },
      })
        .png()
        .toBuffer(),
    );
    const mediaUrl = new URL(
      '../../server/dist/media/index.js',
      import.meta.url,
    ).href;
    const repoUrl = new URL('../../server/dist/files/index.js', import.meta.url)
      .href;
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let finished = false;
    const script = `const {MediaService}=await import(process.argv[3]);const {FileRepository}=await import(process.argv[4]);const {createReadStream}=await import('node:fs');const repository=new FileRepository({repositoryRoot:process.argv[1]});await repository.initialize();const media=new MediaService({repositoryRoot:process.argv[1],repository});process.stdout.write('waiting\\n');const staged=await media.stageSource(createReadStream(process.argv[2]),{filename:'sample.png',mimeType:'image/png'});await media.discard(staged);process.stdout.write('done\\n');`;
    const task = runControlledProcess({
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        script,
        root,
        sample,
        mediaUrl,
        repoUrl,
      ],
      cwd: root,
      env: buildProcessEnvironment(),
      timeoutMs: 10_000,
      onOutput: (_stream, chunk) => {
        if (chunk.toString().includes('waiting')) ready();
      },
    }).then((result) => {
      finished = true;
      return result;
    });
    try {
      await started;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(finished).toBe(false);
      await first.release();
      expect((await task).stdout.toString()).toContain('done');
    } finally {
      await first.release();
      await second.release();
      await task.catch(() => undefined);
    }
    const video = await acquireMediaSlot(root, 'video', 1000);
    try {
      await expect(acquireMediaSlot(root, 'video', 30)).rejects.toMatchObject({
        code: 'MEDIA_BUSY',
      });
    } finally {
      await video.release();
    }
    const one = await acquireMediaSlot(root, 'image', 1000);
    const two = await acquireMediaSlot(root, 'image', 1000);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30);
    try {
      await expect(
        acquireMediaSlot(root, 'image', 1000, abort.signal),
      ).rejects.toMatchObject({ code: 'MEDIA_CANCELLED' });
    } finally {
      clearTimeout(timer);
      await one.release();
      await two.release();
    }
  });
  it('supports true AVIF and rejects an actual one-frame APNG animation before registration', async () => {
    const { root, service } = await fixture();
    const avif = await sharp({
      create: { width: 32, height: 16, channels: 3, background: 'green' },
    })
      .avif()
      .toBuffer();
    const source = await add(service, avif, 'image.avif', 'image/avif');
    expect((await service.process(source.value.id)).outputs[0]).toMatchObject({
      width: 32,
      height: 16,
    });
    const png = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const control = Buffer.alloc(8);
    control.writeUInt32BE(1, 0);
    const frame = Buffer.alloc(26);
    frame.writeUInt32BE(8, 4);
    frame.writeUInt32BE(8, 8);
    frame.writeUInt16BE(1, 20);
    frame.writeUInt16BE(10, 22);
    const apng = Buffer.concat([
      png.subarray(0, 33),
      chunk('acTL', control),
      chunk('fcTL', frame),
      png.subarray(33),
    ]);
    await expect(
      add(service, apng, 'animated.png', 'image/png'),
    ).rejects.toMatchObject({ code: 'MEDIA_ANIMATION_UNSUPPORTED' });
    expect(await readdir(join(root, '.foliohaven/staging'))).toEqual([]);
  });
  it('checks genuine EBML DocType, accepting real WebM and rejecting Matroska with spoofed webm metadata', async () => {
    const { root, service } = await fixture();
    const spoof = join(root, 'spoof.webm');
    await ffmpeg(root, [
      '-f',
      'lavfi',
      '-i',
      'color=size=16x16:rate=2',
      '-t',
      '0.5',
      '-c:v',
      'libx264',
      '-metadata',
      'title=webm',
      '-f',
      'matroska',
      spoof,
    ]);
    const spoofBytes = await readFile(spoof);
    expect(spoofBytes.includes(Buffer.from('matroska'))).toBe(true);
    expect(spoofBytes.includes(Buffer.from('webm'))).toBe(true);
    await expect(
      add(service, spoofBytes, 'spoof.webm', 'video/webm'),
    ).rejects.toMatchObject({ code: 'MEDIA_FORMAT_UNSUPPORTED', status: 422 });
    const actual = join(root, 'actual.webm');
    await ffmpeg(root, [
      '-f',
      'lavfi',
      '-i',
      'color=size=16x16:rate=2',
      '-t',
      '0.5',
      '-c:v',
      'libvpx-vp9',
      '-f',
      'webm',
      actual,
    ]);
    const source = await add(
      service,
      await readFile(actual),
      'actual.webm',
      'video/webm',
    );
    expect(source.value.mimeType).toBe('video/webm');
    expect((await service.process(source.value.id)).outputs[0]).toMatchObject({
      mimeType: 'video/webm',
      width: 16,
      height: 16,
    });
    expect(await readdir(join(root, '.foliohaven/staging'))).toEqual([]);
  });
  it('corrects MOV rotation and non-square pixel aspect while retaining display proportions', async () => {
    const { root, service } = await fixture();
    const base = join(root, 'base.mp4');
    await ffmpeg(root, [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=256x128:rate=6',
      '-t',
      '0.5',
      '-vf',
      'setsar=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      base,
    ]);
    const source = await add(
      service,
      await readFile(base),
      'sar.mp4',
      'video/mp4',
    );
    const asset = await service.process(source.value.id);
    expect(asset.outputs[0]).toMatchObject({ width: 256, height: 64 });
    const rotated = join(root, 'rotated.mov');
    await ffmpeg(root, [
      '-display_rotation',
      '90',
      '-i',
      base,
      '-c',
      'copy',
      rotated,
    ]);
    const movie = await add(
      service,
      await readFile(rotated),
      'rotated.mov',
      'video/quicktime',
    );
    expect(movie.value).toMatchObject({ width: 128, height: 256 });
    const rotation = await service.process(movie.value.id);
    expect(rotation.outputs[0]).toMatchObject({ width: 64, height: 256 });
  });
  it('changes poster cache keys and accepts the final legal instant even with audio padding', async () => {
    const { root, service } = await fixture();
    const path = join(root, 'poster.mp4');
    await ffmpeg(root, [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x90:rate=12',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '0.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path,
    ]);
    const source = await add(
      service,
      await readFile(path),
      'poster.mp4',
      'video/mp4',
      0,
    );
    await service.process(source.value.id);
    const ready = await service.get(source.value.id);
    expect(ready.etag).not.toBe(source.etag);
    expect(ready.inputRevision).toBe(source.inputRevision);
    const updated = await service.update(
      source.value.id,
      {
        displayName: 'Final instant',
        posterTimeSeconds: (source.value.durationSeconds ?? 1) - 0.001,
      },
      ready.etag,
    );
    expect(updated.value.asset).toBeNull();
    await service.process(source.value.id);
    expect(
      (await readdir(join(root, '.foliohaven/media'))).filter((name) =>
        /^[a-f0-9]{64}$/u.test(name),
      ),
    ).toHaveLength(2);
  });
  it('processes a genuine 600-second source and records actual Opus container padding', async () => {
    const { root, service } = await fixture();
    const path = join(root, 'maximum-duration.mp4');
    await ffmpeg(root, [
      '-f',
      'lavfi',
      '-i',
      'color=size=16x16:rate=1',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-t',
      '600',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      path,
    ]);
    const source = await add(
      service,
      await readFile(path),
      'maximum-duration.mp4',
      'video/mp4',
    );
    expect(source.value.durationSeconds).toBe(600);
    const asset = await service.process(source.value.id);
    expect(asset.outputs[0]?.durationSeconds).toBeCloseTo(600.008, 3);
    expect((await service.get(source.value.id)).value.asset).toEqual(asset);
  });
  it('rejects a source whose extreme display proportion cannot produce even dimensions without enlargement', async () => {
    const { root, service } = await fixture();
    const path = join(root, 'narrow.mp4');
    await ffmpeg(root, [
      '-f',
      'lavfi',
      '-i',
      'color=size=2x4096:rate=2',
      '-t',
      '0.5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      path,
    ]);
    const source = await add(
      service,
      await readFile(path),
      'narrow.mp4',
      'video/mp4',
    );
    await expect(service.process(source.value.id)).rejects.toMatchObject({
      code: 'MEDIA_DIMENSIONS_EXCEEDED',
      status: 422,
    });
    expect((await service.get(source.value.id)).value.asset).toBeNull();
    expect(
      (await readdir(join(root, '.foliohaven/media'))).filter((name) =>
        name.endsWith('.part'),
      ),
    ).toEqual([]);
  });
  it('rejects a real audio-only container, fps>60, duration>600, and dimension limits', async () => {
    const { root, service } = await fixture();
    const cases = [
      {
        name: 'audio',
        args: [
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=44100',
          '-t',
          '0.1',
          '-c:a',
          'aac',
        ],
      },
      {
        name: 'fps',
        args: [
          '-f',
          'lavfi',
          '-i',
          'color=size=16x16:rate=61',
          '-t',
          '0.1',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
        ],
      },
      {
        name: 'duration',
        args: [
          '-f',
          'lavfi',
          '-i',
          'color=size=16x16:rate=1',
          '-t',
          '601',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
        ],
      },
      {
        name: 'dimension',
        args: [
          '-f',
          'lavfi',
          '-i',
          'color=size=4098x2:rate=1',
          '-frames:v',
          '1',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
        ],
      },
    ];
    for (const item of cases) {
      const path = join(root, `${item.name}.mp4`);
      await ffmpeg(root, [...item.args, path]);
      await expect(
        add(service, await readFile(path), `${item.name}.mp4`, 'video/mp4'),
      ).rejects.toMatchObject({ status: 422 });
    }
  });
  it('cancels an actual launched encoder and releases its inherited video lease', async () => {
    const { root, repository, service } = await fixture();
    const path = join(root, 'cancel.mp4');
    await ffmpeg(root, [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=30',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path,
    ]);
    const source = await add(
      service,
      await readFile(path),
      'cancel.mp4',
      'video/mp4',
    );
    const abort = new AbortController();
    let began = false;
    const task = new MediaService({ repositoryRoot: root, repository }).process(
      source.value.id,
      {
        signal: abort.signal,
        onProgress: (progress) => {
          if (progress.stage === 'encoding-video') {
            began = true;
            abort.abort();
          }
        },
      },
    );
    await expect(task).rejects.toMatchObject({ code: 'MEDIA_CANCELLED' });
    expect(began).toBe(true);
    const lease = await acquireFileLease({
      root,
      name: 'media-video-0',
      owner: 'media-test',
      nonBlocking: true,
    });
    expect(lease).not.toBeNull();
    await lease?.release();
    expect(await readdir(join(root, '.foliohaven/media-work'))).toEqual([]);
  });
  it('enforces real 40MP and 512MiB boundaries using bounded memory streams', async () => {
    const { root, service } = await fixture();
    const oversized = await sharp({
      create: { width: 6500, height: 6500, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    await expect(
      add(service, oversized, 'pixels.png', 'image/png'),
    ).rejects.toMatchObject({ status: 422 });
    const block = Buffer.alloc(1024 * 1024);
    const huge = async function* () {
      for (let count = 0; count < 513; count++) yield block;
    };
    await expect(
      service.stageSource(huge(), {
        filename: 'large.mp4',
        mimeType: 'video/mp4',
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(await readdir(join(root, '.foliohaven/staging'))).toEqual([]);
  });
});
