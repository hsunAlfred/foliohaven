import { constants } from 'node:fs';
import type { createReadStream } from 'node:fs';
import { lstat, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  BuildResultSchema,
  CurrentArtifactSchema,
  RecoveryResolutionSchema,
  UuidSchema,
} from '@foliohaven/core';
import type {
  CurrentArtifact,
  RecoveryDetail,
  RecoveryResolution,
} from '@foliohaven/core';
import {
  atomicJson,
  isMissing,
  readJson,
  RepositoryError,
  safeMkdir,
  safePath,
  stableHash,
  syncDirectory,
} from '../../files/io.js';
import { acquireFileLease } from '../../runtime/lease.js';
import { parseArtifactJournal, parseArtifactState } from './journal.js';
import type { ArtifactJournal, ArtifactState } from './journal.js';
import {
  capturePreviewFingerprint,
  previewFingerprintMatches,
  type PreviewFingerprint,
} from './preview-cache.js';
import {
  ArtifactError,
  checkArtifactCancelled,
  copyArtifactTree,
  scanArtifactTree,
  syncArtifactTree,
} from './tree.js';
import type {
  ArtifactFaultPhase,
  ArtifactManifest,
  ArtifactProof,
  ArtifactRecoveryResult,
  ArtifactRecoveryState,
  ArtifactRecoverySummary,
  ArtifactStoreOptions,
  CaptureCurrentOptions,
  CapturedArtifact,
  PromoteOptions,
  PreparedPromotion,
} from './types.js';

