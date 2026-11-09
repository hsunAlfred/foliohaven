import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { asciiCompare } from '@foliohaven/core';
import {
  isBuildSnapshotResource,
  isMissing,
  RepositoryError,
  safePath,
  syncDirectory,
} from '../files/io.js';
import { fileIdentity, fileIdentityIsStable } from '../files/revision-cache.js';

const sourceDirectories = [
  'content',
  'media/source',
  'packages/core',
  'packages/ui',
  'site',
  'studio',
  'server',
  'scripts',
] as const;
const requiredDirectories = new Set<string>(
  sourceDirectories.filter((value) => value !== 'media/source'),
);
const rootFiles = [
  '.node-version',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  '.gitignore',
  'eslint.config.mjs',
  'prettier.config.mjs',
  'playwright.config.ts',
  'vitest.config.ts',
] as const;
const requiredFiles = new Set<string>([
  '.node-version',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
]);
const excludedDirectories = new Set([
  'node_modules',
  'dist',
  '.foliohaven',
  '.alfred',
  '.git',
  '.astro',
  '.vite',
  '.cache',
  'coverage',
  'playwright-report',
  'test-results',
]);

export type InputEntry =
  | { readonly path: string; readonly kind: 'directory' }
  | {
      readonly path: string;
      readonly kind: 'file';
      readonly byteSize: number;
      readonly sha256: string;
      readonly executable: boolean;
    };
