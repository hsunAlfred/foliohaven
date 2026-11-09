import { expect, it } from 'vitest';
import { lstatSync, realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BuildResultSchema, UuidSchema } from '@foliohaven/core';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../server/src/runtime/environment.js';
import type { NativeImageFactory } from '../../server/src/media/worker.js';
import { samplesWorkspace } from '../fixtures/samples/workspace.js';

async function build(root: string) {
  let jobId: string | undefined;
  let snapshotRoot: string | undefined;
  let pendingOutput = '';
  const result = await runControlledProcess({
    command: 'pnpm',
    args: ['build'],
    cwd: root,
    env: buildProcessEnvironment(),
    timeoutMs: 240_000,
    onOutput: (stream, chunk) => {
      if (stream !== 'stdout') return;
      pendingOutput += chunk.toString('utf8');
      const lines = pendingOutput.split('\n');
      pendingOutput = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('{')) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event['event'] === 'build-created')
          jobId = UuidSchema.parse(event['jobId']);
      }
      if (!jobId || snapshotRoot) return;
      const candidate = join(root, '.foliohaven/builds', jobId, 'snapshot');
      try {
        const stat = lstatSync(candidate);
        if (stat.isDirectory() && !stat.isSymbolicLink())
          snapshotRoot = realpathSync(candidate);
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
    },
  });
  const events = result.stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const success = events.find((event) => event['event'] === 'build-succeeded');
  expect(success, '必須由真正CLI回報成功').toBeDefined();
  expect(jobId).toBeDefined();
  expect(snapshotRoot, '必須觀察到本輪真實snapshot目錄').toBeDefined();
  if (!success || !jobId || !snapshotRoot)
    throw new Error('REAL_BUILD_PROOF_MISSING');
  expect(snapshotRoot).toBe(
    join(root, '.foliohaven/builds', jobId, 'snapshot'),
  );
  expect(success['jobId']).toBe(jobId);
  const journal = JSON.parse(
    await readFile(
      join(root, '.foliohaven/artifacts', jobId, 'journal.json'),
      'utf8',
    ),
  ) as { result: unknown };
  const report = BuildResultSchema.parse(journal.result);
  expect(report.snapshotRevision).toBe(success['snapshotRevision']);
  return { jobId, snapshotRoot, report };
}

async function tree(root: string) {
  const files = (
    await readdir(join(root, 'dist'), { recursive: true, withFileTypes: true })
  )
    .filter((item) => item.isFile())
    .map((item) =>
      join(item.parentPath, item.name).slice(join(root, 'dist').length + 1),
    )
    .sort();
  const output = new Map<string, Buffer>();
  for (const file of files)
    output.set(file, await readFile(join(root, 'dist', file)));
  return output;
}

async function mediaSpecifications(root: string, paths: readonly string[]) {
  const sharp = createRequire(
    new URL('../../server/package.json', import.meta.url),
  )('sharp') as NativeImageFactory;
  const output = new Map<string, unknown>();
  for (const path of paths) {
    const full = join(root, 'dist', path);
    if (path.endsWith('.webp')) {
      const metadata = await sharp(full, { failOn: 'warning' }).metadata();
      output.set(path, {
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        space: metadata.space,
        channels: metadata.channels,
        pages: metadata.pages,
      });
    } else {
      const result = await runControlledProcess({
        command: 'ffprobe',
        args: [
          '-v',
          'error',
          '-show_entries',
          'format=format_name,duration:stream=codec_type,codec_name,width,height,pix_fmt,sample_aspect_ratio,r_frame_rate,avg_frame_rate,sample_rate,channels,channel_layout',
          '-of',
          'json',
          full,
        ],
        cwd: root,
        env: buildProcessEnvironment(),
        timeoutMs: 10_000,
      });
      output.set(path, JSON.parse(result.stdout.toString('utf8')) as unknown);
    }
  }
  return output;
}

it('BUILD-03: two real CLI builds with distinct snapshot roots preserve every text artifact byte and media specification', async () => {
  const fixture = await samplesWorkspace();
  try {
    const first = await build(fixture.root);
    const firstTree = await tree(fixture.root);
    const media = [...firstTree.keys()].filter((path) =>
      /\.(?:webp|webm)$/u.test(path),
    );
    const firstMedia = await mediaSpecifications(fixture.root, media);
    const second = await build(fixture.root);
    const secondTree = await tree(fixture.root);
    expect(second.jobId).not.toBe(first.jobId);
    expect(second.snapshotRoot).not.toBe(first.snapshotRoot);
    expect(second.report).toEqual(first.report);
    const manifest = async (id: string) =>
      JSON.parse(
        await readFile(
          join(fixture.root, '.foliohaven/builds', id, 'input-manifest.json'),
          'utf8',
        ),
      ) as unknown;
    expect(await manifest(second.jobId)).toEqual(await manifest(first.jobId));
    expect([...secondTree.keys()]).toEqual([...firstTree.keys()]);
    expect(firstTree.size).toBe(first.report.fileCount);
    expect(firstTree.has('articles/index.html')).toBe(true);
    const uid = (files: ReadonlyMap<string, Buffer>) =>
      files
        .get('articles/index.html')
        ?.toString('utf8')
        .match(/<astro-island\b[^>]*\buid="([^"]+)"/u)?.[1];
    expect(uid(firstTree), '搜尋島必須保有Astro正式產生的uid').toBeTruthy();
    expect(uid(secondTree), '不同job snapshot的搜尋島identity必須穩定').toBe(
      uid(firstTree),
    );
    expect(media.some((path) => path.endsWith('.webm'))).toBe(true);
    for (const [path, bytes] of firstTree) {
      if (/\.(?:webp|webm)$/u.test(path)) continue;
      expect(
        secondTree.get(path)?.equals(bytes),
        `${path}必須逐byte一致，包含搜尋島uid`,
      ).toBe(true);
    }
    expect(await mediaSpecifications(fixture.root, media)).toEqual(firstMedia);
    const count = (extension: string) =>
      [...firstTree.keys()].filter((path) => path.endsWith(extension)).length;
    console.info(
      JSON.stringify({
        event: 'build-reproducibility-verified',
        firstJobId: first.jobId,
        secondJobId: second.jobId,
        snapshotRootsDistinct: first.snapshotRoot !== second.snapshotRoot,
        snapshotRevision: first.report.snapshotRevision,
        islandUid: uid(firstTree),
        textArtifactsByteIdentical: firstTree.size - media.length,
        html: count('.html'),
        css: count('.css'),
        js: count('.js'),
        xml: count('.xml'),
        json: count('.json'),
        mediaSpecificationsIdentical: media.length,
      }),
    );
  } finally {
    await fixture.cleanup();
  }
}, 600_000);
