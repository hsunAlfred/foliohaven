import { constants, createReadStream } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  ArticleIdSchema,
  CONTENT_LIMITS,
  RecoveryResolutionSchema,
  UuidSchema,
} from '@foliohaven/core';
import type {
  RecoveryDetail,
  RecoveryResolution,
  Workspace,
} from '@foliohaven/core';
import { loadContent } from '@foliohaven/core/node';
import type { LoadContentOptions } from '@foliohaven/core/node';
import { acquireRepositoryLock } from './lock.js';
import {
  privateResource,
  atomicJson,
  copyDurable,
  durableBytes,
  hashFile,
  isMissing,
  readJson,
  readOptional,
  record,
  RepositoryError,
  safeMkdir,
  safePath,
  sha256,
  stableHash,
  syncDirectory,
} from './io.js';
import type {
  CommitRequest,
  CommittedJobResult,
  CommitResult,
  FaultPhase,
  OperationReceipt,
  PreparedBinary,
  RawResource,
  ReadSession,
  RecoveryResolutionResult,
  RecoveryResult,
  RepositoryOptions,
  ScanInputs,
  WorkspaceResult,
} from './types.js';
import { mimeType, newEntry, parseJournal } from '../transactions/journal.js';
import type { Journal, JournalEntry } from '../transactions/journal.js';
import { mapConcurrent } from '../runtime/parallel.js';
import { FileRevisionCache } from './revision-cache.js';

interface State {
  schemaVersion: 1;
  editMode: 'studio' | 'ide';
  stateVersion: number;
  generation: number;
}
const revisionPattern = /^[a-f0-9]{64}$/;
const binaryPattern =
  /\/original\.(?:jpe?g|png|webp|avif|svg|ico|mp4|mov|webm)$/;