export interface InputManifest {
  readonly schemaVersion: 1;
  readonly entries: readonly InputEntry[];
  readonly revision: string;
}
export interface InputScanOptions {
  readonly signal?: AbortSignal;
  /** Studio observation only. Build/snapshot validation always omits this. */
  readonly cache?: BuildInputCache;
}
export class BuildInputCache {
  readonly #entries = new Map<
    string,
    { readonly identity: string; readonly entry: InputEntry }
  >();
  read(path: string, identity: string): InputEntry | undefined {
    const cached = this.#entries.get(path);
    return cached?.identity === identity ? cached.entry : undefined;
  }
  remember(path: string, identity: string, entry: InputEntry): void {
    this.#entries.delete(path);
    this.#entries.set(path, { identity, entry });
    if (this.#entries.size > 4096) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }
  retain(paths: ReadonlySet<string>): void {
    for (const path of this.#entries.keys())
      if (!paths.has(path)) this.#entries.delete(path);
  }
  clear(): void {
    this.#entries.clear();
  }
}
export class BuildInputError extends RepositoryError {
  constructor(code: string, message: string) {
    super(code, message, 409);
    this.name = 'BuildInputError';
  }
}
const changed = () =>
  new BuildInputError(
    'BUILD_INPUT_CHANGED',
    '建置來源在讀取期間改變，請重新建置。',
  );

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new BuildInputError('BUILD_CANCELLED', '建置已取消。');
}
async function fileEntry(
  root: string,
  path: string,
  signal: AbortSignal | undefined,
  cache?: BuildInputCache,
): Promise<InputEntry> {
  const handle = await open(
    await safePath(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new BuildInputError(
        'INVALID_BUILD_INPUT',
        '建置來源只接受一般檔案及目錄。',
      );
    const identity = fileIdentity(before);
    const cached = fileIdentityIsStable(before)
      ? cache?.read(path, identity)
      : undefined;
    if (cached !== undefined) {
      checkCancelled(signal);
      if (fileIdentity(await handle.stat({ bigint: true })) !== identity)
        throw changed();
      return cached;
    }
    const hash = createHash('sha256');
    let byteSize = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      checkCancelled(signal);
      const chunk = bytes as Buffer;
      byteSize += chunk.length;
      hash.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== BigInt(byteSize) ||
      after.size !== BigInt(byteSize) ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw changed();
    const entry: InputEntry = {
      path,
      kind: 'file',
      byteSize,
      sha256: hash.digest('hex'),
      executable: (before.mode & 0o111n) !== 0n,
    };
    if (fileIdentityIsStable(before) && fileIdentityIsStable(after))
      cache?.remember(path, fileIdentity(after), entry);
    return entry;
  } finally {
    await handle.close();
  }
}

/** Full byte scan by default; Studio may reuse hashes after complete file identity checks. */
export async function scanBuildInputs(
  repositoryRoot: string,
  options: InputScanOptions = {},
): Promise<InputManifest> {
  checkCancelled(options.signal);
  const root = resolve(repositoryRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new BuildInputError(
      'INVALID_BUILD_ROOT',
      '建置工作區必須是一般目錄。',
    );
  const entries: InputEntry[] = [];
  async function visit(path: string): Promise<void> {
    checkCancelled(options.signal);
    const target = await safePath(root, path);
    const stat = await lstat(target);
    if (stat.isSymbolicLink())
      throw new BuildInputError(
        'BUILD_INPUT_SYMLINK',
        '建置來源不得使用符號連結。',
      );
    if (stat.isFile()) {
      const name = path.split('/').at(-1) ?? '';
      if (
        name === '.env' ||
        (name.startsWith('.env.') && name !== '.env.example')
      )
        throw new BuildInputError(
          'PRIVATE_BUILD_INPUT',
          '套件來源含私有環境設定；請改用已定義的公開網站設定。',
        );
      entries.push(await fileEntry(root, path, options.signal, options.cache));
    } else if (stat.isDirectory()) {
      entries.push({ path, kind: 'directory' });
      for (const item of (await readdir(target)).sort(asciiCompare)) {
        if (excludedDirectories.has(item)) continue;
        await visit(`${path}/${item}`);
      }
    } else
      throw new BuildInputError(
        'INVALID_BUILD_INPUT',
        '建置來源不得包含裝置、pipe或socket。',
      );
  }
  try {
    for (const path of sourceDirectories) {
      try {
        const directory = await lstat(await safePath(root, path));
        if (!directory.isDirectory())
          throw new BuildInputError(
            'INVALID_BUILD_INPUT',
            '套件與內容來源必須是一般目錄。',
          );
      } catch (error) {
        if (isMissing(error) && !requiredDirectories.has(path)) continue;
        if (isMissing(error))
          throw new BuildInputError(
            'BUILD_INPUT_MISSING',
            '必要的套件或內容來源不存在。',
          );
        throw error;
      }
      await visit(path);
    }
    const configFiles = (await readdir(root)).filter((name) =>
      /^tsconfig(?:\.[a-z0-9-]+)?\.json$/.test(name),
    );
    for (const path of [...new Set([...rootFiles, ...configFiles])].sort(
      asciiCompare,
    )) {
      try {
        await visit(path);
      } catch (error) {
        if (isMissing(error) && !requiredFiles.has(path)) continue;
        if (isMissing(error))
          throw new BuildInputError(
            'BUILD_INPUT_MISSING',
            '必要的建置設定不存在。',
          );
        throw error;
      }
    }
  } catch (error) {
    options.cache?.clear();
    if (isMissing(error)) throw changed();
    throw error;
  }
  entries.sort((a, b) => asciiCompare(a.path, b.path));
  options.cache?.retain(new Set(entries.map((entry) => entry.path)));
  const revision = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, entries }))
    .digest('hex');
  return { schemaVersion: 1, entries, revision };
}

/** 呼叫端在 writer lock 內呼叫；目的地是本 job 尚不存在的私有 snapshot。 */
export async function copyBuildSnapshot(
  repositoryRoot: string,
  destination: string,
  manifest: InputManifest,
  options: InputScanOptions = {},
): Promise<void> {
  checkCancelled(options.signal);
  const root = resolve(repositoryRoot);
  const snapshot = resolve(destination);
  const snapshotKey = relative(root, snapshot);
  if (!isBuildSnapshotResource(root, snapshotKey))
    throw new BuildInputError(
      'INVALID_SNAPSHOT_DESTINATION',
      '快照只能寫入本工作區的私有建置目錄。',
    );
  await safePath(root, snapshotKey);
  await mkdir(snapshot, { mode: 0o700 });
  for (const entry of manifest.entries) {
    checkCancelled(options.signal);
    const output = await safePath(snapshot, entry.path);
    if (entry.kind === 'directory') {
      await mkdir(output, { recursive: true, mode: 0o700 });
      continue;
    }
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const source = await open(
      await safePath(root, entry.path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let target;
    try {
      if (!(await source.stat()).isFile()) throw changed();
      target = await open(
        output,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        entry.executable ? 0o700 : 0o600,
      );
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const value of source.createReadStream({ autoClose: false })) {
        checkCancelled(options.signal);
        const chunk = value as Buffer;
        bytes += chunk.length;
        if (bytes > entry.byteSize) throw changed();
        hash.update(chunk);
        await target.writeFile(chunk);
      }
      if (bytes !== entry.byteSize || hash.digest('hex') !== entry.sha256)
        throw changed();
      await target.sync();
    } finally {
      await target?.close();
      await source.close();
    }
  }
  const copied = await scanBuildInputs(snapshot, options);
  const live = await scanBuildInputs(root, options);
  if (
    copied.revision !== manifest.revision ||
    live.revision !== manifest.revision
  )
    throw changed();
  for (const entry of [...manifest.entries].reverse())
    if (entry.kind === 'directory')
      await syncDirectory(resolve(snapshot, entry.path));
  await syncDirectory(snapshot);
  await syncDirectory(dirname(snapshot));
}
