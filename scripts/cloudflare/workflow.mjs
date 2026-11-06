import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  ArtifactStore,
  acquireFileLease,
  buildProcessEnvironment,
  runControlledProcess,
} from '@foliohaven/server';
import { CloudflareError, cancelled, safeDiagnostic } from './errors.mjs';
import {
  atomicJson,
  digest,
  hashFile,
  privateDirectory,
  uuidPattern,
} from './io.mjs';
import {
  createManifest,
  ensureSpace,
  readSiteUrl,
  splitManifest,
  stageWorker,
} from './artifact.mjs';
import { createR2, multipartSizing } from './r2.mjs';
import { createWorker } from './worker.mjs';
import {
  aggregateStatus,
  checkRecordCapacity,
  hasUploadProof,
  deploymentRoot,
  loadDeployment,
  rejectUnresolved,
  rememberUploadProof,
  saveJournal,
} from './state.mjs';

const now = () => new Date().toISOString();
const notify = (context, phase, extra = {}) =>
  context.onProgress?.({ deploymentId: context.deploymentId, phase, ...extra });

async function lease(repositoryRoot, config, signal) {
  const value = await acquireFileLease({
    root: repositoryRoot,
    name: `cloudflare-${digest([config.accountId, config.bucketName])}`,
    owner: 'cloudflare-cli',
    nonBlocking: true,
    ...(signal ? { signal } : {}),
  });
  if (!value)
    throw new CloudflareError(
      'CLOUDFLARE_BUSY',
      '此帳戶及 bucket 已有部署或還原執行中。',
    );
  return value;
}

async function build(repositoryRoot, signal, onProgress) {
  const pending = { stdout: '', stderr: '' };
  let failureCode;
  const receive = (stream, chunk) => {
    pending[stream] += chunk.toString('utf8');
    let end;
    while ((end = pending[stream].indexOf('\n')) >= 0) {
      const line = pending[stream].slice(0, end);
      pending[stream] = pending[stream].slice(end + 1);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const code = event.error?.code ?? event.code;
      if (
        ['build-ended', 'build-failed'].includes(event.event) &&
        /^[A-Z][A-Z0-9_]{1,100}$/.test(code ?? '')
      )
        failureCode = code;
      if (
        event.event === 'build-progress' &&
        typeof event.stage === 'string' &&
        /^[a-z][a-z0-9-]{0,80}$/.test(event.stage)
      )
        onProgress?.({
          phase: 'build',
          stage: event.stage,
          ...(Number.isFinite(event.progress)
            ? { progress: event.progress }
            : {}),
          ...(uuidPattern.test(event.jobId ?? '')
            ? { jobId: event.jobId }
            : {}),
        });
    }
  };
  let result;
  try {
    result = await runControlledProcess({
      command: 'pnpm',
      args: ['run', 'build'],
      cwd: repositoryRoot,
      env: buildProcessEnvironment(),
      timeoutMs: 10_800_000,
      onOutput: receive,
      ...(signal ? { signal } : {}),
    });
  } catch {
    if (signal?.aborted)
      throw new CloudflareError(
        'CLOUDFLARE_CANCELLED',
        '本機建置已取消；未開始上傳。',
      );
    throw new CloudflareError(
      failureCode ?? 'CLOUDFLARE_BUILD_FAILED',
      '正式建置未完成；未開始上傳，請依錯誤代碼檢查來源或建置紀錄。',
    );
  }
  const candidates = [];
  for (const line of result.stdout.toString('utf8').split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.event === 'build-succeeded') candidates.push(entry);
  }
  const success = candidates[0];
  if (
    candidates.length !== 1 ||
    !uuidPattern.test(success.jobId ?? '') ||
    !/^[a-f0-9]{64}$/.test(success.snapshotRevision ?? '')
  )
    throw new CloudflareError(
      'CLOUDFLARE_BUILD_UNPROVEN',
      '未取得唯一正式建置結果；未開始上傳。',
    );
  onProgress?.({ phase: 'build-verified' });
  return { jobId: success.jobId, snapshotRevision: success.snapshotRevision };
}