type Version = RecoveryDetail['resources'][number]['base'];
interface TreeVersion {
  readonly manifest: ArtifactManifest;
  readonly resource: string;
}
interface Download {
  readonly path: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly fileName: string;
}
interface Detail {
  readonly value: RecoveryDetail;
  readonly etag: string;
  readonly downloads: ReadonlyMap<string, Download>;
  readonly currentManifest: ArtifactManifest | null;
}
const emptyVersion = (): Version => ({
  revision: null,
  text: null,
  binary: null,
});
function fileId(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** dist 的唯一提升入口；呼叫端在外層持有 repository writer lock 完成來源 CAS。 */
export class ArtifactStore {
  readonly #root: string;
  readonly #options: ArtifactStoreOptions;
  #queue: Promise<void> = Promise.resolve();
  #deferPreservation = false;
  #previewValidation:
    | { readonly fingerprint: PreviewFingerprint; readonly digest: string }
    | undefined;
  #state: ArtifactState = {
    schemaVersion: 1,
    sequence: 0,
    currentSequence: 0,
    currentJournalId: null,
    acceptedDigest: null,
  };
  constructor(options: ArtifactStoreOptions) {
    this.#root = resolve(options.repositoryRoot);
    this.#options = options;
  }
  #now(): string {
    return (this.#options.clock?.() ?? new Date()).toISOString();
  }
  #id(id: string): string {
    if (!UuidSchema.safeParse(id).success)
      throw new ArtifactError('INVALID_JOB_ID', '建置識別不符合規則。', 400);
    return id;
  }
  #private(id: string, suffix: string): string {
    return `.alfred/artifacts/${this.#id(id)}/${suffix}`;
  }
  #candidate(journal: ArtifactJournal): string {
    return journal.kind === 'build'
      ? `.alfred/builds/${journal.id}/output`
      : this.#private(journal.id, 'candidate');
  }
  async #fault(phase: ArtifactFaultPhase, jobId: string): Promise<void> {
    await this.#options.fault?.({ phase, jobId });
  }
  async #save(journal: ArtifactJournal): Promise<void> {
    parseArtifactJournal(journal);
    await atomicJson(
      this.#root,
      this.#private(journal.id, 'journal.json'),
      journal,
    );
  }
  async #saveState(): Promise<void> {
    await atomicJson(this.#root, '.alfred/artifacts/state.json', this.#state);
  }
  async #journals(): Promise<ArtifactJournal[]> {
    const journals: ArtifactJournal[] = [];
    for (const entry of await readdir(
      await safePath(this.#root, '.alfred/artifacts'),
      { withFileTypes: true },
    )) {
      if (
        entry.name === 'state.json' ||
        /^state\.json\.[a-f0-9-]+\.tmp$/.test(entry.name)
      )
        continue;
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !UuidSchema.safeParse(entry.name).success
      )
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '產物復原目錄包含無法判讀的項目。',
        );
      let value: unknown;
      try {
        value = await readJson(
          this.#root,
          this.#private(entry.name, 'journal.json'),
        );
      } catch (error) {
        if (isMissing(error)) continue;
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '產物提交紀錄無法讀取，請保留資料。',
        );
      }
      const journal = parseArtifactJournal(value);
      if (journal.id !== entry.name)
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '產物提交識別與保留目錄不一致。',
        );
      journals.push(journal);
    }
    if (
      new Set(journals.map((journal) => journal.sequence)).size !==
      journals.length
    )
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '產物提交序號重複，請保留資料並檢查。',
      );
    return journals.sort((a, b) => a.sequence - b.sequence);
  }
  async #locked<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const preceding = this.#queue;
    let releaseQueue: (() => void) | undefined;
    this.#queue = new Promise<void>((resolveQueue) => {
      releaseQueue = resolveQueue;
    });
    await preceding;
    let lease;
    try {
      checkArtifactCancelled(signal);
      const root = await lstat(this.#root);
      if (!root.isDirectory() || root.isSymbolicLink())
        throw new ArtifactError(
          'INVALID_BUILD_ROOT',
          '建置工作區必須是一般目錄。',
          500,
        );
      lease = await acquireFileLease({
        root: this.#root,
        name: 'artifact-promotion',
        owner: 'artifact-store',
        timeoutMs: this.#options.lockTimeoutMs ?? 10_000,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!lease)
        throw new ArtifactError(
          'BUILD_PROMOTION_BUSY',
          '產物正在切換，請稍後重試。',
        );
      await safeMkdir(this.#root, '.alfred/artifacts');
      try {
        this.#state = parseArtifactState(
          await readJson(this.#root, '.alfred/artifacts/state.json'),
        );
      } catch (error) {
        if (!isMissing(error)) throw error;
        await this.#saveState();
      }
      return await fn();
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new ArtifactError(
        'ARTIFACT_IO_FAILED',
        '產物檔案操作失敗，請檢查工作及復原狀態。',
        503,
      );
    } finally {
      try {
        await lease?.release();
      } finally {
        releaseQueue?.();
      }
    }
  }
  async #rename(source: string, target: string): Promise<void> {
    await rename(
      await safePath(this.#root, source),
      await safePath(this.#root, target),
    );
    await syncDirectory(dirname(await safePath(this.#root, source)));
    await syncDirectory(dirname(await safePath(this.#root, target)));
  }
  async #tree(resource: string): Promise<ArtifactManifest | null> {
    return scanArtifactTree(this.#root, resource);
  }
  async #matches(
    resource: string,
    manifest: ArtifactManifest | null,
  ): Promise<boolean> {
    return (await this.#tree(resource))?.digest === manifest?.digest;
  }
  async #preserve(
    journal: ArtifactJournal,
    resource: string,
  ): Promise<TreeVersion | null> {
    const manifest = await this.#tree(resource);
    if (manifest === null) return null;
    const destination = this.#private(
      journal.id,
      `observed/${manifest.digest}`,
    );
    const existing = await this.#tree(destination);
    if (existing !== null && existing.digest !== manifest.digest)
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '保留的產物版本已損壞。',
      );
    if (existing === null)
      await copyArtifactTree(this.#root, resource, destination, manifest);
    return { manifest, resource: destination };
  }
  async #conflict(journal: ArtifactJournal): Promise<void> {
    journal.status = 'recovery-required';
    delete journal.temporaryDiscarded;
    await this.#save(journal);
    if (this.#deferPreservation) return;
    for (const resource of [
      'dist',
      this.#private(journal.id, 'backup'),
      this.#candidate(journal),
    ]) {
      try {
        await this.#preserve(journal, resource);
      } catch {
        /* 原目錄及 journal 已保留；空間或權限修復後可再讀復原資料。 */
      }
    }
  }
  async #commitMarker(journal: ArtifactJournal): Promise<void> {
    if (!(await this.#matches('dist', journal.prepared))) {
      await this.#conflict(journal);
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '切換後的產物與候選版本不一致。',
      );
    }
    journal.status = 'committed';
    if (journal.kind === 'build') journal.artifactCommittedAt = this.#now();
    await this.#save(journal);
    await this.#fault('artifact-committed', journal.id);
    this.#state.currentSequence = journal.sequence;
    this.#state.currentJournalId = journal.id;
    this.#state.acceptedDigest = journal.prepared?.digest ?? null;
    await this.#saveState();
    await this.#fault('state-committed', journal.id);
  }
  async #rollback(journal: ArtifactJournal): Promise<void> {
    if (
      (await this.#tree('dist')) !== null ||
      !(await this.#matches(this.#private(journal.id, 'backup'), journal.base))
    ) {
      await this.#conflict(journal);
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '舊產物無法安全還原，所有版本已保留。',
      );
    }
    if (journal.base !== null) {
      await this.#fault('before-rollback-rename', journal.id);
      await this.#rename(this.#private(journal.id, 'backup'), 'dist');
      await this.#fault('rollback-restored', journal.id);
    }
    if (!(await this.#matches('dist', journal.base))) {
      await this.#conflict(journal);
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '還原後的舊產物無法驗證，請先復原。',
      );
    }
    journal.status = 'rolled-back';
    await this.#save(journal);
  }
  async #recoverJournal(journal: ArtifactJournal): Promise<void> {
    if (journal.status !== 'prepared' && journal.status !== 'switching') return;
    const current = await this.#tree('dist');
    const candidate = await this.#tree(this.#candidate(journal));
    const backup = await this.#tree(this.#private(journal.id, 'backup'));
    if (
      !(await this.#matches(
        this.#private(journal.id, 'prepared'),
        journal.prepared,
      )) ||
      !(await this.#matches(this.#private(journal.id, 'base'), journal.base))
    ) {
      await this.#conflict(journal);
      return;
    }
    if (journal.status === 'prepared') {
      if (
        current?.digest !== journal.base?.digest ||
        candidate?.digest !== journal.prepared?.digest ||
        backup !== null
      ) {
        await this.#conflict(journal);
        return;
      }
      journal.status = 'rolled-back';
      await this.#save(journal);
      return;
    }
    if (backup !== null && backup.digest !== journal.base?.digest) {
      await this.#conflict(journal);
      return;
    }
    if (candidate !== null && candidate.digest !== journal.prepared?.digest) {
      await this.#conflict(journal);
      return;
    }
    // 第二次 rename 已完成，必須再次驗證完整樹後才產生成功證據。
    if (
      current?.digest === journal.prepared?.digest &&
      candidate === null &&
      (journal.base === null || backup?.digest === journal.base.digest)
    ) {
      await this.#commitMarker(journal);
      return;
    }
    if (
      current?.digest === journal.base?.digest &&
      backup === null &&
      candidate?.digest === journal.prepared?.digest
    ) {
      journal.status = 'rolled-back';
      await this.#save(journal);
      return;
    }
    if (
      current === null &&
      backup?.digest === journal.base?.digest &&
      (candidate === null || candidate.digest === journal.prepared?.digest)
    ) {
      await this.#rollback(journal);
      return;
    }
    await this.#conflict(journal);
  }
  async #finishResolution(journal: ArtifactJournal): Promise<void> {
    const decision = journal.resolution;
    if (!decision) return;
    if (decision.choice === 'keep-current') {
      if (
        (await this.#tree('dist'))?.digest !==
        (decision.expectedDigest ?? undefined)
      ) {
        delete journal.resolution;
        await this.#conflict(journal);
        return;
      }
      this.#state.sequence++;
      this.#state.currentSequence = this.#state.sequence;
      this.#state.currentJournalId = null;
      this.#state.acceptedDigest = decision.expectedDigest;
      await this.#saveState();
    }
    journal.status = 'resolved';
    await this.#save(journal);
  }
  async #recoverLocked(): Promise<ArtifactRecoveryState> {
    let journals = await this.#journals();
    const highestSequence = journals.at(-1)?.sequence ?? 0;
    if (highestSequence > this.#state.sequence) {
      this.#state.sequence = highestSequence;
      await this.#saveState();
    }
    if (
      this.#state.currentJournalId !== null &&
      !journals.some(
        (journal) =>
          journal.id === this.#state.currentJournalId &&
          journal.sequence === this.#state.currentSequence,
      )
    )
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '目前產物指標與持久提交紀錄不一致，請保留所有版本。',
      );
    for (const journal of journals) await this.#recoverJournal(journal);
    journals = await this.#journals();
    for (const journal of journals) {
      if (!journal.resolution || journal.status === 'resolved') continue;
      if (journal.resolution.choice === 'keep-current') {
        await this.#finishResolution(journal);
        continue;
      }
      const child = journals.find(
        (item) => item.id === journal.resolution?.childId,
      );
      if (child?.status === 'committed' || child?.status === 'resolved')
        await this.#finishResolution(journal);
      else if (child === undefined || child.status === 'rolled-back') {
        delete journal.resolution;
        await this.#save(journal);
      }
    }
    journals = await this.#journals();
    const newest = journals
      .filter((journal) => journal.status === 'committed')
      .at(-1);
    if (newest && newest.sequence > this.#state.currentSequence) {
      this.#state.currentSequence = newest.sequence;
      this.#state.sequence = Math.max(this.#state.sequence, newest.sequence);
      this.#state.currentJournalId = newest.id;
      this.#state.acceptedDigest = newest.prepared?.digest ?? null;
      await this.#saveState();
    }
    const current = await this.#tree('dist');
    const head = journals.find(
      (journal) => journal.id === this.#state.currentJournalId,
    );
    if (
      head &&
      head.status === 'committed' &&
      !journals.some(
        (journal) =>
          journal.status === 'recovery-required' &&
          journal.sequence > head.sequence,
      ) &&
      current?.digest !== (this.#state.acceptedDigest ?? undefined)
    )
      await this.#conflict(head);
    return {
      recoveryState: (await this.#journals()).some(
        (journal) => journal.status === 'recovery-required',
      )
        ? 'recovery-required'
        : 'ready',
      currentDigest: current?.digest ?? null,
    };
  }
  async recover(): Promise<ArtifactRecoveryState> {
    return this.#locked(async () => {
      const state = await this.#recoverLocked();
      if (state.recoveryState === 'ready') {
        try {
          await this.#pruneLocked();
        } catch {
          /* 保留清理失敗的資料。 */
        }
      }
      return this.#recoverLocked();
    });
  }
  async #ready(): Promise<void> {
    if ((await this.#recoverLocked()).recoveryState !== 'ready')
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '請先完成未解的建置產物復原。',
      );
  }
  async #prepareJournalFiles(journal: ArtifactJournal): Promise<void> {
    await safeMkdir(this.#root, this.#private(journal.id, 'observed'));
    if (journal.base !== null)
      await copyArtifactTree(
        this.#root,
        'dist',
        this.#private(journal.id, 'base'),
        journal.base,
      );
    if (journal.prepared !== null) {
      await copyArtifactTree(
        this.#root,
        this.#candidate(journal),
        this.#private(journal.id, 'prepared'),
        journal.prepared,
      );
      await syncArtifactTree(
        this.#root,
        this.#candidate(journal),
        journal.prepared,
      );
    }
    await this.#fault('prepared-copies', journal.id);
    await atomicJson(this.#root, this.#private(journal.id, 'manifest.json'), {
      schemaVersion: 1,
      snapshotRevision: journal.result.snapshotRevision,
      manifest: journal.prepared,
      warnings: journal.result.warnings,
    });
    await this.#save(journal);
    await this.#fault('prepared-journal', journal.id);
  }
  async #switchPrepared(
    journal: ArtifactJournal,
    signal?: AbortSignal,
  ): Promise<void> {
    checkArtifactCancelled(signal);
    if (
      !(await this.#matches('dist', journal.base)) ||
      !(await this.#matches(this.#candidate(journal), journal.prepared))
    ) {
      await this.#conflict(journal);
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '產物在切換準備期間被外部修改，版本已保留。',
      );
    }
    journal.status = 'switching';
    await this.#save(journal);
    await this.#fault('promotion-intent', journal.id);
    // 進入短切換區段後完成提交或還原；取消不能留下半套目錄。
    if (journal.base !== null) {
      if ((await this.#tree(this.#private(journal.id, 'backup'))) !== null) {
        await this.#conflict(journal);
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '舊產物保留位置已被占用，不能覆蓋。',
        );
      }
      await this.#rename('dist', this.#private(journal.id, 'backup'));
      await this.#fault('old-moved', journal.id);
      if (
        !(await this.#matches(
          this.#private(journal.id, 'backup'),
          journal.base,
        ))
      ) {
        await this.#conflict(journal);
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '搬移舊產物時偵測到外部版本，已保留全部資料。',
        );
      }
    }
    try {
      await this.#fault('before-new-rename', journal.id);
      if ((await this.#tree('dist')) !== null)
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '切換位置出現外部產物，不能覆蓋。',
        );
      if (journal.prepared !== null)
        await this.#rename(this.#candidate(journal), 'dist');
    } catch {
      try {
        await this.#rollback(journal);
      } catch {
        await this.#conflict(journal);
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '新產物安裝與舊產物還原未完成，請保留資料並復原。',
        );
      }
      throw new ArtifactError(
        'ARTIFACT_INSTALL_FAILED',
        '新產物未安裝，已還原上一份完整產物。',
        503,
      );
    }
    await this.#fault('new-moved', journal.id);
    await this.#commitMarker(journal);
  }
  async #preparePromotionJournal(
    jobId: string,
    options: PromoteOptions,
  ): Promise<ArtifactJournal> {
    await this.#ready();
    const initialCurrent = await this.#tree('dist');
    checkArtifactCancelled(options.signal);
    if ((await this.#journals()).some((journal) => journal.id === jobId))
      throw new ArtifactError(
        'ARTIFACT_JOB_EXISTS',
        '此工作已有產物提交紀錄，不重複執行。',
      );
    const resource = `.alfred/builds/${jobId}/output`;
    const prepared = await scanArtifactTree(
      this.#root,
      resource,
      options.signal,
    );
    if (
      !prepared ||
      !prepared.entries.some(
        (entry) => entry.path === 'index.html' && entry.kind === 'file',
      )
    )
      throw new ArtifactError(
        'BUILD_OUTPUT_MISSING',
        '建置尚未產生完整首頁。',
        422,
      );
    const result = BuildResultSchema.safeParse({
      outputDirectory: 'dist',
      snapshotRevision: options.snapshotRevision,
      routeCount: options.routeCount,
      fileCount: prepared.fileCount,
      warnings: options.warnings ?? [],
    });
    if (!result.success)
      throw new ArtifactError(
        'INVALID_ARTIFACT_RESULT',
        '建置結果不符合共用契約。',
        422,
      );
    await safeMkdir(this.#root, this.#private(jobId, 'observed'));
    const rootDev = (await lstat(this.#root)).dev;
    if (
      (await lstat(await safePath(this.#root, resource))).dev !== rootDev ||
      (
        await lstat(
          await safePath(this.#root, this.#private(jobId, 'observed')),
        )
      ).dev !== rootDev
    )
      throw new ArtifactError(
        'ARTIFACT_FILESYSTEM_MISMATCH',
        'dist、候選及備份必須位於同一檔案系統。',
        503,
      );
    const base = await this.#tree('dist');
    if (
      base !== null &&
      (await lstat(await safePath(this.#root, 'dist'))).dev !== rootDev
    )
      throw new ArtifactError(
        'ARTIFACT_FILESYSTEM_MISMATCH',
        'dist、候選及備份必須位於同一檔案系統。',
        503,
      );
    if (base?.digest !== initialCurrent?.digest) {
      const head = (await this.#journals()).find(
        (item) => item.id === this.#state.currentJournalId,
      );
      if (head) await this.#conflict(head);
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '舊產物在準備期間被外部修改，請先比較復原版本。',
      );
    }
    this.#state.sequence++;
    await this.#saveState();
    const journal: ArtifactJournal = {
      schemaVersion: 1,
      id: jobId,
      sequence: this.#state.sequence,
      kind: 'build',
      createdAt: this.#now(),
      status: 'prepared',
      base,
      prepared,
      baseBuildId:
        this.#installedProof(base?.digest ?? null, await this.#journals())
          ?.jobId ?? null,
      preparedBuildId: jobId,
      result: result.data,
      artifactCommittedAt: null,
    };
    await this.#prepareJournalFiles(journal);
    return journal;
  }
  async #perform(
    journal: ArtifactJournal,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#prepareJournalFiles(journal);
    await this.#switchPrepared(journal, signal);
  }
  async #finishPrepared(
    journal: ArtifactJournal,
    signal?: AbortSignal,
  ): Promise<ArtifactProof> {
    this.#deferPreservation = true;
    try {
      let proof: ArtifactProof | null = null;
      let proofJournal = journal;
      let postCommitWarning = false;
      try {
        await this.#switchPrepared(journal, signal);
        proof = this.#proof(journal);
      } catch (error) {
        // 只有重新讀到 durable marker 才承認成功，不能相信尚未 flush 的記憶體旗標。
        const persisted = (await this.#journals()).find(
          (item) => item.id === journal.id,
        );
        if (persisted) {
          try {
            if (persisted.status === 'switching')
              await this.#recoverJournal(persisted);
          } catch {
            /* 未知／I/O 狀態仍由 journal 阻擋。 */
          }
          const recovered = (await this.#journals()).find(
            (item) => item.id === journal.id,
          );
          proof = recovered ? this.#proof(recovered) : null;
          if (recovered && proof) proofJournal = recovered;
        }
        if (proof === null) {
          if (error instanceof ArtifactError) throw error;
          throw new ArtifactError(
            'ARTIFACT_IO_FAILED',
            '產物提交遇到檔案系統錯誤，請檢查工作與復原狀態。',
            503,
          );
        }
        postCommitWarning = true;
      }
      if (proof === null)
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '產物提交缺少成功證據。',
        );
      if (postCommitWarning) {
        const persisted = proofJournal;
        persisted.result = {
          ...persisted.result,
          warnings: [
            ...persisted.result.warnings,
            {
              severity: 'warning',
              code: 'ARTIFACT_POST_COMMIT_WARNING',
              message:
                '產物已成功提交；後續狀態更新或清理遇到錯誤，保留資料供檢查。',
            },
          ],
        };
        try {
          await this.#save(persisted);
        } catch {
          /* 成功產物不因警告無法保存而失敗。 */
        }
        proof = this.#proof(persisted);
      }
      if (proof === null)
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '產物提交缺少成功證據。',
        );
      return proof;
    } finally {
      this.#deferPreservation = false;
    }
  }
  /** 大型複製、hash、fsync 在取得 repository writer lock 之前完成。 */
  async preparePromotion(
    jobId: string,
    options: PromoteOptions,
  ): Promise<PreparedPromotion> {
    this.#id(jobId);
    let ready: ((ticket: PreparedPromotion) => void) | undefined;
    let failed: ((error: unknown) => void) | undefined;
    const ticketReady = new Promise<PreparedPromotion>(
      (resolveReady, rejectReady) => {
        ready = resolveReady;
        failed = rejectReady;
      },
    );
    let finishHold: (() => void) | undefined;
    const hold = new Promise<void>((resolveHold) => {
      finishHold = resolveHold;
    });
    const lifetime = this.#locked(async () => {
      const journal = await this.#preparePromotionJournal(jobId, options);
      let used = false;
      let released = false;
      let promotion: Promise<ArtifactProof> | undefined;
      let releasePromise: Promise<void> | undefined;
      const ticket: PreparedPromotion = Object.freeze({
        jobId,
        digest: journal.prepared?.digest ?? '',
        promote: () => {
          if (released)
            return Promise.reject(
              new ArtifactError(
                'PROMOTION_TICKET_CLOSED',
                '產物提交票據已釋放。',
              ),
            );
          if (used)
            return Promise.reject(
              new ArtifactError(
                'PROMOTION_TICKET_USED',
                '產物提交票據只能使用一次。',
              ),
            );
          used = true;
          promotion = this.#finishPrepared(journal, options.signal);
          return promotion;
        },
        release: () => {
          if (releasePromise) return releasePromise;
          released = true;
          releasePromise = (async () => {
            try {
              await promotion;
            } catch {
              /* 提交錯誤由 promote 呼叫端處理，仍須釋放鎖。 */
            }
            finishHold?.();
            await lifetime;
          })();
          return releasePromise;
        },
      });
      ready?.(ticket);
      await hold;
      const persisted = (await this.#journals()).find(
        (item) => item.id === jobId,
      );
      if (persisted) {
        await this.#recoverJournal(persisted);
        if (persisted.status === 'recovery-required')
          await this.#conflict(persisted);
        if (persisted.status === 'committed') {
          try {
            await this.#pruneLocked();
          } catch {
            /* 已提交產物不因維護失敗回滾。 */
          }
        }
      }
    }, options.signal);
    void lifetime.catch((error: unknown) => {
      failed?.(error);
    });
    return ticketReady;
  }
  /** CLI 相容入口；正式 orchestrator 在 final input CAS 前先取 prepare ticket。 */
  async promote(
    jobId: string,
    options: PromoteOptions,
  ): Promise<ArtifactProof> {
    const ticket = await this.preparePromotion(jobId, options);
    try {
      return await ticket.promote();
    } finally {
      await ticket.release();
    }
  }
  #proof(journal: ArtifactJournal): ArtifactProof | null {
    if (
      journal.kind !== 'build' ||
      journal.artifactCommittedAt === null ||
      journal.prepared === null
    )
      return null;
    return {
      jobId: journal.id,
      digest: journal.prepared.digest,
      manifest: journal.prepared,
      result: journal.result,
      artifactCommitted: true,
      committedAt: journal.artifactCommittedAt,
    };
  }
  /** 只沿已提交 head 的持久來源連結，不按相同 bytes 搜尋其他工作。 */
  #installedProof(
    digest: string | null,
    journals: readonly ArtifactJournal[],
  ): ArtifactProof | null {
    if (digest === null || digest !== this.#state.acceptedDigest) return null;
    const head = journals.find(
      (journal) => journal.id === this.#state.currentJournalId,
    );
    if (
      !head ||
      !['committed', 'resolved'].includes(head.status) ||
      head.sequence !== this.#state.currentSequence ||
      head.prepared?.digest !== digest
    )
      return null;
    const buildId = head.kind === 'build' ? head.id : head.preparedBuildId;
    if (!buildId) return null;
    const origin = journals.find((journal) => journal.id === buildId);
    if (!origin || origin.sequence > head.sequence) return null;
    const proof = this.#proof(origin);
    return proof?.digest === digest ? proof : null;
  }
  /** 真正目前的 dist；同 gate 內驗完整樹及來源，沒有任何歷史 Job 推測。 */
  async current(): Promise<CurrentArtifact> {
    return this.withStateGate(async (state) => {
      const proof =
        state.recoveryState === 'ready'
          ? this.#installedProof(state.currentDigest, await this.#journals())
          : null;
      return CurrentArtifactSchema.parse({
        recoveryState: state.recoveryState,
        current:
          state.currentDigest === null
            ? null
            : {
                digest: state.currentDigest,
                build: proof
                  ? {
                      jobId: proof.jobId,
                      committedAt: proof.committedAt,
                      result: proof.result,
                    }
                  : null,
              },
      });
    });
  }
  /** 同一 gate 內確認目前來源並擷取完整副本；後續上傳不佔用 artifact lock。 */
  async captureCurrent(
    options: CaptureCurrentOptions,
  ): Promise<CapturedArtifact> {
    const { deploymentId, expectedJobId, expectedSnapshotRevision, signal } =
      options;
    if (
      !UuidSchema.safeParse(deploymentId).success ||
      !UuidSchema.safeParse(expectedJobId).success ||
      !/^[a-f0-9]{64}$/.test(expectedSnapshotRevision)
    )
      throw new ArtifactError(
        'ARTIFACT_CAPTURE_ARGUMENT_INVALID',
        '部署識別或預期建置來源不符合規則。',
        400,
      );
    return this.withStateGate(
      async (state) => {
        checkArtifactCancelled(signal);
        if (state.recoveryState !== 'ready' || state.currentDigest === null)
          throw new ArtifactError(
            'ARTIFACT_CAPTURE_UNAVAILABLE',
            '目前沒有可部署的完整網站，請先完成建置及必要復原。',
          );
        const proof = this.#installedProof(
          state.currentDigest,
          await this.#journals(),
        );
        if (!proof)
          throw new ArtifactError(
            'ARTIFACT_CAPTURE_UNPROVEN',
            '目前網站缺少正式建置來源證據，請重新建置。',
          );
        if (
          proof.jobId !== expectedJobId ||
          proof.result.snapshotRevision !== expectedSnapshotRevision
        )
          throw new ArtifactError(
            'ARTIFACT_CAPTURE_REPLACED',
            '目前網站已由另一輪建置替換，請重新執行本次部署。',
          );
        const resource = `.alfred/deployments/${deploymentId}/source`;
        await copyArtifactTree(
          this.#root,
          'dist',
          resource,
          proof.manifest,
          signal,
        );
        const manifest = await scanArtifactTree(this.#root, resource, signal);
        if (!manifest || manifest.digest !== proof.digest)
          throw new ArtifactError(
            'BUILD_OUTPUT_CHANGED',
            '部署副本在核對期間改變，請重新建置及部署。',
          );
        return { resource, manifest, proof };
      },
      signal === undefined ? {} : { signal: signal },
    );
  }
  async committedProof(jobId: string): Promise<ArtifactProof | null> {
    this.#id(jobId);
    return this.#locked(async () => {
      await this.#recoverLocked();
      const journal = (await this.#journals()).find(
        (item) => item.id === jobId,
      );
      return journal ? this.#proof(journal) : null;
    });
  }
  async retainedBuildIds(): Promise<readonly string[]> {
    return this.#locked(async () => {
      await this.#recoverLocked();
      return (await this.#journals())
        .filter(
          (journal) =>
            journal.kind === 'build' &&
            (journal.status === 'recovery-required' ||
              (journal.resolution !== undefined &&
                journal.status !== 'resolved')),
        )
        .map((journal) => journal.id);
    });
  }
  /** 失敗工作清理入口；未解／已提交版本及未知保留資料一律不刪。 */
  async discardUncommitted(jobId: string): Promise<boolean> {
    this.#id(jobId);
    return this.#locked(async () => {
      await this.#recoverLocked();
      const journal = (await this.#journals()).find(
        (item) => item.id === jobId,
      );
      if (
        journal &&
        (journal.status !== 'rolled-back' ||
          journal.resolution ||
          journal.artifactCommittedAt !== null)
      )
        return false;
      const directory = `.alfred/artifacts/${jobId}`;
      let names: string[];
      try {
        names = await readdir(await safePath(this.#root, directory));
      } catch (error) {
        if (isMissing(error)) return true;
        throw error;
      }
      if (
        names.some(
          (name) =>
            ![
              'base',
              'prepared',
              'backup',
              'observed',
              'manifest.json',
              'journal.json',
            ].includes(name) &&
            !/^(?:manifest|journal)\.json\.[a-f0-9-]+\.tmp$/.test(name),
        )
      )
        return false;
      if (
        (
          await readdir(
            await safePath(this.#root, `${directory}/observed`),
          ).catch((error: unknown) => {
            if (isMissing(error)) return [];
            throw error;
          })
        ).length > 0
      )
        return false;
      if (journal) {
        if (journal.temporaryDiscarded) {
          for (const [folder, expected] of [
            ['base', journal.base],
            ['prepared', journal.prepared],
          ] as const) {
            const actual = await this.#tree(this.#private(jobId, folder));
            if (actual && actual.digest !== expected?.digest) {
              await this.#conflict(journal);
              return false;
            }
            await rm(await safePath(this.#root, this.#private(jobId, folder)), {
              recursive: true,
              force: true,
            });
          }
          await syncDirectory(await safePath(this.#root, directory));
          return true;
        }
        if (
          (await this.#tree(this.#private(jobId, 'backup'))) !== null ||
          !(await this.#matches(this.#private(jobId, 'base'), journal.base)) ||
          !(await this.#matches(
            this.#private(jobId, 'prepared'),
            journal.prepared,
          ))
        ) {
          await this.#conflict(journal);
          return false;
        }
        journal.temporaryDiscarded = true;
        await this.#save(journal);
        for (const folder of ['base', 'prepared'])
          await rm(await safePath(this.#root, this.#private(jobId, folder)), {
            recursive: true,
            force: true,
          });
        await syncDirectory(await safePath(this.#root, directory));
      } else {
        // journal 前中止的私有副本沒有正式副作用；整個目錄仍須符合固定結構。
        if (names.includes('backup')) return false;
        await rm(await safePath(this.#root, directory), { recursive: true });
        await syncDirectory(await safePath(this.#root, '.alfred/artifacts'));
      }
      return true;
    });
  }
  /** 鎖順序固定artifact→repository；callback不得再次進入artifact／job completion。 */
  async withStateGate<T>(
    fn: (state: ArtifactRecoveryState) => Promise<T>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.#locked(
      async () => fn(await this.#recoverLocked()),
      options.signal,
    );
  }
  async withPreviewGate<T>(
    fn: (artifact: { readonly digest: string }) => Promise<T>,
    options: {
      readonly signal?: AbortSignal;
      readonly requireCommitted?: boolean;
    } = {},
  ): Promise<T> {
    return this.#locked(async () => {
      const cached = this.#previewValidation;
      this.#previewValidation = undefined;
      if (
        options.requireCommitted !== false &&
        cached !== undefined &&
        (await previewFingerprintMatches(this.#root, cached.fingerprint))
      ) {
        this.#previewValidation = cached;
        return fn({ digest: cached.digest });
      }
      const fingerprint =
        options.requireCommitted === false
          ? undefined
          : await capturePreviewFingerprint(this.#root);
      await this.#ready();
      const current = await this.#tree('dist');
      if (
        !current ||
        !current.entries.some(
          (entry) => entry.path === 'index.html' && entry.kind === 'file',
        )
      )
        throw new ArtifactError(
          'DIST_NOT_AVAILABLE',
          '尚無可預覽的完整靜態產物。',
          503,
        );
      if (
        options.requireCommitted !== false &&
        !(await this.#journals()).some(
          (journal) =>
            journal.prepared?.digest === current.digest &&
            (journal.status === 'committed' ||
              journal.artifactCommittedAt !== null),
        )
      )
        throw new ArtifactError(
          'DIST_NOT_VERIFIED',
          '目前產物尚無成功提交證據，請先完成正式建置。',
          503,
        );
      // Cache only the exact tree and journal metadata present before and after
      // full recovery/hash/proof validation. The exclusive lease still covers fn.
      if (
        fingerprint !== undefined &&
        (await previewFingerprintMatches(this.#root, fingerprint))
      )
        this.#previewValidation = { fingerprint, digest: current.digest };
      return fn({ digest: current.digest });
    }, options.signal);
  }
  async #pruneLocked(): Promise<void> {
    // 只清大目錄；journal／小型成功 proof 永遠保留，含 current/base/prepared 的來源連結。
    const journals = await this.#journals();
    const latest = journals
      .filter((journal) => journal.status === 'committed')
      .at(-1);
    for (const journal of journals) {
      if (
        journal.id === latest?.id ||
        !['committed', 'resolved'].includes(journal.status) ||
        (journal.resolution !== undefined && journal.status !== 'resolved')
      )
        continue;
      for (const folder of ['base', 'backup', 'prepared']) {
        const resource = this.#private(journal.id, folder);
        const actual = await this.#tree(resource);
        const expected =
          folder === 'prepared' ? journal.prepared : journal.base;
        if (actual === null) continue;
        if (actual.digest !== expected?.digest) {
          if (journal.status !== 'resolved') {
            await this.#conflict(journal);
            continue;
          }
          // 已明確處理的額外版本仍保留在 observed；只移除重複的舊 backup 位置。
          const preserved = await this.#preserve(journal, resource);
          if (
            preserved?.manifest.digest !== actual.digest ||
            (await this.#tree(resource))?.digest !== actual.digest
          )
            throw new ArtifactError(
              'BUILD_RECOVERY_REQUIRED',
              '舊產物版本在清理期間改變，已保留資料。',
            );
        }
        await rm(await safePath(this.#root, resource), { recursive: true });
        await syncDirectory(
          dirname(
            await safePath(
              this.#root,
              this.#private(journal.id, 'journal.json'),
            ),
          ),
        );
      }
    }
  }
  async #find(id: string): Promise<ArtifactJournal> {
    this.#id(id);
    const journal = (await this.#journals()).find((item) => item.id === id);
    if (!journal)
      throw new ArtifactError(
        'RECOVERY_NOT_FOUND',
        '建置復原紀錄不存在。',
        404,
      );
    return journal;
  }
  async listRecoveries(): Promise<readonly ArtifactRecoverySummary[]> {
    return this.#locked(async () => {
      await this.#recoverLocked();
      return (await this.#journals())
        .filter(
          (journal) =>
            journal.status === 'recovery-required' ||
            journal.status === 'resolved' ||
            (journal.id === this.#state.currentJournalId &&
              journal.status === 'committed'),
        )
        .map((journal) => ({
          id: journal.id,
          kind: 'build',
          status:
            journal.status === 'resolved'
              ? 'resolved'
              : journal.status === 'recovery-required'
                ? 'pending'
                : 'available',
          createdAt: journal.createdAt,
        }));
    });
  }
  async #detail(journal: ArtifactJournal): Promise<Detail> {
    const baseTree = await this.#tree(this.#private(journal.id, 'base'));
    const preparedTree = await this.#tree(
      this.#private(journal.id, 'prepared'),
    );
    const base = baseTree
      ? { manifest: baseTree, resource: this.#private(journal.id, 'base') }
      : null;
    const prepared = preparedTree
      ? {
          manifest: preparedTree,
          resource: this.#private(journal.id, 'prepared'),
        }
      : null;
    if (
      (base && base.manifest.digest !== journal.base?.digest) ||
      (prepared && prepared.manifest.digest !== journal.prepared?.digest)
    )
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '建置比較版本已損壞，請保留資料。',
      );
    const current = await this.#preserve(journal, 'dist');
    await this.#preserve(journal, this.#private(journal.id, 'backup'));
    await this.#preserve(journal, this.#candidate(journal));
    const observed: TreeVersion[] = [];
    for (const entry of await readdir(
      await safePath(this.#root, this.#private(journal.id, 'observed')),
      { withFileTypes: true },
    )) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^[a-f0-9]{64}$/.test(entry.name)
      )
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '保留產物目錄含無法判讀的項目。',
        );
      const resource = this.#private(journal.id, `observed/${entry.name}`);
      const manifest = await this.#tree(resource);
      if (!manifest || manifest.digest !== entry.name)
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '保留產物版本的雜湊不一致。',
        );
      if (
        ![
          base?.manifest.digest,
          current?.manifest.digest,
          prepared?.manifest.digest,
        ].includes(manifest.digest)
      )
        observed.push({ manifest, resource });
    }
    observed.sort((a, b) => (a.manifest.digest < b.manifest.digest ? -1 : 1));
    const treeVersion = (tree: TreeVersion | null): Version =>
      tree === null
        ? emptyVersion()
        : {
            revision: tree.manifest.digest,
            text: JSON.stringify(tree.manifest),
            binary: null,
          };
    const resources: RecoveryDetail['resources'] = [
      {
        resourceKey: 'dist',
        base: treeVersion(base),
        current: treeVersion(current),
        prepared: treeVersion(prepared),
        preserved: observed.map(treeVersion),
      },
    ];
    const downloads = new Map<string, Download>();
    const paths = new Set(
      [base, current, prepared, ...observed].flatMap(
        (tree) =>
          tree?.manifest.entries
            .filter((entry) => entry.kind === 'file')
            .map((entry) => entry.path) ?? [],
      ),
    );
    for (const path of [...paths].sort()) {
      const version = (tree: TreeVersion | null): Version => {
        const file = tree?.manifest.entries.find(
          (entry) => entry.path === path,
        );
        if (!tree || !file || file.kind !== 'file') return emptyVersion();
        const id = fileId(`${journal.id}:${tree.manifest.digest}:${path}`);
        downloads.set(id, {
          path: `${tree.resource}/${path}`,
          byteSize: file.byteSize,
          sha256: file.sha256,
          fileName: path.split('/').at(-1) ?? 'artifact',
        });
        return {
          revision: file.sha256,
          text: null,
          binary: {
            fileId: id,
            mimeType: 'application/octet-stream',
            byteSize: file.byteSize,
            sha256: file.sha256,
            downloadUrl: `/api/v1/recoveries/${journal.id}/files/${id}`,
          },
        };
      };
      const baseVersion = version(base),
        currentVersion = version(current),
        preparedVersion = version(prepared);
      const seen = new Set([
        baseVersion.revision,
        currentVersion.revision,
        preparedVersion.revision,
      ]);
      resources.push({
        resourceKey: `dist/${path}`,
        base: baseVersion,
        current: currentVersion,
        prepared: preparedVersion,
        preserved: observed.map(version).filter((entry) => {
          if (entry.revision === null || seen.has(entry.revision)) return false;
          seen.add(entry.revision);
          return true;
        }),
      });
    }
    if ((await this.#tree('dist'))?.digest !== current?.manifest.digest)
      throw new ArtifactError(
        'EXTERNAL_CHANGE',
        '產物在復原比較期間被外部修改，請重新載入。',
      );
    const value: RecoveryDetail = {
      id: journal.id,
      kind: 'build',
      status:
        journal.status === 'resolved'
          ? 'resolved'
          : journal.status === 'recovery-required'
            ? 'pending'
            : 'available',
      createdAt: journal.createdAt,
      resources,
      choices: ['keep-current', 'restore-backup', 'apply-prepared'],
    };
    return {
      value,
      etag: `"${stableHash([value, journal.status, journal.resolution ?? null])}"`,
      downloads,
      currentManifest: current?.manifest ?? null,
    };
  }
  async recovery(
    id: string,
  ): Promise<{ readonly value: RecoveryDetail; readonly etag: string }> {
    return this.#locked(async () => {
      await this.#recoverLocked();
      const detail = await this.#detail(await this.#find(id));
      return { value: detail.value, etag: detail.etag };
    });
  }
  async recoveryFile(
    id: string,
    downloadId: string,
    range?: { readonly start: number; readonly end?: number },
  ): Promise<{
    readonly stream: ReturnType<typeof createReadStream>;
    readonly byteSize: number;
    readonly mimeType: 'application/octet-stream';
    readonly sha256: string;
    readonly fileName: string;
  }> {
    return this.#locked(async () => {
      await this.#recoverLocked();
      if (!UuidSchema.safeParse(downloadId).success)
        throw new ArtifactError(
          'RECOVERY_FILE_NOT_FOUND',
          '復原檔案不存在。',
          404,
        );
      const detail = await this.#detail(await this.#find(id));
      const download = detail.downloads.get(downloadId);
      if (!download)
        throw new ArtifactError(
          'RECOVERY_FILE_NOT_FOUND',
          '復原檔案不存在。',
          404,
        );
      if (
        range &&
        (!Number.isSafeInteger(range.start) ||
          range.start < 0 ||
          range.start >= download.byteSize ||
          (range.end !== undefined &&
            (!Number.isSafeInteger(range.end) ||
              range.end < range.start ||
              range.end >= download.byteSize)))
      )
        throw new ArtifactError('INVALID_RANGE', '下載範圍超出復原檔案。', 416);
      const handle = await open(
        await safePath(this.#root, download.path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      return {
        stream: handle.createReadStream(
          range
            ? {
                start: range.start,
                ...(range.end === undefined ? {} : { end: range.end }),
              }
            : {},
        ),
        byteSize: download.byteSize,
        mimeType: 'application/octet-stream',
        sha256: download.sha256,
        fileName: download.fileName,
      };
    });
  }
  #match(ifMatch: string | undefined, current: string): void {
    if (ifMatch === undefined)
      throw new ArtifactError(
        'PRECONDITION_REQUIRED',
        '請附上最新復原版本 If-Match。',
        428,
        current,
      );
    if (!/^"[a-f0-9]{64}"$/.test(ifMatch))
      throw new ArtifactError(
        'INVALID_IF_MATCH',
        'If-Match 必須是單一精確強版本。',
        400,
        current,
      );
    if (ifMatch !== current)
      throw new ArtifactError(
        'PRECONDITION_FAILED',
        '產物復原來源已更新，請重新比較。',
        412,
        current,
      );
  }
  async resolveRecovery(
    id: string,
    resolution: RecoveryResolution,
    ifMatch: string | undefined,
  ): Promise<ArtifactRecoveryResult> {
    return this.#locked(async () => {
      await this.#recoverLocked();
      const parsed = RecoveryResolutionSchema.safeParse(resolution);
      if (
        !parsed.success ||
        !['keep-current', 'restore-backup', 'apply-prepared'].includes(
          parsed.data.choice,
        )
      )
        throw new ArtifactError(
          'INVALID_RECOVERY_RESOLUTION',
          '建置復原決議格式不正確。',
          422,
        );
      const journal = await this.#find(id);
      if (journal.status === 'resolved')
        throw new ArtifactError(
          'RECOVERY_ALREADY_RESOLVED',
          '此建置復原紀錄已處理。',
        );
      if (
        journal.status !== 'recovery-required' &&
        !(
          journal.status === 'committed' &&
          journal.id === this.#state.currentJournalId
        )
      )
        throw new ArtifactError(
          'RECOVERY_NOT_PENDING',
          '此建置紀錄目前不可執行復原。',
        );
      if (journal.resolution)
        throw new ArtifactError(
          'RESOLUTION_IN_PROGRESS',
          '此復原決議仍在處理，請先完成相關復原。',
        );
      const detail = await this.#detail(journal);
      this.#match(ifMatch, detail.etag);
      const revisions = parsed.data.revisions;
      if (
        revisions.length !== detail.value.resources.length ||
        detail.value.resources.some(
          (resource) =>
            !revisions.some(
              (revision) => revision.resourceKey === resource.resourceKey,
            ),
        )
      )
        throw new ArtifactError(
          'INCOMPLETE_RECOVERY_REVISIONS',
          '必須提供明列的全部產物版本。',
          422,
        );
      for (const resource of detail.value.resources)
        if (
          revisions.find(
            (revision) => revision.resourceKey === resource.resourceKey,
          )?.revision !== resource.current.revision
        )
          throw new ArtifactError(
            'PRECONDITION_FAILED',
            '產物復原來源已更新，請重新比較。',
            412,
            detail.etag,
          );
      const choice = parsed.data.choice as
        'keep-current' | 'restore-backup' | 'apply-prepared';
      const childId = choice === 'keep-current' ? undefined : randomUUID();
      const treeResource = detail.value.resources.find(
        (resource) => resource.resourceKey === 'dist',
      );
      if (!treeResource)
        throw new ArtifactError(
          'BUILD_RECOVERY_REQUIRED',
          '產物比較缺少完整樹版本。',
        );
      journal.resolution = {
        choice,
        expectedDigest: treeResource.current.revision,
        revisions,
        ...(childId ? { childId } : {}),
      };
      await this.#save(journal);
      await this.#fault('resolution-intent', id);
      if (choice === 'keep-current') await this.#finishResolution(journal);
      else {
        const desired =
          choice === 'apply-prepared' ? journal.prepared : journal.base;
        const source = this.#private(
          id,
          choice === 'apply-prepared' ? 'prepared' : 'base',
        );
        if (!(await this.#matches(source, desired)))
          throw new ArtifactError(
            'BUILD_RECOVERY_REQUIRED',
            '所選產物版本已損壞，請保留資料。',
          );
        if (!childId)
          throw new ArtifactError(
            'INVALID_RECOVERY_RESOLUTION',
            '復原決議缺少交易識別。',
            500,
          );
        const child = childId;
        await safeMkdir(this.#root, this.#private(child, 'observed'));
        if (desired !== null)
          await copyArtifactTree(
            this.#root,
            source,
            this.#private(child, 'candidate'),
            desired,
          );
        if (
          (await this.#tree('dist'))?.digest !==
          (journal.resolution.expectedDigest ?? undefined)
        )
          throw new ArtifactError(
            'PRECONDITION_FAILED',
            '產物在復原準備期間已更新。',
            412,
            detail.etag,
          );
        this.#state.sequence++;
        await this.#saveState();
        const transaction: ArtifactJournal = {
          schemaVersion: 1,
          id: child,
          sequence: this.#state.sequence,
          kind: 'resolution',
          createdAt: this.#now(),
          status: 'prepared',
          base: detail.currentManifest,
          prepared: desired,
          baseBuildId:
            this.#installedProof(
              detail.currentManifest?.digest ?? null,
              await this.#journals(),
            )?.jobId ?? null,
          preparedBuildId:
            choice === 'restore-backup'
              ? (journal.baseBuildId ?? null)
              : journal.kind === 'build'
                ? journal.id
                : (journal.preparedBuildId ?? null),
          result: { ...journal.result, fileCount: desired?.fileCount ?? 0 },
          artifactCommittedAt: null,
        };
        await this.#perform(transaction);
        await this.#fault('resolution-committed', id);
        await this.#finishResolution(journal);
      }
      if ((await this.#find(id)).status !== 'resolved')
        throw new ArtifactError(
          'PRECONDITION_FAILED',
          '產物在復原決議期間已變更，請重新比較。',
          412,
        );
      return { id, status: 'resolved', choice };
    });
  }
}
