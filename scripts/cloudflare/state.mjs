import { privateResource } from '../workspace-paths.mjs';
import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigSchema } from './config.mjs';
import { CloudflareError, cancelled } from './errors.mjs';
import {
  atomicJson,
  digest,
  digestPattern,
  privateDirectory,
  readOwnerFile,
  safePath,
  syncDirectory,
  uuidPattern,
  validPath,
} from './io.mjs';

const uploads = [
  'dry-run',
  'running',
  'uploaded',
  'failed',
  'unknown',
  'recovery-required',
  'restored',
];
export const maxRecordBytes = 64 * 1024 * 1024;
export function checkRecordCapacity(value, reserveBytes = 0) {
  const size = Buffer.byteLength(JSON.stringify(value, null, 2)) + 1;
  if (size + reserveBytes > maxRecordBytes)
    throw new CloudflareError(
      'CLOUDFLARE_RECORD_LIMIT',
      '部署清單或復原紀錄超過容量限制；未繼續上傳，請縮小本次網站資源量。',
    );
  return size;
}
const FileSchema = z.strictObject({
  path: z.string().refine(validPath),
  kind: z.literal('file'),
  target: z.enum(['worker', 'r2']),
  byteSize: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(digestPattern),
  mime: z.string().min(1).max(150),
});
const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  artifactDigest: z.string().regex(digestPattern),
  filesDigest: z.string().regex(digestPattern),
  siteUrl: z.url(),
  build: z.strictObject({
    jobId: z.string().regex(uuidPattern),
    snapshotRevision: z.string().min(1).max(150),
  }),
  files: z.array(FileSchema).max(200000),
});

export function sameTarget(a, b) {
  return (
    a.accountId === b.accountId &&
    a.workerName === b.workerName &&
    a.bucketName === b.bucketName
  );
}

export function hasUploadProof(journal) {
  if (!journal || !ConfigSchema.safeParse(journal.target).success) return false;
  const proof = journal?.uploadProof;
  const reference = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  return (
    proof?.schemaVersion === 1 &&
    proof.deploymentId === journal.deploymentId &&
    digestPattern.test(proof.manifestDigest ?? '') &&
    proof.manifestDigest === journal.manifestDigest &&
    digestPattern.test(proof.artifactDigest ?? '') &&
    proof.artifactDigest === journal.artifactDigest &&
    proof.targetDigest === digest(journal.target) &&
    proof.r2Verified === true &&
    reference.test(proof.workerVersion ?? '') &&
    reference.test(proof.workerDeploymentId ?? '') &&
    proof.workerVersion === journal.worker?.after?.versionId &&
    proof.workerDeploymentId === journal.worker?.after?.deploymentId &&
    typeof proof.verifiedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(proof.verifiedAt) &&
    Number.isFinite(Date.parse(proof.verifiedAt))
  );
}

export function rememberUploadProof(context) {
  const journal = context.journal;
  if (journal.uploadProof) {
    if (!hasUploadProof(journal))
      throw new CloudflareError(
        'CLOUDFLARE_PROOF_INVALID',
        '原成功上傳證據不符，停止覆寫這份紀錄。',
      );
    return;
  }
  journal.uploadProof = {
    schemaVersion: 1,
    deploymentId: context.deploymentId,
    manifestDigest: journal.manifestDigest,
    artifactDigest: journal.artifactDigest,
    targetDigest: digest(journal.target),
    r2Verified: true,
    workerVersion: journal.worker?.after?.versionId,
    workerDeploymentId: journal.worker?.after?.deploymentId,
    verifiedAt: new Date().toISOString(),
  };
  if (!hasUploadProof(journal))
    throw new CloudflareError(
      'CLOUDFLARE_PROOF_INVALID',
      '本次上傳缺少完整版本或產物證據，請保留紀錄並查詢。',
      { unknown: true },
    );
}

