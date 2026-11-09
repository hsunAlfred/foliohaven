import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MediaResultSchema } from '@foliohaven/core';
import type { NativeImageFactory } from '../../server/dist/media/worker.js';
import { FileRepository } from '../../server/dist/files/index.js';
import { MediaService } from '../../server/dist/media/index.js';
import { JobManager } from '../../server/src/jobs/index.js';
import { runControlledProcess } from '../../server/dist/runtime/process.js';
import { buildProcessEnvironment } from '../../server/dist/runtime/environment.js';

const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const roots: string[] = [];
const managers: JobManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(
  options: Partial<ConstructorParameters<typeof MediaService>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-media-proof-'));
  roots.push(root);
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  const service = new MediaService({
    repositoryRoot: root,
    repository,
    ...options,
  });
  const bytes = await sharp({
    create: { width: 32, height: 16, channels: 3, background: 'blue' },
  })
    .png()
    .toBuffer();
  const source = await service.register(
    await service.stageSource(Readable.from([bytes]), {
      filename: 'image.png',
      mimeType: 'image/png',
    }),
  );
  return { root, repository, service, source };
}
function registerHandler(jobs: JobManager, media: MediaService) {
  jobs.register('media', {
    validateSource: async (payload, revision) =>
      (await media.get(payload.sourceId)).value.sourceSha256 === revision,
    committedResult: (jobId, payload) => media.committedResult(jobId, payload),
    run: async (context, payload) => ({
      sourceId: payload.sourceId,
      asset: await media.process(payload.sourceId, {
        jobId: context.jobId,
        jobLeaseFd: context.leaseFd,
        preset: payload.preset,
        signal: context.signal,
        onProgress: (value) => context.progress(value),
      }),
    }),
  });
}
async function manager(root: string, media: MediaService) {
  const jobs = new JobManager({
    repositoryRoot: root,
    pollIntervalMs: 20,
  });
  managers.push(jobs);
  registerHandler(jobs, media);
  await jobs.initialize();
  return jobs;
}