async function verifySource(context) {
  for (const file of context.manifest) {
    const actual = await hashFile(
      context.root,
      `source/${file.path}`,
      context.signal,
    );
    if (actual.sha256 !== file.sha256 || actual.byteSize !== file.byteSize)
      throw new CloudflareError(
        'CLOUDFLARE_SOURCE_CHANGED',
        '固定的網站副本已變更；停止上傳或還原。',
      );
  }
}

export async function runDeployment({
  repositoryRoot,
  config,
  credentials,
  dryRun = false,
  signal,
  onProgress,
  dependencies = {},
}) {
  const deploymentId = randomUUID();
  const ownedLease = await (dependencies.lease ?? lease)(
    repositoryRoot,
    config,
    signal,
  );
  let context, r2;
  try {
    await rejectUnresolved(repositoryRoot, config);
    const journal = {
      schemaVersion: 1,
      deploymentId,
      target: { ...config },
      startedAt: now(),
      endedAt: null,
      uploadStatus: 'running',
      domainVerification: 'pending',
      phase: 'preflight',
      manifestDigest: null,
      tools: {
        node: process.versions.node,
        wrangler: '4.152.0',
        awsSdk: '3.1156.0',
      },
      capacityEvidence:
        'workersPlan 是本機設定，Cloudflare 實際帳戶限制仍為最終依據。',
      r2: null,
      worker: null,
      diagnostics: [],
    };
    const root = await deploymentRoot(repositoryRoot, deploymentId, journal, {
      signal,
    });
    context = {
      repositoryRoot,
      root,
      deploymentId,
      journal,
      manifest: [],
      signal,
      onProgress,
    };
    context.save = () => saveJournal(context);
    const worker = (dependencies.createWorker ?? createWorker)({
      config,
      token: credentials?.CLOUDFLARE_API_TOKEN,
      repositoryRoot,
      signal,
    });
    notify(context, 'preflight');
    if (!dryRun) {
      r2 = (dependencies.createR2 ?? createR2)({
        config,
        credentials,
        signal,
        onProgress,
      });
      await r2.checkBucket();
      await worker.preflight(context);
    }
    cancelled(signal);
    journal.phase = 'build';
    await context.save();
    notify(context, 'build');
    const successfulBuild = await (dependencies.build ?? build)(
      repositoryRoot,
      signal,
      (event) => notify(context, 'build', event),
    );
    journal.phase = 'capture';
    await context.save();
    const store =
      dependencies.artifacts ?? new ArtifactStore({ repositoryRoot });
    const current = await store.current();
    if (
      !current.current ||
      current.current.build?.jobId !== successfulBuild.jobId
    )
      throw new CloudflareError(
        'CLOUDFLARE_BUILD_REPLACED',
        '目前網站已被其他建置取代；請重新執行部署。',
      );
    const proof = await store.committedProof(successfulBuild.jobId);
    if (!proof)
      throw new CloudflareError(
        'CLOUDFLARE_BUILD_UNPROVEN',
        '建置缺少可用的正式產物證據。',
      );
    await ensureSpace(root, proof.manifest.totalBytes * 2);
    const captured = await store.captureCurrent({
      deploymentId,
      expectedJobId: successfulBuild.jobId,
      expectedSnapshotRevision: successfulBuild.snapshotRevision,
      ...(signal ? { signal } : {}),
    });
    context.manifest = splitManifest(captured.manifest, config);
    for (const file of context.manifest.filter(
      (entry) => entry.target === 'r2',
    ))
      multipartSizing(file.byteSize);
    const document = createManifest(
      captured,
      context.manifest,
      await readSiteUrl(root),
    );
    context.manifestDocument = document;
    journal.build = document.build;
    journal.artifactDigest = document.artifactDigest;
    journal.manifestDigest = digest(document);
    checkRecordCapacity(document);
    await atomicJson(root, 'manifest.json', document);
    journal.phase = 'stage';
    await context.save();
    notify(context, 'stage');
    await stageWorker(root, context.manifest, signal);
    await worker.stage(context);
    await verifySource(context);
    await worker.dryRun(context);
    if (dryRun) {
      journal.phase = 'complete';
      journal.uploadStatus = 'dry-run';
      journal.endedAt = now();
      await context.save();
      notify(context, 'dry-run-complete');
      return context;
    }
    journal.phase = 'r2-backup';
    await context.save();
    notify(context, 'r2-backup');
    await r2.prepare(context);
    const recordSize = checkRecordCapacity(journal);
    // 預留上傳結果與還原後 metadata 的成長空間，避免寫到一半才失去可讀紀錄。
    checkRecordCapacity(
      journal,
      recordSize * 2 + (journal.r2?.records?.length ?? 0) * 4096,
    );
    journal.phase = 'r2-upload';
    await context.save();
    notify(context, 'r2-upload');
    await r2.upload(context);
    const checked = await r2.status(context);
    if (!checked.complete || checked.unknown || checked.conflicts.length)
      throw new CloudflareError(
        'CLOUDFLARE_R2_UNCONFIRMED',
        'R2 尚未全部核對完成，未更新 Worker。',
        { unknown: checked.unknown },
      );
    journal.phase = 'worker-deploy';
    await context.save();
    notify(context, 'worker-deploy');
    await worker.deploy(context);
    rememberUploadProof(context);
    journal.phase = 'complete';
    journal.uploadStatus = 'uploaded';
    journal.endedAt = now();
    await context.save();
    notify(context, 'uploaded');
    return context;
  } catch (error) {
    if (context) {
      const problem = safeDiagnostic(error);
      const unknown =
        problem.unknown ||
        context.journal.worker?.status === 'unknown' ||
        context.journal.r2?.records?.some(
          (entry) => entry.status === 'unknown',
        );
      context.journal.uploadStatus = unknown
        ? 'unknown'
        : !dryRun &&
            context.journal.worker?.stageArtifactInvalid &&
            (context.journal.worker?.after ||
              context.journal.r2?.records?.some(
                (entry) =>
                  entry.action === 'overwrite' && entry.status === 'uploaded',
              ))
          ? 'recovery-required'
          : 'failed';
      context.journal.endedAt = now();
      context.journal.diagnostics.push(problem);
      try {
        await context.save();
      } catch {
        /* 保留既有紀錄或 intent。 */
      }
      if (error instanceof CloudflareError) error.deploymentId = deploymentId;
    }
    throw error;
  } finally {
    r2?.destroy();
    await ownedLease.release();
  }
}