export function aggregateStatus(journal, r2State, workerState) {
  if (
    r2State.unknown ||
    workerState.status === 'unknown' ||
    ['unknown', 'deploy-intent', 'restore-intent'].includes(
      journal.worker?.status,
    )
  )
    return 'unknown';
  if (journal.worker?.stageArtifactInvalid && workerState.status !== 'restored')
    return 'recovery-required';
  const restoring =
    journal.uploadStatus === 'recovery-required' ||
    journal.r2?.records?.some(
      (record) => record.restore !== null && record.restore !== undefined,
    ) ||
    ['restore-intent', 'restored'].includes(journal.worker?.status);
  if (restoring) {
    if (
      r2State.complete &&
      journal.r2?.restoreComplete &&
      workerState.status === 'restored'
    )
      return 'restored';
    if (journal.restoreStatus === 'r2-restored-no-worker-target')
      return 'failed';
    return 'recovery-required';
  }
  return r2State.complete && workerState.status === 'uploaded'
    ? 'uploaded'
    : 'failed';
}

export async function deploymentRoot(
  repositoryRoot,
  deploymentId,
  initialJournal,
  options = {},
) {
  if (!uuidPattern.test(deploymentId))
    throw new CloudflareError(
      'CLOUDFLARE_DEPLOYMENT_INVALID',
      '部署識別無效。',
    );
  let journal;
  try {
    journal = JSON.parse(JSON.stringify(initialJournal));
    if (
      journal.schemaVersion !== 1 ||
      journal.deploymentId !== deploymentId ||
      journal.phase !== 'preflight' ||
      journal.uploadStatus !== 'running' ||
      journal.domainVerification !== 'pending' ||
      journal.manifestDigest !== null ||
      journal.r2 !== null ||
      journal.worker !== null ||
      !ConfigSchema.safeParse(journal.target).success
    )
      throw new Error();
    checkRecordCapacity(journal);
  } catch {
    throw new CloudflareError(
      'CLOUDFLARE_JOURNAL_INVALID',
      '初始部署紀錄不符合規則，未啟用部署。',
    );
  }
  const absent = async (path) => {
    try {
      await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    throw new CloudflareError(
      'CLOUDFLARE_DEPLOYMENT_EXISTS',
      '部署識別已有正式目錄，不能覆蓋；請保留現有資料。',
    );
  };
  try {
    cancelled(options.signal);
    const initializedParent = await privateDirectory(
      repositoryRoot,
      privateResource(repositoryRoot, 'deployment-initialization'),
    );
    const activeParent = await privateDirectory(
      repositoryRoot,
      privateResource(repositoryRoot, 'deployments'),
    );
    // Persist both new parent names before making any deployment eligible for upload.
    await syncDirectory(repositoryRoot);
    await syncDirectory(
      await safePath(repositoryRoot, privateResource(repositoryRoot)),
    );
    const initializedRoot = await safePath(initializedParent, deploymentId);
    const activeRoot = await safePath(activeParent, deploymentId);
    await absent(activeRoot);
    cancelled(options.signal);
    try {
      await mkdir(initializedRoot, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new CloudflareError(
          'CLOUDFLARE_INITIALIZATION_EXISTS',
          '此部署識別已有初始化證據，不能重用或清除；請建立新的部署。',
        );
      throw error;
    }
    await syncDirectory(initializedParent);
    await options.fault?.('before-journal', initializedRoot);
    cancelled(options.signal);
    await atomicJson(initializedRoot, 'journal.json', journal);
    await options.fault?.('after-journal', initializedRoot);
    cancelled(options.signal);
    await atomicJson(initializedRoot, 'receipt.json', journal);
    await syncDirectory(initializedRoot);
    await options.fault?.('before-activate', initializedRoot);
    cancelled(options.signal);
    const names = (await readdir(initializedRoot)).sort();
    if (
      names.length !== 2 ||
      names[0] !== 'journal.json' ||
      names[1] !== 'receipt.json' ||
      digest(
        JSON.parse(
          await readOwnerFile(initializedRoot, 'journal.json', maxRecordBytes),
        ),
      ) !== digest(journal) ||
      digest(
        JSON.parse(
          await readOwnerFile(initializedRoot, 'receipt.json', maxRecordBytes),
        ),
      ) !== digest(journal)
    )
      throw new CloudflareError(
        'CLOUDFLARE_INITIALIZATION_CHANGED',
        '初始部署紀錄在啟用前改變，請保留初始化證據。',
      );
    // The writer lease protects cooperating publishers; UUIDs and the second
    // guard also refuse an existing destination rather than replacing its data.
    await absent(activeRoot);
    await rename(initializedRoot, activeRoot);
    await syncDirectory(activeParent);
    await syncDirectory(initializedParent);
    // Once activated, let the caller create context and record any cancellation.
    return activeRoot;
  } catch (error) {
    if (error instanceof CloudflareError) error.deploymentId = deploymentId;
    throw error;
  }
}

export async function saveJournal(context) {
  if (
    resolve(context.root) !==
    resolve(
      context.repositoryRoot,
      privateResource(
        context.repositoryRoot,
        `deployments/${context.deploymentId}`,
      ),
    )
  )
    throw new CloudflareError(
      'PRIVATE_DIRECTORY_CHANGED',
      '部署工作使用的私有資料目錄已改變；請停止工作並保留原紀錄，先查明結果再恢復。',
      { unknown: true },
    );
  checkRecordCapacity(context.journal);
  await atomicJson(context.root, 'journal.json', context.journal);
  await atomicJson(context.root, 'receipt.json', context.journal);
}

export async function loadDeployment(repositoryRoot, deploymentId, config) {
  if (!uuidPattern.test(deploymentId))
    throw new CloudflareError(
      'CLOUDFLARE_DEPLOYMENT_INVALID',
      '部署識別無效。',
    );
  const root = await safePath(
    repositoryRoot,
    privateResource(repositoryRoot, `deployments/${deploymentId}`),
  );
  let journal, manifest;
  try {
    journal = JSON.parse(
      await readOwnerFile(root, 'journal.json', 64 * 1024 * 1024),
    );
    manifest =
      journal.manifestDigest === null &&
      ['preflight', 'build', 'capture'].includes(journal.phase)
        ? null
        : ManifestSchema.parse(
            JSON.parse(
              await readOwnerFile(root, 'manifest.json', 64 * 1024 * 1024),
            ),
          );
    ConfigSchema.parse(journal.target);
    if (
      journal.schemaVersion !== 1 ||
      journal.deploymentId !== deploymentId ||
      !sameTarget(journal.target, config) ||
      !uploads.includes(journal.uploadStatus) ||
      !['pending', 'passed', 'failed'].includes(journal.domainVerification) ||
      (manifest !== null &&
        (digest(manifest.files) !== manifest.filesDigest ||
          digest(manifest) !== journal.manifestDigest ||
          manifest.files.some(
            (file) =>
              file.target !==
              (file.path.startsWith('assets/') || file.path.startsWith('media/')
                ? 'r2'
                : 'worker'),
          ) ||
          new Set(manifest.files.map((file) => file.path)).size !==
            manifest.files.length))
    )
      throw new Error();
  } catch {
    throw new CloudflareError(
      'CLOUDFLARE_JOURNAL_INVALID',
      '部署紀錄、固定清單或目前目標不符；請保留資料，不可直接覆蓋。',
    );
  }
  const context = {
    repositoryRoot,
    root,
    deploymentId,
    journal,
    manifest: manifest?.files ?? [],
    manifestDocument: manifest,
  };
  context.save = () => saveJournal(context);
  return context;
}

export async function rejectUnresolved(repositoryRoot, config, except) {
  const directory = await privateDirectory(
    repositoryRoot,
    privateResource(repositoryRoot, 'deployments'),
  );
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === except) continue;
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !uuidPattern.test(entry.name)
    )
      throw new CloudflareError(
        'CLOUDFLARE_JOURNAL_INVALID',
        '部署目錄含不明項目，請保留並排查。',
      );
    let previous;
    try {
      previous = JSON.parse(
        await readOwnerFile(
          directory,
          `${entry.name}/journal.json`,
          64 * 1024 * 1024,
        ),
      );
    } catch {
      throw new CloudflareError(
        'CLOUDFLARE_RECOVERY_REQUIRED',
        '有未完成或無法讀取的部署紀錄，請先排查。',
      );
    }
    if (
      previous.schemaVersion !== 1 ||
      previous.deploymentId !== entry.name ||
      !uploads.includes(previous.uploadStatus)
    )
      throw new CloudflareError(
        'CLOUDFLARE_JOURNAL_INVALID',
        '舊部署紀錄無法判讀，請保留並排查。',
      );
    if (
      previous.target?.accountId === config.accountId &&
      previous.target?.bucketName === config.bucketName &&
      ['running', 'unknown', 'recovery-required'].includes(
        previous.uploadStatus,
      )
    )
      throw new CloudflareError(
        'CLOUDFLARE_RECOVERY_REQUIRED',
        `部署 ${entry.name} 尚未釐清；請先執行 status。`,
      );
  }
}