describe('MEDIA-JOB-01: durable media completion and immutable job evidence', () => {
  it('keeps durable success when binding projection fails and retains historical proof after metadata change and reprocessing', async () => {
    const { root, repository, service, source } = await fixture();
    const jobId = randomUUID();
    const payload = {
      sourceId: source.value.id,
      preset: 'article-image' as const,
    };
    const projecting = new MediaService({
      repositoryRoot: root,
      repository,
      onPhase: async (phase) => {
        if (phase === 'receipt-committed')
          await writeFile(
            join(root, '.foliohaven/media-records'),
            'projection unavailable',
          );
      },
    });
    const asset = await projecting.process(source.value.id, { jobId });
    const proof = await service.committedResult(jobId, payload);
    const originalReceipt = await readFile(
      join(root, `.foliohaven/media-job-receipts/${jobId}.json`),
      'utf8',
    );
    expect(proof?.result).toEqual({ sourceId: source.value.id, asset });
    expect(proof?.committedAt).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u,
    );
    expect((await service.get(source.value.id)).value.asset).toEqual(asset);
    expect(await service.manifest()).toEqual({
      schemaVersion: 1,
      assets: [asset],
    });
    const file = await service.openVariant(source.value.id, 'image.webp');
    for await (const _chunk of file.stream) {
      /* Drain and close the actual descriptor. */
    }
    await rm(join(root, '.foliohaven/media-records'));
    const ready = await service.get(source.value.id);
    expect(ready.inputRevision).toBe(source.inputRevision);
    expect(ready.etag).not.toBe(source.etag);
    const updated = await service.update(
      source.value.id,
      { displayName: 'Changed after completion' },
      ready.etag,
    );
    expect(updated.value.asset).toBeNull();
    const nextId = randomUUID();
    await service.process(source.value.id, { jobId: nextId });
    expect(await service.committedResult(jobId, payload)).toEqual(proof);
    expect(await service.process(source.value.id, { jobId })).toEqual(asset);
    await expect(
      service.committedResult(jobId, { ...payload, sourceId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'MEDIA_JOB_RECEIPT_MISMATCH' });
    await expect(
      service.process(source.value.id, { jobId, preset: 'article-video' }),
    ).rejects.toMatchObject({ code: 'MEDIA_JOB_RECEIPT_MISMATCH' });
    expect(
      await readFile(
        join(root, `.foliohaven/media-job-receipts/${jobId}.json`),
        'utf8',
      ),
    ).toBe(originalReceipt);
  });
  it('recovers a genuinely killed job owner after receipt commit and before any binding projection', async () => {
    const { root, repository, service, source } = await fixture();
    const jobs = await manager(root, service);
    const queued = await jobs.create({
      type: 'media',
      payload: { sourceId: source.value.id, preset: 'article-image' },
      sourceRevision: source.value.sourceSha256,
    });
    const script = `const {MediaService}=await import(process.argv[3]);const {FileRepository}=await import(process.argv[4]);const {JobManager}=await import(process.argv[5]);const repository=new FileRepository({repositoryRoot:process.argv[1]});await repository.initialize();const media=new MediaService({repositoryRoot:process.argv[1],repository,onPhase:async phase=>{if(phase==='receipt-committed'){process.stdout.write(JSON.stringify({committed:true,pid:process.pid})+'\\n');await new Promise(()=>setInterval(()=>{},1000));}}});const jobs=new JobManager({repositoryRoot:process.argv[1],repository});jobs.register('media',{validateSource:async()=>true,committedResult:(id,payload)=>media.committedResult(id,payload),run:async(context,payload)=>({sourceId:payload.sourceId,asset:await media.process(payload.sourceId,{jobId:context.jobId,jobLeaseFd:context.leaseFd,preset:payload.preset,signal:context.signal})})});await jobs.initialize();await jobs.runNext();`;
    let output = '';
    let killed = false;
    await expect(
      runControlledProcess({
        command: process.execPath,
        args: [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          script,
          root,
          queued.id,
          new URL('../../server/dist/media/index.js', import.meta.url).href,
          new URL('../../server/dist/files/index.js', import.meta.url).href,
          new URL('../../server/src/jobs/index.ts', import.meta.url).href,
        ],
        cwd: new URL('../../', import.meta.url).pathname,
        env: buildProcessEnvironment(),
        timeoutMs: 30000,
        onOutput(stream, bytes) {
          if (stream !== 'stdout') return;
          output += bytes.toString();
          const pid = /"committed":true,"pid":(\d+)/u.exec(output)?.[1];
          if (pid !== undefined && !killed) {
            killed = true;
            process.kill(Number(pid), 'SIGKILL');
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
    expect(killed).toBe(true);
    await expect(
      readFile(join(root, `.foliohaven/media-records/${source.value.id}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = await manager(
      root,
      new MediaService({ repositoryRoot: root, repository }),
    );
    const recovered = await restarted.get(queued.id);
    expect(recovered.status).toBe('succeeded');
    const recoveredMedia = MediaResultSchema.parse(recovered.result);
    expect(recoveredMedia.sourceId).toBe(source.value.id);
    expect((await service.get(source.value.id)).value.asset).toEqual(
      recoveredMedia.asset,
    );
    await expect(restarted.cancel(queued.id)).rejects.toMatchObject({
      code: 'JOB_ALREADY_COMMITTED',
    });
  });
  it('rejects a late cancellation after receipt commit without downgrading the already completed artifact', async () => {
    const { root, repository, source } = await fixture();
    let jobId = '';
    let cancellation: unknown;
    const service = new MediaService({
      repositoryRoot: root,
      repository,
      onPhase: async (phase) => {
        if (phase === 'receipt-committed') {
          try {
            cancellation = await jobs.cancel(jobId);
          } catch (error) {
            cancellation = error;
          }
        }
      },
    });
    const jobs = await manager(root, service);
    const queued = await jobs.create({
      type: 'media',
      payload: { sourceId: source.value.id, preset: 'article-image' },
      sourceRevision: source.value.sourceSha256,
    });
    jobId = queued.id;
    expect((await jobs.runNext())?.status).toBe('succeeded');
    expect((await jobs.get(jobId)).status).toBe('succeeded');
    expect(cancellation).toMatchObject({ code: 'JOB_ALREADY_COMMITTED' });
    expect((await service.get(source.value.id)).value.asset).not.toBeNull();
  });
  it('does not create a receipt when cancellation wins before the final source CAS and commit', async () => {
    const { root, repository, source } = await fixture();
    let jobId = '';
    const service = new MediaService({
      repositoryRoot: root,
      repository,
      onPhase: async (phase) => {
        if (phase === 'before-binding')
          expect((await jobs.cancel(jobId)).httpStatus).toBe(202);
      },
    });
    const jobs = await manager(root, service);
    const payload = {
      sourceId: source.value.id,
      preset: 'article-image' as const,
    };
    const queued = await jobs.create({
      type: 'media',
      payload,
      sourceRevision: source.value.sourceSha256,
    });
    jobId = queued.id;
    expect((await jobs.runNext())?.status).toBe('cancelled');
    expect(await service.committedResult(jobId, payload)).toBeNull();
    expect((await service.get(source.value.id)).value.asset).toBeNull();
  });
  it('rejects malformed, unknown-field and symlink completion evidence through controlled UUID paths', async () => {
    const { root, service, source } = await fixture();
    const jobId = randomUUID();
    const payload = {
      sourceId: source.value.id,
      preset: 'article-image' as const,
    };
    await service.process(source.value.id, { jobId });
    const path = join(root, `.foliohaven/media-job-receipts/${jobId}.json`);
    const original = await readFile(path, 'utf8');
    for (const value of [
      '{broken',
      JSON.stringify({
        ...(JSON.parse(original) as Record<string, unknown>),
        unexpected: true,
      }),
    ]) {
      await writeFile(path, value);
      await expect(
        service.committedResult(jobId, payload),
      ).rejects.toMatchObject({ code: 'MEDIA_JOB_RECEIPT_INVALID' });
    }
    await rm(path);
    const target = join(root, 'unrelated.json');
    await writeFile(target, original);
    await symlink(target, path);
    await expect(service.committedResult(jobId, payload)).rejects.toMatchObject(
      { code: 'RESOURCE_SYMLINK' },
    );
    await expect(
      service.committedResult('../private', payload),
    ).rejects.toMatchObject({ code: 'MEDIA_JOB_ID_INVALID' });
  });
});
