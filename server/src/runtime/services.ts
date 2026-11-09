import { fixedPages, pageSchemas } from '@foliohaven/site/registry';
import { HtmlProcessingCache } from '@foliohaven/core';
import { FileRepository } from '../files/index.js';
import { pinPrivateDirectory, RepositoryError } from '../files/io.js';
import { ContentService } from '../content/index.js';
import { MediaService } from '../media/index.js';
import { ArtifactStore } from '../build/artifacts/index.js';
import { BuildInputCache, scanBuildInputs } from '../build/inputs.js';
import { BuildCoordinator } from '../build/coordinator.js';
import type { BuildCoordinatorOptions } from '../build/coordinator.js';
import { OperationStore } from '../operations/index.js';
import { JobManager } from '../jobs/index.js';

export interface LocalRuntimeOptions {
  readonly repositoryRoot: string;
  readonly clock?: () => Date;
  /** 僅程式內隔離驗收使用；不接受HTTP或CLI傳入任意worker。 */
  readonly buildExecution?: BuildCoordinatorOptions['execution'];
}
export interface LocalRuntime {
  readonly repository: FileRepository;
  readonly artifacts: ArtifactStore;
  readonly media: MediaService;
  readonly content: ContentService;
  readonly operations: OperationStore;
  readonly jobs: JobManager;
  readonly build: BuildCoordinator;
  readonly scanInputs: (signal?: AbortSignal) => Promise<string>;
  readonly scanWorkspaceInputs: (signal?: AbortSignal) => Promise<string>;
  readonly htmlCache: HtmlProcessingCache;
  close(): Promise<void>;
}
/** HTTP及CLI共享實際服務與三種handler；完成復原但由呼叫端決定排程範圍。 */
export async function createLocalRuntime(
  options: LocalRuntimeOptions,
): Promise<LocalRuntime> {
  const unpinDirectory = pinPrivateDirectory(options.repositoryRoot);
  try {
    return await createPinnedRuntime(options, unpinDirectory);
  } catch (error) {
    unpinDirectory();
    throw error;
  }
}

async function createPinnedRuntime(
  options: LocalRuntimeOptions,
  unpinDirectory: () => void,
): Promise<LocalRuntime> {
  const repository = new FileRepository({
    repositoryRoot: options.repositoryRoot,
    pageSchemas,
    reuseFileDigests: true,
    registeredPageIds: fixedPages.map((page) => page.id),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const artifacts = new ArtifactStore({
    repositoryRoot: options.repositoryRoot,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const media = new MediaService({
    repositoryRoot: options.repositoryRoot,
    repository,
    fixedPages,
    reuseFileDigests: true,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const inputCache = new BuildInputCache();
  const scanInputs = async (signal?: AbortSignal) =>
    (
      await scanBuildInputs(
        options.repositoryRoot,
        signal === undefined ? {} : { signal },
      )
    ).revision;
  const scanWorkspaceInputs = async (signal?: AbortSignal) =>
    (
      await scanBuildInputs(options.repositoryRoot, {
        cache: inputCache,
        ...(signal === undefined ? {} : { signal }),
      })
    ).revision;
  const htmlCache = new HtmlProcessingCache();
  const content = new ContentService({
    repository,
    fixedPages,
    scanInputs,
    htmlCache,
    getMediaManifest: (session) => media.manifest(undefined, session),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const operations = new OperationStore({
    repositoryRoot: options.repositoryRoot,
    repository,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const jobs = new JobManager({
    repositoryRoot: options.repositoryRoot,
    repository,
    operations,
    artifacts,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const build = new BuildCoordinator({
    repositoryRoot: options.repositoryRoot,
    repository,
    artifacts,
    ...(options.buildExecution ? { execution: options.buildExecution } : {}),
  });
  jobs.register('build', build);
  jobs.register('media', {
    validateSource: async (payload, revision) =>
      (await media.get(payload.sourceId)).inputRevision === revision,
    run: async (context, payload) => ({
      sourceId: payload.sourceId,
      asset: await media.process(payload.sourceId, {
        jobId: context.jobId,
        preset: payload.preset,
        signal: context.signal,
        jobLeaseFd: context.leaseFd,
        onProgress: (progress) => context.progress(progress),
      }),
    }),
    committedResult: (id, payload) => media.committedResult(id, payload),
  });
  jobs.register('taxonomy', {
    validateSource: async (payload, revision) =>
      revision === payload.workspaceRevision &&
      (await scanInputs()) === revision,
    run: async (context, payload) => {
      if (context.signal.aborted)
        throw new RepositoryError('JOB_CANCELLED', '工作已取消。', 409);
      await context.progress({
        stage: 'planning-migration',
        completed: 0,
        total: 1,
      });
      // durable job代表先前已確認授權；重啟後仍只用原revision重算，不接受客戶端影響清單。
      const plan = await content.planMigration({
        kind: payload.kind,
        from: payload.from,
        to: payload.to,
        workspaceRevision: payload.workspaceRevision,
      });
      if (context.signal.aborted)
        throw new RepositoryError('JOB_CANCELLED', '工作已取消。', 409);
      const result = await content.executeMigration(
        { ...payload, planId: plan.planId },
        { jobId: context.jobId },
      );
      return result.value;
    },
  });
  try {
    await jobs.initialize();
  } catch (error) {
    await jobs.close();
    await operations.close();
    throw error;
  }
  let closeTask: Promise<void> | undefined;
  return {
    repository,
    artifacts,
    media,
    content,
    operations,
    jobs,
    build,
    scanInputs,
    scanWorkspaceInputs,
    htmlCache,
    close() {
      closeTask ??= (async () => {
        try {
          await jobs.close();
        } finally {
          try {
            await operations.close();
          } finally {
            unpinDirectory();
          }
        }
      })();
      return closeTask;
    },
  };
}
