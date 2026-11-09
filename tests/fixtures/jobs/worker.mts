import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { JobManager } from '../../../server/src/jobs/index.js';
import { ArtifactStore } from '../../../server/src/build/artifacts/index.js';
import { OperationStore } from '../../../server/src/operations/index.js';
import { safeMkdir } from '../../../server/src/files/io.js';
import { runControlledProcess } from '../../../server/src/runtime/process.js';
import { FileRepository } from '../../../server/src/files/index.js';
import { ContentService } from '../../../server/src/content/index.js';
import { fixedPages, scanContent } from './content.mjs';
const root = process.argv[2];
const mode = process.argv[3];
if (!root || !mode) throw new Error('fixture arguments missing');
const revision = createHash('sha256').update('source').digest('hex');
const artifacts = new ArtifactStore({
  repositoryRoot: root,
  fault: (event) => {
    if (mode === 'proof-crash' && event.phase === 'artifact-committed')
      process.exit(77);
  },
});
const operations = new OperationStore({ repositoryRoot: root });
const repository = new FileRepository({
  repositoryRoot: root,
  fault: (event) => {
    if (mode === 'taxonomy-crash' && event.phase === 'committed-journal')
      process.exit(77);
  },
});
const jobs = new JobManager({
  repositoryRoot: root,
  artifacts,
  operations,
  repository,
  pollIntervalMs: 20,
  fault: (phase) => {
    if (mode === 'claim-crash' && phase === 'claimed') process.exit(77);
  },
});
if (mode === 'taxonomy-crash') {
  const service = new ContentService({
    repository,
    fixedPages,
    scanInputs: () => scanContent(root),
  });
  jobs.register('taxonomy', {
    validateSource: async (_payload, expected) =>
      expected === (await scanContent(root)),
    run: async (context, payload) => {
      const descriptor = {
        kind: payload.kind,
        from: payload.from,
        to: payload.to,
        workspaceRevision: payload.workspaceRevision,
      };
      const plan = await service.planMigration(descriptor);
      return (
        await service.executeMigration(
          { ...descriptor, planId: plan.planId },
          { jobId: context.jobId },
        )
      ).value;
    },
  });
}
jobs.register('build', {
  validateSource: async () => true,
  run: async (context) => {
    if (mode === 'hold') {
      await runControlledProcess({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(String(process.pid)+"\\n");setInterval(()=>{},1000)',
        ],
        cwd: root,
        timeoutMs: 60_000,
        signal: context.signal,
        passFds: [context.leaseFd],
        onOutput: (_stream, chunk) =>
          process.stdout.write(
            `READY ${context.jobId} ${chunk.toString().trim()}\n`,
          ),
      });
    }
    if (mode === 'proof-crash') {
      await safeMkdir(root, `.foliohaven/builds/${context.jobId}/output`);
      await writeFile(
        `${root}/.foliohaven/builds/${context.jobId}/output/index.html`,
        '<!doctype html><p>proof</p>',
      );
      const proof = await artifacts.promote(context.jobId, {
        snapshotRevision: revision,
        routeCount: 1,
      });
      return proof.result;
    }
    return {
      outputDirectory: 'dist',
      snapshotRevision: revision,
      routeCount: 1,
      fileCount: 1,
      warnings: [],
    };
  },
});
await jobs.initialize();
await jobs.runNext();
await jobs.close();
await operations.close();