export async function runRecorded({
  repositoryRoot,
  config,
  credentials,
  command,
  deploymentId,
  signal,
  onProgress,
  dependencies = {},
}) {
  const ownedLease = await lease(repositoryRoot, config, signal);
  let r2,
    context,
    restoreStarted = false;
  try {
    context = await loadDeployment(repositoryRoot, deploymentId, config);
    Object.assign(context, { signal, onProgress });
    if (!context.manifestDocument) {
      if (command !== 'status')
        throw new CloudflareError(
          'CLOUDFLARE_RESTORE_UNAVAILABLE',
          '此部署尚未開始上傳，沒有需還原的網站。',
        );
      context.journal.uploadStatus = 'failed';
      context.journal.endedAt = now();
      await context.save();
      return context;
    }
    if (context.journal.uploadStatus === 'dry-run') {
      if (command === 'restore')
        throw new CloudflareError(
          'CLOUDFLARE_RESTORE_UNAVAILABLE',
          'dry-run 沒有遠端變更可還原。',
        );
      return context;
    }
    r2 = (dependencies.createR2 ?? createR2)({
      config,
      credentials,
      signal,
      onProgress,
    });
    const worker = (dependencies.createWorker ?? createWorker)({
      config,
      token: credentials.CLOUDFLARE_API_TOKEN,
      repositoryRoot,
      signal,
    });
    notify(context, command);
    if (command === 'status') {
      const r2State = context.journal.r2?.prepared
        ? await r2.status(context)
        : { complete: false, unknown: false, conflicts: [] };
      const workerState = context.journal.worker
        ? await worker.status(context)
        : { status: 'prepared' };
      context.journal.statusCheck = {
        checkedAt: now(),
        r2: {
          complete: r2State.complete,
          unknown: r2State.unknown,
          conflicts: r2State.conflicts,
        },
        worker: workerState,
      };
      context.journal.uploadStatus = aggregateStatus(
        context.journal,
        r2State,
        workerState,
      );
      if (context.journal.uploadStatus === 'uploaded')
        rememberUploadProof(context);
      if (context.journal.uploadStatus !== 'uploaded')
        context.journal.domainVerification = 'pending';
      await context.save();
      return context;
    }
    await rejectUnresolved(repositoryRoot, config, deploymentId);
    await worker.preflightRestore(context);
    await r2.preflightRestore(context);
    context.journal.uploadStatus = 'recovery-required';
    await context.save();
    restoreStarted = true;
    await r2.restore(context);
    const restoredWorker = await worker.restore(context);
    if (!restoredWorker.restored) {
      context.journal.uploadStatus = 'failed';
      context.journal.restoreStatus = 'r2-restored-no-worker-target';
      context.journal.domainVerification = 'pending';
      context.journal.diagnostics.push({
        code: 'CLOUDFLARE_RESTORE_PARTIAL',
        message:
          'R2 既有資料已還原；首次部署沒有可回復的舊 Worker，未刪除網站。',
        unknown: false,
        retryable: false,
      });
      await context.save();
      return context;
    }
    context.journal.uploadStatus = 'restored';
    context.journal.restoredAt = now();
    context.journal.domainVerification = 'pending';
    await context.save();
    return context;
  } catch (error) {
    if (context && command === 'restore') {
      if (restoreStarted)
        context.journal.uploadStatus =
          error.unknown ||
          ['unknown', 'deploy-intent', 'restore-intent'].includes(
            context.journal.worker?.status,
          ) ||
          context.journal.r2?.records?.some((entry) =>
            ['intent', 'unknown'].includes(entry.restore?.status),
          )
            ? 'unknown'
            : 'recovery-required';
      context.journal.diagnostics.push(safeDiagnostic(error));
      await context.save();
    }
    throw error;
  } finally {
    r2?.destroy();
    await ownedLease.release();
  }
}

