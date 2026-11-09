import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { BuildResultSchema, Sha256Schema, UuidSchema } from '@foliohaven/core';
import { privateResource, safeMkdir, safePath } from '../../files/io.js';
import { buildProcessEnvironment } from '../../runtime/environment.js';
import { runControlledProcess } from '../../runtime/process.js';
import { prepareRenderContext, RenderError } from './context.js';
import { validateSiteOutput } from './validate.js';
import type {
  BuildWorkerReport,
  RenderSnapshotOptions,
  PreparedRenderContext,
} from './types.js';

export async function copyReachableMedia(
  prepared: PreparedRenderContext,
  outputDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  const output = resolve(outputDirectory);
  for (const ref of prepared.model.mediaRefs) {
    signal?.throwIfAborted();
    const asset = prepared.manifest.assets.find((asset) =>
      asset.outputs.some((item) => item.publicPath === ref),
    );
    const expected = asset?.outputs.find((item) => item.publicPath === ref);
    if (asset === undefined || expected === undefined)
      throw new RenderError('MEDIA_NOT_FOUND', '公開媒體尚未完成。');
    const variant = ref.split('/').at(-1);
    if (variant === undefined)
      throw new RenderError('MEDIA_NOT_FOUND', '公開媒體路徑無效。');
    const media = await prepared.mediaService.openVariant(asset.id, variant);
    const key = ref.slice(1);
    await safeMkdir(output, dirname(key));
    const path = await safePath(output, key);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        media.stream,
        meter,
        createWriteStream(path, { flags: 'wx', mode: 0o644 }),
        ...(signal === undefined ? [] : [{ signal }]),
      );
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    if (size !== expected.byteSize || hash.digest('hex') !== expected.sha256)
      throw new RenderError('MEDIA_COPY_INVALID', '公開媒體複製後內容不一致。');
  }
}

/** 正式worker：只處理自己cwd的snapshot，不建立工作或提升dist。 */
export async function renderSnapshot(
  options: RenderSnapshotOptions,
): Promise<BuildWorkerReport> {
  const root = resolve(options.repositoryRoot);
  const jobId = UuidSchema.parse(options.jobId);
  const revision = Sha256Schema.parse(options.snapshotRevision);
  const coordinationRoot = resolve(root, '../../../..');
  if (
    relative(coordinationRoot, root) !==
    privateResource(coordinationRoot, `builds/${jobId}/snapshot`)
  )
    throw new RenderError(
      'INVALID_SNAPSHOT_DESTINATION',
      '正式呈現只能使用目前job的不可變快照。',
    );
  const contextDirectory = resolve(root, privateResource(root, 'render'));
  const outputDirectory = resolve(root, '../output');
  // 前次候選只能由外層復原與清理，worker不覆寫未知目錄。
  await mkdir(outputDirectory, { mode: 0o700 });
  try {
    const prepared = await prepareRenderContext({
      repositoryRoot: root,
      contextDirectory,
      coordinationRoot,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await runControlledProcess({
      command: 'pnpm',
      args: [
        '--filter',
        '@foliohaven/site',
        'exec',
        'astro',
        'build',
        '--silent',
      ],
      cwd: root,
      env: buildProcessEnvironment({
        FOLIOHAVEN_RENDER_CONTEXT: contextDirectory,
        FOLIOHAVEN_RENDER_OUTPUT: outputDirectory,
      }),
      timeoutMs: 15 * 60_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await copyReachableMedia(prepared, outputDirectory, options.signal);
    const validation = await validateSiteOutput({
      outputDirectory,
      model: prepared.model,
      manifest: prepared.manifest,
      fixedPageSeos: prepared.fixedPageSeos,
    });
    const result = BuildResultSchema.parse({
      outputDirectory: 'dist',
      snapshotRevision: revision,
      routeCount: validation.routeCount,
      fileCount: validation.fileCount,
      warnings: validation.warnings,
    });
    const report: BuildWorkerReport = {
      schemaVersion: 1,
      result,
      mediaPending: false,
      pendingLinkChecks: 0,
    };
    await writeFile(
      await safePath(root, privateResource(root, 'build-result.json')),
      JSON.stringify(report),
      { flag: 'wx', mode: 0o600 },
    );
    return report;
  } catch (error) {
    // 原始Astro錯誤／stdout不寫log；安全診斷由呼叫端回報。
    if (error instanceof RenderError) throw error;
    throw error;
  }
}