const lengthBytes = (length: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(length));
  return bytes;
};
export function etagForResources(
  resources: readonly {
    readonly resourceKey: string;
    readonly bytes: Uint8Array | null;
  }[],
): string {
  if (
    resources.length === 0 ||
    new Set(resources.map((item) => item.resourceKey)).size !== resources.length
  )
    throw new RepositoryError(
      'INVALID_RESOURCE_KEYS',
      '資源集合不可為空或重複。',
      400,
    );
  const hash = createHash('sha256');
  for (const resource of [...resources].sort((a, b) =>
    a.resourceKey < b.resourceKey ? -1 : a.resourceKey > b.resourceKey ? 1 : 0,
  )) {
    const key = Buffer.from(resource.resourceKey);
    hash.update(lengthBytes(key.length)).update(key);
    if (resource.bytes === null) hash.update(Buffer.from([0]));
    else
      hash
        .update(Buffer.from([1]))
        .update(lengthBytes(resource.bytes.byteLength))
        .update(resource.bytes);
  }
  return `"${hash.digest('hex')}"`;
}
function versionFileId(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** 所有來源寫入均經同一 kernel lock 與可復原多檔 journal。 */
export class FileRepository {
  readonly #root: string;
  readonly #options: RepositoryOptions;
  readonly #pageIds: ReadonlySet<string>;
  #queue: Promise<void> = Promise.resolve();
  readonly #digests = new FileRevisionCache<string | null>();
  readonly #etags = new FileRevisionCache<{
    readonly etag: string;
    readonly revisions: readonly (readonly [string, string | null])[];
  }>();
  #state: State = {
    schemaVersion: 1,
    editMode: 'studio',
    stateVersion: 0,
    generation: 0,
  };

  constructor(options: RepositoryOptions) {
    this.#root = resolve(options.repositoryRoot);
    this.#options = options;
    this.#pageIds = new Set([
      ...(options.registeredPageIds ?? []),
      ...Object.keys(options.pageSchemas ?? {}),
    ]);
  }
  #now(): string {
    return (this.#options.clock?.() ?? new Date()).toISOString();
  }
  #key(resource: string): string {
    const article =
      /^content\/articles\/([^/]+)\/(content\.html|meta\.json)$/.exec(resource);
    const page = /^content\/pages\/([^/]+)\.json$/.exec(resource);
    const media =
      /^media\/source\/([^/]+)\/(meta\.json|original\.(?:jpe?g|png|webp|avif|svg|ico|mp4|mov|webm))$/.exec(
        resource,
      );
    if (
      [
        'content/site.json',
        'content/categories.json',
        'content/tags.json',
      ].includes(resource) ||
      (article?.[1] && ArticleIdSchema.safeParse(article[1]).success) ||
      (page?.[1] &&
        this.#pageIds.has(page[1]) &&
        ArticleIdSchema.safeParse(page[1]).success) ||
      (media?.[1] && UuidSchema.safeParse(media[1]).success)
    )
      return resource;
    throw new RepositoryError(
      'INVALID_RESOURCE_KEY',
      '資源不在可操作範圍。',
      400,
    );
  }
  async #path(key: string): Promise<string> {
    return safePath(this.#root, this.#key(key));
  }
  #transactionResource(id: string, suffix = 'journal.json'): string {
    if (
      !UuidSchema.safeParse(id).success ||
      !/^(?:journal\.json|(?:base|prepared|displaced|observed|stage)\/\d+(?:\.[a-f0-9]{64})?)$/.test(
        suffix,
      )
    )
      throw new RepositoryError('INVALID_RECOVERY_ID', '復原識別不合法。', 400);
    return privateResource(this.#root, `transactions/${id}/${suffix}`);
  }
  async #journalPath(id: string, suffix?: string): Promise<string> {
    return safePath(this.#root, this.#transactionResource(id, suffix));
  }
  async #writeJournal(journal: Journal): Promise<void> {
    await atomicJson(
      this.#root,
      this.#transactionResource(journal.id),
      journal,
    );
  }
  async #fault(
    phase: FaultPhase,
    transactionId: string,
    resourceKey?: string,
  ): Promise<void> {
    await this.#options.fault?.({
      phase,
      transactionId,
      ...(resourceKey ? { resourceKey } : {}),
    });
  }
  async #loadState(): Promise<void> {
    let value: unknown;
    try {
      value = await readJson(
        this.#root,
        privateResource(this.#root, 'workspace-state.json'),
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.#saveState();
      return;
    }
    if (
      !record(value) ||
      value.schemaVersion !== 1 ||
      !['studio', 'ide'].includes(String(value.editMode)) ||
      !Number.isSafeInteger(value.stateVersion) ||
      Number(value.stateVersion) < 0 ||
      !Number.isSafeInteger(value.generation) ||
      Number(value.generation) < 0
    )
      throw new RepositoryError(
        'RECOVERY_REQUIRED',
        '工作區狀態無法判讀，請保留私有資料並檢查。',
      );
    this.#state = value as unknown as State;
  }
  async #saveState(): Promise<void> {
    await atomicJson(
      this.#root,
      privateResource(this.#root, 'workspace-state.json'),
      this.#state,
    );
  }
  async #journals(): Promise<Journal[]> {
    const entries = await readdir(
      await safePath(this.#root, privateResource(this.#root, 'transactions')),
      { withFileTypes: true },
    );
    const journals = await mapConcurrent(entries, async (entry) => {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !UuidSchema.safeParse(entry.name).success
      )
        throw new RepositoryError(
          'RECOVERY_REQUIRED',
          '交易目錄包含無法判讀的項目。',
        );
      let value: unknown;
      try {
        value = await readJson(
          this.#root,
          this.#transactionResource(entry.name),
        );
      } catch (error) {
        if (isMissing(error)) {
          // journal 前中止只有私有候選，正式來源尚未修改；保留供人工檢查。
          return null;
        }
        throw new RepositoryError(
          'RECOVERY_REQUIRED',
          '交易紀錄無法讀取，請保留復原資料。',
        );
      }
      const journal = parseJournal(value);
      if (journal.id !== entry.name)
        throw new RepositoryError('RECOVERY_REQUIRED', '交易識別與目錄不符。');
      for (const item of journal.entries) this.#key(item.resourceKey);
      if (journal.trash) this.#trashDirectory(journal.trash);
      if (journal.directoryReservation) {
        const key = journal.directoryReservation.resourceKey;
        const article = /^content\/articles\/([^/]+)$/.exec(key);
        const media = /^media\/source\/([^/]+)$/.exec(key);
        if (
          journal.kind !== 'restore' ||
          !(
            (article?.[1] && ArticleIdSchema.safeParse(article[1]).success) ||
            (media?.[1] && UuidSchema.safeParse(media[1]).success)
          ) ||
          journal.entries.some(
            (item) => !item.resourceKey.startsWith(`${key}/`),
          )
        )
          throw new RepositoryError(
            'RECOVERY_REQUIRED',
            '復原目錄不在受控資源範圍。',
          );
      }
      return journal;
    });
    return journals
      .filter((journal): journal is Journal => journal !== null)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }
  async #locked<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const preceding = this.#queue;
    let releaseQueue: (() => void) | undefined;
    this.#queue = new Promise<void>((resolveQueue) => {
      releaseQueue = resolveQueue;
    });
    await preceding;
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      const rootStat = await lstat(this.#root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new RepositoryError(
          'INVALID_REPOSITORY_ROOT',
          '工作區必須是一般目錄。',
          500,
        );
      releaseLock = await acquireRepositoryLock(
        this.#root,
        this.#options.lockTimeoutMs ?? 10_000,
        signal,
      );
      await safeMkdir(this.#root, privateResource(this.#root, 'transactions'));
      await safeMkdir(this.#root, privateResource(this.#root, 'staging'));
      await this.#loadState();
      for (const journal of await this.#journals())
        if (journal.status === 'prepared' || journal.status === 'installing')
          await this.#recoverJournal(journal);
      for (const journal of await this.#journals())
        if (journal.resolution && journal.status !== 'resolved')
          await this.#recoverResolution(journal);
      return await fn();
    } finally {
      try {
        await releaseLock?.();
      } finally {
        releaseQueue?.();
      }
    }
  }
  #limit(key: string): number {
    return key.endsWith('/content.html')
      ? CONTENT_LIMITS.articleHtmlBytes
      : key === 'content/site.json'
        ? CONTENT_LIMITS.siteBytes
        : ['content/categories.json', 'content/tags.json'].includes(key)
          ? CONTENT_LIMITS.taxonomyBytes
          : key.startsWith('content/pages/')
            ? CONTENT_LIMITS.pageBytes
            : key.startsWith('media/source/')
              ? key.endsWith('/meta.json')
                ? CONTENT_LIMITS.mediaMetaBytes
                : /\.(?:mp4|mov|webm)$/.test(key)
                  ? CONTENT_LIMITS.videoSourceBytes
                  : CONTENT_LIMITS.imageSourceBytes
              : CONTENT_LIMITS.articleMetaBytes;
  }
  async #read(key: string): Promise<RawResource | null> {
    const bytes = await readOptional(await this.#path(key), this.#limit(key));
    return bytes === null ? null : { bytes, revision: sha256(bytes) };
  }
  async #etag(
    keys: readonly string[],
    remember?: (key: string, revision: string | null) => void,
  ): Promise<string> {
    if (keys.length === 0 || new Set(keys).size !== keys.length)
      throw new RepositoryError(
        'INVALID_RESOURCE_KEYS',
        '資源集合不可為空或重複。',
        400,
      );
    return this.#etagPaths(
      await Promise.all(
        keys.map(async (key) => ({
          resourceKey: key,
          path: await this.#path(key),
        })),
      ),
      remember,
    );
  }
  async #etagPaths(
    resources: readonly { resourceKey: string; path: string }[],
    remember?: (key: string, revision: string | null) => void,
  ): Promise<string> {
    if (!this.#options.reuseFileDigests)
      return this.#uncachedEtagPaths(resources, remember);
    const sorted = [...resources].sort((a, b) =>
      a.resourceKey < b.resourceKey
        ? -1
        : a.resourceKey > b.resourceKey
          ? 1
          : 0,
    );
    const result = await this.#etags.read(
      sorted.map((resource) => resource.path),
      async () => {
        const revisions: (readonly [string, string | null])[] = [];
        const etag = await this.#uncachedEtagPaths(sorted, (key, revision) => {
          revisions.push([key, revision]);
        });
        return { etag, revisions };
      },
      JSON.stringify(sorted.map((resource) => resource.resourceKey)),
    );
    for (const [key, revision] of result.revisions) remember?.(key, revision);
    return result.etag;
  }
  async #hashFile(path: string): Promise<string | null> {
    return this.#options.reuseFileDigests
      ? this.#digests.read([path], () => hashFile(path))
      : hashFile(path);
  }
  async #uncachedEtagPaths(
    resources: readonly { resourceKey: string; path: string }[],
    remember?: (key: string, revision: string | null) => void,
  ): Promise<string> {
    const hash = createHash('sha256');
    for (const resource of [...resources].sort((a, b) =>
      a.resourceKey < b.resourceKey
        ? -1
        : a.resourceKey > b.resourceKey
          ? 1
          : 0,
    )) {
      const key = Buffer.from(resource.resourceKey);
      hash.update(lengthBytes(key.byteLength)).update(key);
      let handle;
      try {
        handle = await open(
          resource.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if (isMissing(error)) {
          hash.update(Buffer.from([0]));
          remember?.(resource.resourceKey, null);
          continue;
        }
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile())
          throw new RepositoryError(
            'RESOURCE_NOT_FILE',
            '來源必須是一般檔案。',
          );
        hash.update(Buffer.from([1])).update(lengthBytes(stat.size));
        const resourceHash = createHash('sha256');
        let byteSize = 0;
        const stream = handle.createReadStream({ autoClose: false });
        for await (const chunk of stream) {
          const bytes = chunk as Buffer;
          byteSize += bytes.byteLength;
          hash.update(bytes);
          resourceHash.update(bytes);
        }
        if (byteSize !== stat.size)
          throw new RepositoryError(
            'EXTERNAL_CHANGE',
            '來源在版本計算時變更，請重新載入。',
          );
        remember?.(resource.resourceKey, resourceHash.digest('hex'));
      } finally {
        await handle.close();
      }
    }
    return `"${hash.digest('hex')}"`;
  }
  async #listing(resource: string): Promise<string | null> {
    try {
      const entries = await readdir(await safePath(this.#root, resource), {
        withFileTypes: true,
      });
      return stableHash(
        entries
          .map((entry) => [
            entry.name,
            entry.isDirectory()
              ? 'directory'
              : entry.isFile()
                ? 'file'
                : 'other',
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  async #contentDependencies(): Promise<Map<string, string | null>> {
    const dependencies = new Map<string, string | null>();
    const visit = async (resource: string): Promise<void> => {
      const listing = await this.#listing(resource);
      dependencies.set(`@${resource}`, listing);
      if (listing === null) return;
      const entries = await readdir(await safePath(this.#root, resource), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const key = `${resource}/${entry.name}`;
        const path = await safePath(this.#root, key);
        if (entry.isDirectory()) await visit(key);
        else if (entry.isFile())
          dependencies.set(key, await this.#hashFile(path));
        else
          throw new RepositoryError(
            'INVALID_SOURCE_DATA',
            '來源集合包含非一般檔案。',
            422,
          );
      }
    };
    await visit('content');
    return dependencies;
  }
  async #verifyDependencies(
    dependencies: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    await mapConcurrent([...dependencies], async ([key, revision]) => {
      let actual;
      if (key.startsWith('@')) actual = await this.#listing(key.slice(1));
      else {
        const path = await safePath(this.#root, key);
        actual = await this.#hashFile(path);
      }
      if (actual !== revision)
        throw new RepositoryError(
          'EXTERNAL_CHANGE',
          '讀取依賴在操作期間被外部修改，請重新載入。',
        );
    });
  }
  #session(): {
    value: ReadSession;
    close: () => void;
    verify: () => Promise<void>;
  } {
    let active = true;
    const dependencies = new Map<string, string | null>();
    const remember = (key: string, revision: string | null) => {
      if (dependencies.has(key) && dependencies.get(key) !== revision)
        throw new RepositoryError(
          'EXTERNAL_CHANGE',
          '一致讀取期間來源被外部修改。',
        );
      dependencies.set(key, revision);
    };
    const check = () => {
      if (!active)
        throw new RepositoryError(
          'READ_SESSION_CLOSED',
          '一致讀取已結束。',
          500,
        );
    };
    return {
      value: {
        generation: this.#state.generation,
        read: async (key) => {
          check();
          const value = await this.#read(key);
          remember(key, value?.revision ?? null);
          return value;
        },
        etag: async (keys) => {
          check();
          return this.#etag(keys, remember);
        },
        listArticleIds: async () => {
          check();
          remember(
            '@content/articles',
            await this.#listing('content/articles'),
          );
          let entries;
          try {
            entries = await readdir(
              await safePath(this.#root, 'content/articles'),
              { withFileTypes: true },
            );
          } catch (error) {
            if (isMissing(error)) return [];
            throw error;
          }
          return entries
            .filter((entry) => entry.name !== '.gitkeep')
            .map((entry) => {
              if (
                !entry.isDirectory() ||
                entry.isSymbolicLink() ||
                !ArticleIdSchema.safeParse(entry.name).success
              )
                throw new RepositoryError(
                  'INVALID_ARTICLE_DIRECTORY',
                  '文章目錄包含無效來源。',
                  422,
                );
              return entry.name;
            })
            .sort();
        },
        loadContent: async (options: LoadContentOptions = {}) => {
          check();
          const before = await this.#contentDependencies();
          const content = await loadContent(this.#root, {
            ...options,
            ...(this.#options.pageSchemas
              ? { pageSchemas: this.#options.pageSchemas }
              : {}),
          });
          await this.#verifyDependencies(before);
          for (const [key, revision] of before) remember(key, revision);
          return content;
        },
      },
      close: () => {
        active = false;
      },
      verify: () => this.#verifyDependencies(dependencies),
    };
  }
  async initialize(): Promise<{
    recoveryState: 'ready' | 'recovery-required';
    generation: number;
  }> {
    return this.#locked(async () => ({
      recoveryState: await this.#recoveryState(),
      generation: this.#state.generation,
    }));
  }
  async withConsistentRead<T>(
    fn: (session: ReadSession) => Promise<T>,
  ): Promise<T> {
    return this.#locked(async () => {
      const session = this.#session();
      try {
        const result = await fn(session.value);
        await session.verify();
        return result;
      } finally {
        session.close();
      }
    });
  }
  async withBuildInputLock<T>(
    fn: (session: ReadSession) => Promise<T>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.#locked(async () => {
      await this.#assertReady();
      const session = this.#session();
      try {
        const result = await fn(session.value);
        await session.verify();
        return result;
      } finally {
        session.close();
      }
    }, options.signal);
  }
  async #recoveryState(): Promise<'ready' | 'recovery-required'> {
    return (await this.#journals()).some(
      (journal) => journal.status === 'recovery-required',
    )
      ? 'recovery-required'
      : 'ready';
  }
  async #assertReady(): Promise<void> {
    if ((await this.#recoveryState()) !== 'ready')
      throw new RepositoryError('RECOVERY_REQUIRED', '請先完成未解交易復原。');
  }
  #requireMatch(ifMatch: string | undefined, current: string): void {
    if (ifMatch === undefined)
      throw new RepositoryError(
        'PRECONDITION_REQUIRED',
        '請附上最新版本 If-Match。',
        428,
        current,
      );
    if (!/^"[a-f0-9]{64}"$/.test(ifMatch))
      throw new RepositoryError(
        'INVALID_IF_MATCH',
        'If-Match 必須是單一精確強版本。',
        400,
        current,
      );
    if (ifMatch !== current)
      throw new RepositoryError(
        'PRECONDITION_FAILED',
        '來源已更新，請比較目前版本後重試。',
        412,
        current,
      );
  }
  async #workspace(scanInputs: ScanInputs): Promise<WorkspaceResult> {
    const revision = await scanInputs();
    if (!revisionPattern.test(revision))
      throw new RepositoryError(
        'INVALID_INPUT_REVISION',
        '建置來源版本無效。',
        500,
      );
    const value: Workspace = {
      revision,
      editMode: this.#state.editMode,
      recoveryState: await this.#recoveryState(),
      diagnostics: [],
      limits: { ...CONTENT_LIMITS },
    };
    return {
      value,
      etag: `"${stableHash([revision, value.editMode, value.recoveryState, this.#state.stateVersion])}"`,
      generation: this.#state.generation,
    };
  }
  async workspace(options: {
    readonly scanInputs: ScanInputs;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceResult> {
    return this.#locked(
      () => this.#workspace(options.scanInputs),
      options.signal,
    );
  }
  async setEditMode(
    mode: 'studio' | 'ide',
    ifMatch: string | undefined,
    options: { readonly scanInputs: ScanInputs },
  ): Promise<WorkspaceResult> {
    return this.#locked(async () => {
      if (!['studio', 'ide'].includes(mode))
        throw new RepositoryError('INVALID_EDIT_MODE', '編輯模式無效。', 422);
      const current = await this.#workspace(options.scanInputs);
      this.#requireMatch(ifMatch, current.etag);
      if (mode !== this.#state.editMode) {
        this.#state.editMode = mode;
        this.#state.stateVersion++;
        await this.#saveState();
      }
      return this.#workspace(options.scanInputs);
    });
  }
  async noteExternalChange(): Promise<number> {
    return this.#locked(async () => {
      this.#state.generation++;
      this.#state.stateVersion++;
      await this.#saveState();
      return this.#state.generation;
    });
  }
  async stageBinary(
    source: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<PreparedBinary> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > CONTENT_LIMITS.videoSourceBytes
    )
      throw new RepositoryError('INVALID_BINARY_LIMIT', '媒體上限無效。', 500);
    await safeMkdir(this.#root, privateResource(this.#root, 'staging'));
    const id = randomUUID();
    const path = await safePath(
      this.#root,
      privateResource(this.#root, `staging/${id}.part`),
    );
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash('sha256');
    let byteSize = 0;
    try {
      for await (const chunk of source) {
        byteSize += chunk.byteLength;
        if (byteSize > maxBytes)
          throw new RepositoryError(
            'SOURCE_TOO_LARGE',
            '來源檔案超過允許大小。',
            413,
          );
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      if (byteSize === 0)
        throw new RepositoryError('EMPTY_SOURCE', '來源檔案不可為空。', 422);
      await handle.sync();
      await syncDirectory(dirname(path));
      return { preparedBinaryId: id, byteSize, revision: hash.digest('hex') };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  }
  async discardBinary(binary: PreparedBinary): Promise<void> {
    if (!UuidSchema.safeParse(binary.preparedBinaryId).success)
      throw new RepositoryError(
        'INVALID_PREPARED_BINARY',
        '媒體暫存識別無效。',
        400,
      );
    await rm(
      await safePath(
        this.#root,
        privateResource(this.#root, `staging/${binary.preparedBinaryId}.part`),
      ),
      { force: true },
    );
  }
  async commit(request: CommitRequest): Promise<CommitResult> {
    return this.#locked(() => this.#commit(request, false));
  }

  async #commit(
    request: CommitRequest,
    recovery: boolean,
    transactionId = randomUUID(),
    reserveDirectory?: string,
  ): Promise<CommitResult> {
    if (!recovery) {
      await this.#assertReady();
      if (this.#state.editMode === 'ide')
        throw new RepositoryError(
          'IDE_EDIT_MODE',
          '目前為 IDE 編輯模式，請切回 Studio 後保存。',
        );
    }
    if (
      request.changes.length === 0 ||
      new Set(request.changes.map((item) => item.resourceKey)).size !==
        request.changes.length
    )
      throw new RepositoryError(
        'INVALID_CHANGES',
        '交易必須包含不重複的資源。',
        400,
      );
    for (const change of request.changes) {
      this.#key(change.resourceKey);
      if (
        change.content !== null &&
        (change.content instanceof Uint8Array
          ? change.content.byteLength
          : change.content.byteSize) > this.#limit(change.resourceKey)
      )
        throw new RepositoryError(
          'SOURCE_TOO_LARGE',
          '候選來源超過該資源允許大小。',
          422,
        );
      if (
        change.expectedRevision !== null &&
        !revisionPattern.test(change.expectedRevision)
      )
        throw new RepositoryError('INVALID_REVISION', '來源版本無效。', 400);
    }
    const newArticleIds = new Set(
      request.changes
        .filter((item) => item.content !== null)
        .map(
          (item) => /^content\/articles\/([^/]+)\//.exec(item.resourceKey)?.[1],
        )
        .filter((id): id is string => id !== undefined),
    );
    if (newArticleIds.size > 0) {
      const capacitySession = this.#session();
      try {
        const ids = new Set(await capacitySession.value.listArticleIds());
        if (request.trash?.kind === 'article') ids.delete(request.trash.id);
        for (const id of newArticleIds) ids.add(id);
        if (ids.size > CONTENT_LIMITS.articleCount)
          throw new RepositoryError(
            'ARTICLE_CAPACITY_EXCEEDED',
            '文章數量已達允許上限，請先整理來源。',
            422,
          );
      } finally {
        capacitySession.close();
      }
    }
    const responseKeys =
      request.precondition?.resourceKeys ??
      request.changes.map((item) => item.resourceKey);
    let actualEtag: string;
    const session = this.#session();
    try {
      actualEtag = await session.value.etag(responseKeys);
      if (request.precondition?.representationEtag) {
        actualEtag = await request.precondition.representationEtag(
          session.value,
          actualEtag,
        );
        if (!/^"[a-f0-9]{64}"$/.test(actualEtag))
          throw new RepositoryError(
            'INVALID_REPRESENTATION_ETAG',
            '資源表示版本不符合強ETag契約。',
            500,
          );
      }
      if (request.precondition)
        this.#requireMatch(request.precondition.ifMatch, actualEtag);
      else if (
        !recovery &&
        request.changes.some((item) => item.expectedRevision !== null)
      )
        this.#requireMatch(undefined, actualEtag);
      if (
        request.workspacePrecondition &&
        (await request.workspacePrecondition.scanInputs()) !==
          request.workspacePrecondition.revision
      )
        throw new RepositoryError(
          'WORKSPACE_CHANGED',
          '工作區來源已更新，請重新確認影響。',
          412,
          actualEtag,
        );
      for (const change of request.changes) {
        if (
          (await hashFile(await this.#path(change.resourceKey))) !==
          change.expectedRevision
        )
          throw new RepositoryError(
            'PRECONDITION_FAILED',
            '來源已更新，請比較目前版本後重試。',
            412,
            actualEtag,
          );
      }
      await request.validate?.(session.value);
    } finally {
      session.close();
    }
    if (request.trash) {
      const directory = this.#trashDirectory(request.trash);
      if (
        request.kind !== 'delete' ||
        request.changes.some(
          (item) =>
            item.content !== null ||
            !item.resourceKey.startsWith(`${directory}/`),
        )
      )
        throw new RepositoryError(
          'INVALID_TRASH_TRANSACTION',
          '回收筒交易範圍不正確。',
          400,
        );
    }
    const journal: Journal = {
      schemaVersion: 1,
      id: transactionId,
      createdAt: this.#now(),
      status: 'prepared',
      kind: request.kind,
      generationAfter: this.#state.generation + 1,
      entries: [],
      ...(request.operation ? { operation: request.operation } : {}),
      ...(request.jobCompletion
        ? { jobCompletion: request.jobCompletion }
        : {}),
      ...(request.trash ? { trash: request.trash } : {}),
      ...(reserveDirectory
        ? {
            directoryReservation: {
              resourceKey: reserveDirectory,
              token: randomUUID(),
              identity: null,
            },
          }
        : {}),
    };
    for (const folder of ['base', 'prepared', 'displaced', 'observed', 'stage'])
      await safeMkdir(
        this.#root,
        privateResource(this.#root, `transactions/${journal.id}/${folder}`),
      );
    let journalPersisted = false;
    try {
      for (const [index, change] of request.changes.entries()) {
        const source = await this.#path(change.resourceKey);
        if (change.expectedRevision !== null) {
          await copyDurable(
            source,
            await this.#journalPath(journal.id, `base/${index}`),
          );
          if (
            (await hashFile(
              await this.#journalPath(journal.id, `base/${index}`),
            )) !== change.expectedRevision
          )
            throw new RepositoryError(
              'PRECONDITION_FAILED',
              '來源在準備期間變更。',
              412,
              actualEtag,
            );
          await this.#fault('backup-file', journal.id, change.resourceKey);
        }
        let next: string | null = null;
        let byteSize = 0;
        if (change.content !== null) {
          const prepared = await this.#journalPath(
            journal.id,
            `prepared/${index}`,
          );
          if (change.content instanceof Uint8Array) {
            await durableBytes(prepared, change.content);
            next = sha256(change.content);
            byteSize = change.content.byteLength;
          } else {
            const staged = change.content;
            if (
              !UuidSchema.safeParse(staged.preparedBinaryId).success ||
              !revisionPattern.test(staged.revision)
            )
              throw new RepositoryError(
                'INVALID_PREPARED_BINARY',
                '媒體暫存識別無效。',
                400,
              );
            const stagedPath = await safePath(
              this.#root,
              privateResource(
                this.#root,
                `staging/${staged.preparedBinaryId}.part`,
              ),
            );
            if (
              (await hashFile(stagedPath)) !== staged.revision ||
              (await lstat(stagedPath)).size !== staged.byteSize
            )
              throw new RepositoryError(
                'PREPARED_BINARY_CHANGED',
                '媒體暫存版本已變更。',
              );
            await copyDurable(stagedPath, prepared);
            next = staged.revision;
            byteSize = staged.byteSize;
          }
          await this.#fault('prepared-file', journal.id, change.resourceKey);
        }
        journal.entries.push(
          newEntry(change.resourceKey, change.expectedRevision, next, byteSize),
        );
      }
      // 先驗證可持久序列化的 operation 關聯，禁止寫入無效 journal。
      parseJournal(journal);
      await this.#writeJournal(journal);
      journalPersisted = true;
      await this.#fault('prepared-journal', journal.id);
      for (const entry of journal.entries) {
        if (
          (await hashFile(await this.#path(entry.resourceKey))) !==
          entry.oldRevision
        ) {
          await this.#markConflict(journal);
          throw new RepositoryError(
            'EXTERNAL_CHANGE',
            '來源在提交前被外部修改，請比較復原版本。',
            409,
          );
        }
      }
      await this.#fault('verified-before-commit', journal.id);
      await session.verify();
      if (
        request.workspacePrecondition &&
        (await request.workspacePrecondition.scanInputs()) !==
          request.workspacePrecondition.revision
      )
        throw new RepositoryError(
          'WORKSPACE_CHANGED',
          '工作區來源在準備期間已更新。',
          412,
        );
      const candidateEtag = await this.#etagPaths(
        await Promise.all(
          responseKeys.map(async (resourceKey) => {
            const index = journal.entries.findIndex(
              (entry) => entry.resourceKey === resourceKey,
            );
            return {
              resourceKey,
              path:
                index < 0
                  ? await this.#path(resourceKey)
                  : await this.#journalPath(journal.id, `prepared/${index}`),
            };
          }),
        ),
      );
      await this.#reserveDirectory(journal);
      journal.status = 'installing';
      await this.#writeJournal(journal);
      await this.#fault('install-intent', journal.id);
      this.#state.generation = journal.generationAfter;
      this.#state.stateVersion++;
      await this.#saveState();
      await this.#fault('generation', journal.id);
      for (const [index, entry] of journal.entries.entries()) {
        await this.#verifyReservedDirectory(journal);
        await this.#install(journal, entry, index, true);
      }
      await this.#verifyReservedDirectory(journal);
      await this.#removeDeletedDirectory(journal);
      for (const entry of journal.entries)
        if (
          (await hashFile(await this.#path(entry.resourceKey))) !==
          entry.newRevision
        ) {
          await this.#markConflict(journal);
          throw new RepositoryError(
            'EXTERNAL_CHANGE',
            '提交時偵測到外部版本，請先復原。',
          );
        }
      journal.status = 'committed';
      journal.committedAt = this.#now();
      await this.#writeJournal(journal);
      await this.#fault('committed-journal', journal.id);
      return {
        transactionId: journal.id,
        generation: this.#state.generation,
        revisions: journal.entries.map((item) => ({
          resourceKey: item.resourceKey,
          revision: item.newRevision,
        })),
        etag: candidateEtag,
      };
    } catch (error) {
      if (
        journalPersisted &&
        journal.status !== 'committed' &&
        journal.status !== 'recovery-required'
      ) {
        // 正常錯誤可立即復原；真正程序中止由下一次取得鎖者復原。
        try {
          await this.#recoverJournal(journal);
        } catch {
          await this.#markConflict(journal);
        }
      }
      throw error;
    }
  }

  async #markConflict(journal: Journal): Promise<void> {
    for (const [index, entry] of journal.entries.entries()) {
      const current = await this.#path(entry.resourceKey);
      const displaced = await this.#journalPath(
        journal.id,
        `displaced/${index}`,
      );
      const displacedRevision = await hashFile(displaced);
      if (
        displacedRevision !== null &&
        displacedRevision !== entry.oldRevision
      ) {
        const saved = await this.#journalPath(
          journal.id,
          `observed/${index}.${displacedRevision}`,
        );
        if ((await hashFile(saved)) === null)
          await copyDurable(displaced, saved);
        if ((await hashFile(current)) === null) {
          // rename途中搬走的未知版先獨立保存；只在正式位置仍空時exclusive放回。
          const stage = await this.#journalPath(journal.id, `stage/${index}`);
          await rm(stage, { force: true });
          await copyDurable(saved, stage);
          try {
            await link(stage, current);
            await syncDirectory(dirname(current));
          } catch (error) {
            if (!(
              error instanceof Error &&
              'code' in error &&
              error.code === 'EEXIST'
            ))
              throw error;
          } finally {
            await rm(stage, { force: true });
            await syncDirectory(dirname(stage));
          }
        }
      }
      const revision = await hashFile(current);
      if (revision !== null) {
        const observed = await this.#journalPath(
          journal.id,
          `observed/${index}.${revision}`,
        );
        if ((await hashFile(observed)) === null)
          await copyDurable(current, observed);
      }
    }
    journal.status = 'recovery-required';
    await this.#writeJournal(journal);
    this.#state.stateVersion++;
    await this.#saveState();
  }
  async #install(
    journal: Journal,
    entry: JournalEntry,
    index: number,
    fault: boolean,
  ): Promise<void> {
    const target = await this.#path(entry.resourceKey);
    const current = await hashFile(target);
    const displaced = await this.#journalPath(journal.id, `displaced/${index}`);
    if (current === entry.newRevision && current !== entry.oldRevision) {
      entry.installed = true;
      return;
    }
    if (
      current !== entry.oldRevision &&
      !(current === null && (await hashFile(displaced)) === entry.oldRevision)
    ) {
      await this.#markConflict(journal);
      throw new RepositoryError(
        'EXTERNAL_CHANGE',
        '正式來源有未知版本，請先復原。',
      );
    }
    await safeMkdir(this.#root, dirname(entry.resourceKey));
    if (current !== null) {
      if ((await hashFile(displaced)) !== null) {
        // base 已獨立保存，已知同版 displaced 可清除後重試；未知版絕不覆寫。
        if ((await hashFile(displaced)) !== entry.oldRevision) {
          await this.#markConflict(journal);
          throw new RepositoryError(
            'RECOVERY_REQUIRED',
            '保留版本不符，請先復原。',
          );
        }
        await rm(displaced);
        await syncDirectory(dirname(displaced));
      }
      if (fault)
        await this.#fault('before-displace', journal.id, entry.resourceKey);
      await rename(target, displaced);
      await syncDirectory(dirname(target));
      await syncDirectory(dirname(displaced));
      if ((await hashFile(displaced)) !== entry.oldRevision) {
        await this.#markConflict(journal);
        throw new RepositoryError(
          'EXTERNAL_CHANGE',
          '來源在搬移時出現外部版本。',
        );
      }
    }
    if (fault)
      await this.#fault('after-displace', journal.id, entry.resourceKey);
    if (entry.newRevision !== null) {
      const prepared = await this.#journalPath(journal.id, `prepared/${index}`);
      if ((await hashFile(prepared)) !== entry.newRevision)
        throw new RepositoryError(
          'RECOVERY_REQUIRED',
          '準備版本已損壞，請保留復原資料。',
        );
      const stage = await this.#journalPath(journal.id, `stage/${index}`);
      await rm(stage, { force: true });
      await copyDurable(prepared, stage);
      if ((await hashFile(target)) !== null) {
        await this.#markConflict(journal);
        throw new RepositoryError(
          'EXTERNAL_CHANGE',
          '來源在安裝前出現新版本。',
        );
      }
      if (fault)
        await this.#fault('before-install-link', journal.id, entry.resourceKey);
      try {
        await link(stage, target);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        ) {
          await this.#markConflict(journal);
          throw new RepositoryError(
            'EXTERNAL_CHANGE',
            '安裝時出現同名外部來源，已保留全部版本。',
          );
        }
        throw error;
      }
      await syncDirectory(dirname(target));
      await rm(stage);
      await syncDirectory(dirname(stage));
    }
    if (fault)
      await this.#fault('after-install', journal.id, entry.resourceKey);
    entry.installed = true;
    await this.#writeJournal(journal);
    if (fault)
      await this.#fault('per-file-journal', journal.id, entry.resourceKey);
  }
  #trashDirectory(trash: {
    readonly kind: 'article' | 'media';
    readonly id: string;
  }): string {
    if (trash.kind === 'article' && ArticleIdSchema.safeParse(trash.id).success)
      return `content/articles/${trash.id}`;
    if (trash.kind === 'media' && UuidSchema.safeParse(trash.id).success)
      return `media/source/${trash.id}`;
    throw new RepositoryError(
      'INVALID_TRASH_RESOURCE',
      '回收筒來源識別不合法。',
      400,
    );
  }
  async #removeDeletedDirectory(journal: Journal): Promise<void> {
    if (!journal.trash) return;
    const resource = this.#trashDirectory(journal.trash);
    const path = await safePath(this.#root, resource);
    try {
      await rmdir(path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!isMissing(error)) {
        await this.#markConflict(journal);
        throw new RepositoryError(
          'EXTERNAL_CHANGE',
          '刪除目錄仍有其他資料，請先復原。',
        );
      }
    }
  }
  async #reserveDirectory(journal: Journal): Promise<void> {
    const reservation = journal.directoryReservation;
    if (!reservation) return;
    const target = await safePath(this.#root, reservation.resourceKey);
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        journal.status = 'rolled-back';
        await this.#writeJournal(journal);
        throw new RepositoryError(
          'TRASH_TARGET_EXISTS',
          '同名來源在復原準備期間出現，已保留現有資料。',
        );
      }
      throw error;
    }
    await syncDirectory(dirname(target));
    await this.#fault('directory-created', journal.id);
    const stat = await lstat(target);
    reservation.identity = { dev: stat.dev, ino: stat.ino };
    await this.#writeJournal(journal);
    await this.#fault('directory-reserved', journal.id);
  }
  async #verifyReservedDirectory(journal: Journal): Promise<void> {
    const reservation = journal.directoryReservation;
    if (!reservation) return;
    const target = await safePath(this.#root, reservation.resourceKey);
    let valid = false;
    try {
      const stat = await lstat(target);
      valid =
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        reservation.identity !== null &&
        stat.dev === reservation.identity.dev &&
        stat.ino === reservation.identity.ino;
      if (valid) {
        const names = new Set(
          journal.entries.map((entry) =>
            entry.resourceKey.slice(reservation.resourceKey.length + 1),
          ),
        );
        valid = (await readdir(target, { withFileTypes: true })).every(
          (entry) =>
            entry.isFile() && !entry.isSymbolicLink() && names.has(entry.name),
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!valid) {
      await this.#markConflict(journal);
      throw new RepositoryError(
        'TRASH_TARGET_EXISTS',
        '復原目錄出現未知資料或所有權已改變，請先比較保留版本。',
      );
    }
  }
  async #recoverJournal(journal: Journal): Promise<void> {
    if (journal.status === 'prepared') {
      const reservation = journal.directoryReservation;
      if (reservation) {
        const target = await safePath(this.#root, reservation.resourceKey);
        try {
          const stat = await lstat(target);
          if (
            !reservation.identity ||
            !stat.isDirectory() ||
            stat.dev !== reservation.identity.dev ||
            stat.ino !== reservation.identity.ino ||
            (await readdir(target)).length > 0
          ) {
            await this.#markConflict(journal);
            return;
          }
          await rmdir(target);
          await syncDirectory(dirname(target));
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      for (const entry of journal.entries)
        if (
          (await hashFile(await this.#path(entry.resourceKey))) !==
          entry.oldRevision
        ) {
          await this.#markConflict(journal);
          return;
        }
      journal.status = 'rolled-back';
      await this.#writeJournal(journal);
      return;
    }
    if (journal.status !== 'installing') return;
    if (journal.directoryReservation) {
      try {
        await this.#verifyReservedDirectory(journal);
      } catch {
        return;
      }
    }
    for (const [index, entry] of journal.entries.entries()) {
      const current = await hashFile(await this.#path(entry.resourceKey));
      const displaced = await hashFile(
        await this.#journalPath(journal.id, `displaced/${index}`),
      );
      if (
        (current !== entry.oldRevision &&
          current !== entry.newRevision &&
          !(current === null && displaced === entry.oldRevision)) ||
        (displaced !== null && displaced !== entry.oldRevision) ||
        (entry.newRevision !== null &&
          (await hashFile(
            await this.#journalPath(journal.id, `prepared/${index}`),
          )) !== entry.newRevision)
      ) {
        await this.#markConflict(journal);
        return;
      }
    }
    this.#state.generation = Math.max(
      this.#state.generation,
      journal.generationAfter,
    );
    this.#state.stateVersion++;
    await this.#saveState();
    for (const [index, entry] of journal.entries.entries())
      await this.#install(journal, entry, index, false);
    await this.#removeDeletedDirectory(journal);
    for (const entry of journal.entries)
      if (
        (await hashFile(await this.#path(entry.resourceKey))) !==
        entry.newRevision
      ) {
        await this.#markConflict(journal);
        return;
      }
    journal.status = 'committed';
    journal.committedAt = this.#now();
    await this.#writeJournal(journal);
  }
  async #purgeFiles(id: string): Promise<void> {
    for (const folder of ['base', 'prepared', 'displaced', 'observed', 'stage'])
      await rm(
        await safePath(
          this.#root,
          privateResource(this.#root, `transactions/${id}/${folder}`),
        ),
        { recursive: true, force: true },
      );
    await syncDirectory(dirname(await this.#journalPath(id)));
  }
  async #finishResolution(journal: Journal): Promise<void> {
    if (journal.status === 'committed' && !journal.committedAt)
      journal.committedAt = journal.createdAt;
    journal.status = 'resolved';
    await this.#writeJournal(journal);
    this.#state.stateVersion++;
    await this.#saveState();
  }
  async #recoverResolution(journal: Journal): Promise<void> {
    const intent = journal.resolution;
    if (!intent) return;
    if (intent.choice === 'purge-trash') {
      await this.#purgeFiles(journal.id);
      await this.#finishResolution(journal);
      return;
    }
    if (intent.choice === 'keep-current') {
      let matches = true;
      for (const item of intent.revisions)
        if (
          (await hashFile(await this.#path(item.resourceKey))) !== item.revision
        )
          matches = false;
      if (matches) {
        await this.#finishResolution(journal);
        return;
      }
    } else if (intent.transactionId) {
      const child = (await this.#journals()).find(
        (item) => item.id === intent.transactionId,
      );
      if (child?.status === 'committed') {
        await this.#finishResolution(journal);
        return;
      }
      if (
        child &&
        child.status !== 'rolled-back' &&
        child.status !== 'resolved'
      )
        return;
    }
    // 候選交易尚未開始／僅prepared回滾；保留全部版本，重新取得最新確認即可重試。
    delete journal.resolution;
    await this.#writeJournal(journal);
  }

  async listCommittedOperations(): Promise<readonly OperationReceipt[]> {
    return this.#locked(async () =>
      (await this.#journals()).flatMap((journal) =>
        (journal.status === 'committed' ||
          (journal.status === 'resolved' && journal.committedAt)) &&
        journal.operation
          ? [journal.operation]
          : [],
      ),
    );
  }
  async listCommittedJobResults(): Promise<readonly CommittedJobResult[]> {
    return this.#locked(async () =>
      (await this.#journals()).flatMap((journal) =>
        (journal.status === 'committed' || journal.status === 'resolved') &&
        journal.committedAt &&
        journal.jobCompletion
          ? [
              {
                ...journal.jobCompletion,
                transactionId: journal.id,
                committedAt: journal.committedAt,
              },
            ]
          : [],
      ),
    );
  }
  async listRecoveries(): Promise<
    readonly {
      id: string;
      kind: 'transaction' | 'trash';
      status: 'available' | 'pending' | 'resolved';
      createdAt: string;
    }[]
  > {
    return this.#locked(async () =>
      (await this.#journals())
        .filter(
          (journal) =>
            journal.status === 'recovery-required' ||
            journal.status === 'resolved' ||
            journal.status === 'committed',
        )
        .map((journal) => ({
          id: journal.id,
          kind: journal.trash ? 'trash' : 'transaction',
          status:
            journal.status === 'resolved'
              ? 'resolved'
              : journal.status === 'recovery-required'
                ? 'pending'
                : 'available',
          createdAt: journal.createdAt,
        })),
    );
  }
  async #findJournal(id: string): Promise<Journal> {
    this.#transactionResource(id);
    const journal = (await this.#journals()).find((item) => item.id === id);
    if (!journal)
      throw new RepositoryError('RECOVERY_NOT_FOUND', '復原紀錄不存在。', 404);
    return journal;
  }
  async #detail(journal: Journal): Promise<RecoveryResult> {
    const resources: RecoveryDetail['resources'] = [];
    for (const [index, entry] of journal.entries.entries()) {
      const version = async (kind: 'base' | 'prepared' | 'current') => {
        const source =
          kind === 'current'
            ? await this.#path(entry.resourceKey)
            : await this.#journalPath(journal.id, `${kind}/${index}`);
        const revision = await hashFile(source);
        if (revision === null)
          return { revision: null, text: null, binary: null };
        const stat = await lstat(source);
        if (
          !binaryPattern.test(entry.resourceKey) &&
          stat.size <= CONTENT_LIMITS.articleHtmlBytes
        ) {
          const bytes = await readOptional(source);
          if (bytes === null || sha256(bytes) !== revision)
            throw new RepositoryError(
              'EXTERNAL_CHANGE',
              '復原來源在讀取時變更，請重新載入。',
            );
          try {
            if (bytes)
              return {
                revision,
                text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
                binary: null,
              };
          } catch {
            /* 無效 UTF-8 仍可作為二進位保留及下載。 */
          }
        }
        if (kind === 'current') {
          const preserved = await this.#journalPath(
            journal.id,
            `observed/${index}.${revision}`,
          );
          if ((await hashFile(preserved)) === null)
            await copyDurable(source, preserved);
          if ((await hashFile(preserved)) !== revision)
            throw new RepositoryError(
              'EXTERNAL_CHANGE',
              '復原來源在備份時變更，請重新載入。',
            );
        }
        const fileId = versionFileId(`${entry.fileId}:${kind}:${revision}`);
        return {
          revision,
          text: null,
          binary: {
            fileId,
            mimeType: mimeType(entry.resourceKey),
            byteSize: stat.size,
            sha256: revision,
            downloadUrl: `/api/v1/recoveries/${journal.id}/files/${fileId}`,
          },
        };
      };
      const base = await version('base');
      const current = await version('current');
      const prepared = await version('prepared');
      const preserved: RecoveryDetail['resources'][number]['preserved'] = [];
      const seen = new Set([
        base.revision,
        current.revision,
        prepared.revision,
      ]);
      const observedFiles = await readdir(
        await safePath(
          this.#root,
          privateResource(this.#root, `transactions/${journal.id}/observed`),
        ),
      ).catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      });
      for (const filename of observedFiles.sort()) {
        const match = new RegExp(`^${index}\\.([a-f0-9]{64})$`).exec(filename);
        const revision = match?.[1];
        if (!revision || seen.has(revision)) continue;
        const source = await this.#journalPath(
          journal.id,
          `observed/${index}.${revision}`,
        );
        if ((await hashFile(source)) !== revision)
          throw new RepositoryError(
            'RECOVERY_REQUIRED',
            '保留版本已損壞，請保留資料並檢查。',
          );
        seen.add(revision);
        const stat = await lstat(source);
        let text: string | null = null;
        if (
          !binaryPattern.test(entry.resourceKey) &&
          stat.size <= CONTENT_LIMITS.articleHtmlBytes
        ) {
          const bytes = await readOptional(source);
          if (bytes)
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
              /* 二進位保留 */
            }
        }
        const fileId = versionFileId(`${entry.fileId}:preserved:${revision}`);
        preserved.push({
          revision,
          text,
          binary:
            text === null
              ? {
                  fileId,
                  mimeType: mimeType(entry.resourceKey),
                  byteSize: stat.size,
                  sha256: revision,
                  downloadUrl: `/api/v1/recoveries/${journal.id}/files/${fileId}`,
                }
              : null,
        });
      }
      resources.push({
        resourceKey: entry.resourceKey,
        base,
        current,
        prepared,
        preserved,
      });
    }
    const choices: RecoveryDetail['choices'] = journal.trash
      ? ['restore-trash', 'purge-trash']
      : ['keep-current', 'restore-backup', 'apply-prepared'];
    const value: RecoveryDetail = {
      id: journal.id,
      kind: journal.trash ? 'trash' : 'transaction',
      status:
        journal.status === 'resolved'
          ? 'resolved'
          : journal.status === 'recovery-required'
            ? 'pending'
            : 'available',
      createdAt: journal.createdAt,
      resources,
      choices,
    };
    return {
      value,
      etag: `"${stableHash([value, journal.status, journal.resolution ?? null])}"`,
    };
  }
  async recovery(id: string): Promise<RecoveryResult> {
    return this.#locked(async () => this.#detail(await this.#findJournal(id)));
  }
  async recoveryFile(
    id: string,
    fileId: string,
  ): Promise<{
    stream: ReturnType<typeof createReadStream>;
    byteSize: number;
    mimeType: string;
    sha256: string;
  }> {
    return this.#locked(async () => {
      if (!UuidSchema.safeParse(fileId).success)
        throw new RepositoryError(
          'RECOVERY_FILE_NOT_FOUND',
          '復原檔案不存在。',
          404,
        );
      const journal = await this.#findJournal(id);
      const detail = await this.#detail(journal);
      for (const [index, resource] of detail.value.resources.entries())
        for (const item of [
          ...(['base', 'prepared', 'current'] as const).map((kind) => ({
            binary: resource[kind].binary,
            suffix:
              kind === 'current'
                ? `observed/${index}.${resource[kind].revision ?? ''}`
                : `${kind}/${index}`,
          })),
          ...resource.preserved.map((version) => ({
            binary: version.binary,
            suffix: `observed/${index}.${version.revision ?? ''}`,
          })),
        ]) {
          const binary = item.binary;
          if (binary?.fileId === fileId) {
            const source = await this.#journalPath(id, item.suffix);
            if ((await hashFile(source)) !== binary.sha256)
              throw new RepositoryError(
                'RECOVERY_REQUIRED',
                '復原檔案已變更。',
              );
            const handle = await open(
              source,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            return {
              stream: handle.createReadStream(),
              byteSize: binary.byteSize,
              mimeType: binary.mimeType,
              sha256: binary.sha256,
            };
          }
        }
      throw new RepositoryError(
        'RECOVERY_FILE_NOT_FOUND',
        '復原檔案不存在。',
        404,
      );
    });
  }
  async resolveRecovery(
    id: string,
    resolution: RecoveryResolution,
    ifMatch: string | undefined,
  ): Promise<RecoveryResolutionResult> {
    return this.#locked(async () => {
      const parsed = RecoveryResolutionSchema.safeParse(resolution);
      if (!parsed.success)
        throw new RepositoryError(
          'INVALID_RECOVERY_RESOLUTION',
          '復原決議格式不正確。',
          422,
        );
      const journal = await this.#findJournal(id);
      if (journal.status === 'resolved')
        throw new RepositoryError(
          'RECOVERY_ALREADY_RESOLVED',
          '此復原紀錄已處理。',
        );
      if (
        journal.status !== 'recovery-required' &&
        journal.status !== 'committed'
      )
        throw new RepositoryError(
          'RECOVERY_NOT_PENDING',
          '交易目前不需要人工復原。',
        );
      const detail = await this.#detail(journal);
      this.#requireMatch(ifMatch, detail.etag);
      if (resolution.revisions.length !== journal.entries.length)
        throw new RepositoryError(
          'INCOMPLETE_RECOVERY_REVISIONS',
          '必須提供全部最新來源版本。',
          422,
        );
      for (const entry of journal.entries) {
        const revision = resolution.revisions.find(
          (item) => item.resourceKey === entry.resourceKey,
        );
        if (!revision)
          throw new RepositoryError(
            'INCOMPLETE_RECOVERY_REVISIONS',
            '必須提供全部最新來源版本。',
            422,
          );
        if (
          revision.revision !==
          (await hashFile(await this.#path(entry.resourceKey)))
        )
          throw new RepositoryError(
            'PRECONDITION_FAILED',
            '復原來源已更新，請重新比較。',
            412,
            detail.etag,
          );
      }
      if (!detail.value.choices.includes(resolution.choice))
        throw new RepositoryError(
          'INVALID_RECOVERY_CHOICE',
          '此復原不支援所選操作。',
          422,
        );
      if (journal.resolution)
        throw new RepositoryError(
          'RESOLUTION_IN_PROGRESS',
          '此復原決議仍在處理，請先處理相關交易。',
        );
      const transactionId = [
        'restore-backup',
        'apply-prepared',
        'restore-trash',
      ].includes(resolution.choice)
        ? randomUUID()
        : undefined;
      if (resolution.choice === 'purge-trash') {
        if (
          Date.parse(this.#now()) - Date.parse(journal.createdAt) <
          30 * 86_400_000
        )
          throw new RepositoryError(
            'TRASH_RETENTION_REQUIRED',
            '回收筒資料須保存滿 30 天才能永久清理。',
          );
        const unresolved = (await this.#journals()).filter(
          (item) => item.id !== id && item.status === 'recovery-required',
        );
        if (
          unresolved.some((item) =>
            item.entries.some((entry) =>
              journal.entries.some(
                (own) => own.resourceKey === entry.resourceKey,
              ),
            ),
          )
        )
          throw new RepositoryError(
            'TRASH_REFERENCED',
            '未解交易仍引用此備份，不能清理。',
          );
      }
      if (resolution.choice === 'restore-trash') {
        if (!journal.trash)
          throw new RepositoryError(
            'INVALID_RECOVERY_CHOICE',
            '此項目不在回收筒。',
            422,
          );
        try {
          await lstat(
            await safePath(this.#root, this.#trashDirectory(journal.trash)),
          );
          throw new RepositoryError(
            'TRASH_TARGET_EXISTS',
            '同名來源已存在，請先處理現有資料。',
          );
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      journal.resolution = {
        choice: resolution.choice,
        revisions: resolution.revisions,
        ...(transactionId ? { transactionId } : {}),
      };
      await this.#writeJournal(journal);
      await this.#fault('resolution-intent', id);
      if (resolution.choice === 'purge-trash') {
        await this.#purgeFiles(id);
        await this.#fault('purge-files', id);
      } else if (resolution.choice !== 'keep-current') {
        if (resolution.choice === 'restore-trash') {
          if (!journal.trash)
            throw new RepositoryError(
              'INVALID_RECOVERY_CHOICE',
              '此項目不在回收筒。',
              422,
            );
          try {
            await lstat(
              await safePath(this.#root, this.#trashDirectory(journal.trash)),
            );
            throw new RepositoryError(
              'TRASH_TARGET_EXISTS',
              '同名來源已存在，請先處理現有資料。',
            );
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
        if (
          resolution.choice === 'apply-prepared' &&
          journal.directoryReservation
        )
          await this.#verifyReservedDirectory(journal);
        const changes = [];
        const recoveryBinaries: PreparedBinary[] = [];
        try {
          for (const [index, entry] of journal.entries.entries()) {
            const kind =
              resolution.choice === 'apply-prepared' ? 'prepared' : 'base';
            const source = await this.#journalPath(id, `${kind}/${index}`);
            const desired =
              kind === 'base' ? entry.oldRevision : entry.newRevision;
            if ((await hashFile(source)) !== desired)
              throw new RepositoryError(
                'RECOVERY_REQUIRED',
                '所選復原版本已損壞，請保留資料。',
              );
            let content: Buffer | PreparedBinary | null = null;
            if (desired !== null) {
              if (binaryPattern.test(entry.resourceKey)) {
                content = await this.stageBinary(
                  createReadStream(source),
                  CONTENT_LIMITS.videoSourceBytes,
                );
                recoveryBinaries.push(content);
              } else content = await readOptional(source);
            }
            changes.push({
              resourceKey: entry.resourceKey,
              expectedRevision:
                resolution.revisions.find(
                  (item) => item.resourceKey === entry.resourceKey,
                )?.revision ?? null,
              content,
            });
          }
          await this.#commit(
            { kind: 'restore', changes },
            true,
            transactionId,
            resolution.choice === 'restore-trash' && journal.trash
              ? this.#trashDirectory(journal.trash)
              : undefined,
          );
        } finally {
          await Promise.all(
            recoveryBinaries.map((binary) => this.discardBinary(binary)),
          );
        }
        await this.#fault('resolution-committed', id);
      }
      await this.#finishResolution(journal);
      return {
        id,
        status: 'resolved',
        choice: resolution.choice,
        generation: this.#state.generation,
      };
    });
  }
  async prune(): Promise<{
    readonly removedTransactionIds: readonly string[];
  }> {
    return this.#locked(async () => {
      const journals = await this.#journals();
      const successful = journals
        .filter(
          (journal) =>
            (journal.status === 'committed' || journal.status === 'resolved') &&
            !journal.trash,
        )
        .reverse();
      const keep = new Set(
        successful.slice(0, 20).map((journal) => journal.id),
      );
      const unresolved = journals.filter(
        (journal) => journal.status === 'recovery-required',
      );
      const removed: string[] = [];
      for (const journal of successful) {
        if (
          keep.has(journal.id) ||
          Date.parse(this.#now()) - Date.parse(journal.createdAt) <=
            7 * 86_400_000 ||
          unresolved.some((pending) =>
            pending.entries.some((entry) =>
              journal.entries.some(
                (own) => own.resourceKey === entry.resourceKey,
              ),
            ),
          )
        )
          continue;
        await rm(
          await safePath(
            this.#root,
            privateResource(this.#root, `transactions/${journal.id}`),
          ),
          { recursive: true },
        );
        removed.push(journal.id);
      }
      if (removed.length)
        await syncDirectory(
          await safePath(
            this.#root,
            privateResource(this.#root, 'transactions'),
          ),
        );
      return { removedTransactionIds: removed };
    });
  }
}