export async function runDomainVerification({
  repositoryRoot,
  config,
  deploymentId,
  domain,
  signal,
  onProgress,
  dependencies = {},
}) {
  const ownedLease = await lease(repositoryRoot, config, signal);
  try {
    const context = await loadDeployment(repositoryRoot, deploymentId, config);
    if (
      !['uploaded', 'failed'].includes(context.journal.uploadStatus) ||
      !hasUploadProof(context.journal) ||
      context.journal.worker?.stageArtifactInvalid ||
      context.journal.r2?.records?.some((record) => record.restore)
    )
      throw new CloudflareError(
        'CLOUDFLARE_DOMAIN_NOT_READY',
        '驗證正式網址需要完整的原成功上傳證據，且不得有未解的寫入或還原。',
      );
    await rejectUnresolved(repositoryRoot, config);
    const { verifyDomain, normalizeDomain } =
      await import('./verify-domain.mjs');
    const normalizedDomain = normalizeDomain(domain);
    const attemptId = randomUUID();
    const startedAt = now();
    Object.assign(context, { signal, onProgress });
    context.journal.domainVerification = 'pending';
    context.journal.domainReport = {
      status: 'pending',
      attemptId,
      startedAt,
      domain: normalizedDomain,
      manualVerification: 'pending',
    };
    // 網路請求前先保存本輪pending；突然終止不會沿用上輪passed。
    await context.save();
    const persist = async (report) => {
      const directory = await privateDirectory(
        repositoryRoot,
        `.alfred/reports/cloudflare/${deploymentId}`,
      );
      await atomicJson(directory, 'domain-verification.json', report);
      context.journal.domainVerification =
        report.status === 'passed' ? 'passed' : 'failed';
      context.journal.domainReport = {
        status: report.status,
        attemptId,
        startedAt,
        checkedAt: now(),
        domain: normalizedDomain,
        partial: report.partial === true,
        manualVerification: 'pending',
      };
      await context.save();
    };
    let report;
    try {
      report = await (dependencies.verifyDomain ?? verifyDomain)(
        context,
        normalizedDomain,
      );
    } catch (error) {
      const aborted = signal?.aborted || error?.code === 'CLOUDFLARE_CANCELLED';
      const diagnostic = safeDiagnostic(error);
      const failure = aborted
        ? new CloudflareError(
            'CLOUDFLARE_CANCELLED',
            '網站驗收已取消，已完成項目已保存，其餘尚未驗證。',
          )
        : error instanceof CloudflareError
          ? error
          : new CloudflareError(
              'CLOUDFLARE_DOMAIN_CHECK_FAILED',
              diagnostic.message,
            );
      const partial =
        error instanceof CloudflareError ? error.verificationReport : undefined;
      report =
        partial?.schemaVersion === 1 &&
        partial.domain === normalizedDomain &&
        partial.deploymentId === deploymentId
          ? { ...partial, attemptId }
          : {
              schemaVersion: 1,
              deploymentId,
              domain: normalizedDomain,
              scope: 'automatic',
              status: aborted ? 'cancelled' : 'failed',
              partial: true,
              attemptId,
              startedAt,
              completedAt: now(),
              platform: process.platform,
              nodeVersion: process.versions.node,
              checks: [
                {
                  code: aborted
                    ? 'verification-cancelled'
                    : 'verification-failed',
                  status: 'failed',
                  errorCode: failure.code,
                  message: failure.message,
                },
              ],
              requiresManualVerification: [
                'cloud-connector-and-no-script-routes',
                'manual-rules-preserved-after-redeploy',
                'large-video-upload-and-update-restore-evidence',
              ],
            };
      failure.verificationReport = report;
      try {
        await persist(report);
      } catch {
        throw new CloudflareError(
          aborted ? 'CLOUDFLARE_CANCELLED' : 'CLOUDFLARE_DOMAIN_REPORT_FAILED',
          '網站驗收未完成，且結果未完整保存；請保留部署資料並檢查磁碟及權限。',
        );
      }
      throw failure;
    }
    report = { ...report, attemptId };
    try {
      await persist(report);
    } catch {
      throw new CloudflareError(
        'CLOUDFLARE_DOMAIN_REPORT_FAILED',
        '網站驗收結果未完整保存，請保留部署資料並檢查磁碟及權限。',
      );
    }
    return { context, report };
  } finally {
    await ownedLease.release();
  }
}

export async function checkInstalledTools() {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  if (
    process.getuid?.() === 0 ||
    process.platform !== 'linux' ||
    process.versions.node !== manifest.engines.node
  )
    throw new CloudflareError(
      'CLOUDFLARE_ENVIRONMENT_INVALID',
      '請使用專案固定版本的非 root Linux／Docker 環境。',
    );
  const require = createRequire(new URL('../../package.json', import.meta.url));
  for (const [name, version] of [
    ['wrangler', '4.152.0'],
    ['@aws-sdk/client-s3', '3.1156.0'],
  ]) {
    const path = require.resolve(`${name}/package.json`);
    if (JSON.parse(await readFile(path, 'utf8')).version !== version)
      throw new CloudflareError(
        'CLOUDFLARE_TOOLCHAIN_INVALID',
        'Cloudflare 工具版本與 lockfile 基線不符，請依文件 frozen install。',
      );
  }
}
