import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { asciiCompare } from '@foliohaven/core';
import {
  copyDurable,
  isMissing,
  record,
  RepositoryError,
  safeMkdir,
  safePath,
  safeRelative,
  stableHash,
  syncDirectory,
} from '../../files/io.js';
import type { ArtifactEntry, ArtifactManifest } from './types.js';

export class ArtifactError extends RepositoryError {
  constructor(code: string, message: string, status = 409, etag?: string) {
    super(code, message, status, etag);
    this.name = 'ArtifactError';
  }
}
export function checkArtifactCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ArtifactError('BUILD_CANCELLED', '建置已取消。');
}
function changed(): ArtifactError {
  return new ArtifactError(
    'BUILD_OUTPUT_CHANGED',
    '建置產物在驗證期間改變，請重新建置。',
  );
}
function hasControl(value: string): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
  );
}
export function artifactDigest(entries: readonly ArtifactEntry[]): string {
  return stableHash(entries);
}
export function parseArtifactManifest(value: unknown): ArtifactManifest {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.entries) ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    throw new ArtifactError(
      'BUILD_RECOVERY_REQUIRED',
      '產物清單無法判讀，請保留復原資料。',
    );
  const entries: ArtifactEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of value.entries as unknown[]) {
    if (
      !record(entry) ||
      typeof entry.path !== 'string' ||
      !safeRelative(entry.path) ||
      hasControl(entry.path)
    )
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '產物清單含無效資源識別。',
      );
    if (entry.kind === 'directory')
      entries.push({ path: entry.path, kind: 'directory' });
    else if (
      entry.kind === 'file' &&
      Number.isSafeInteger(entry.byteSize) &&
      Number(entry.byteSize) >= 0 &&
      typeof entry.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      entries.push({
        path: entry.path,
        kind: 'file',
        byteSize: Number(entry.byteSize),
        sha256: entry.sha256,
      });
      fileCount++;
      totalBytes += Number(entry.byteSize);
    } else
      throw new ArtifactError(
        'BUILD_RECOVERY_REQUIRED',
        '產物檔案清單不符合契約。',
      );
  }
  if (
    entries.some((entry, index) => {
      const previous = entries[index - 1];
      return (
        previous !== undefined && asciiCompare(previous.path, entry.path) >= 0
      );
    }) ||
    fileCount !== value.fileCount ||
    totalBytes !== value.totalBytes ||
    !Number.isSafeInteger(totalBytes) ||
    artifactDigest(entries) !== value.digest
  )
    throw new ArtifactError(
      'BUILD_RECOVERY_REQUIRED',
      '產物清單的排序、容量或雜湊不一致。',
    );
  return {
    schemaVersion: 1,
    entries,
    digest: value.digest,
    fileCount,
    totalBytes,
  };
}

/** 包含空目錄及完整檔名；所有檔案串流計算 hash，不把媒體載入記憶體。 */
export async function scanArtifactTree(
  root: string,
  resource: string,
  signal?: AbortSignal,
): Promise<ArtifactManifest | null> {
  checkArtifactCancelled(signal);
  const target = await safePath(root, resource);
  let rootStat: Stats;
  try {
    rootStat = await lstat(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new ArtifactError(
      'BUILD_RECOVERY_REQUIRED',
      '產物根目錄必須是一般目錄，不接受符號連結或檔案。',
    );
  const entries: ArtifactEntry[] = [];
  async function visit(path: string): Promise<void> {
    checkArtifactCancelled(signal);
    if (!safeRelative(path) || hasControl(path))
      throw new ArtifactError(
        'INVALID_BUILD_ARTIFACT',
        '產物檔名不符合安全規則。',
      );
    const full = await safePath(root, `${resource}/${path}`);
    const stat = await lstat(full);
    if (stat.dev !== rootStat.dev)
      throw new ArtifactError(
        'ARTIFACT_FILESYSTEM_MISMATCH',
        '產物樹不得跨越其他檔案系統。',
        503,
      );
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push({ path, kind: 'directory' });
      const names = (await readdir(full)).sort(asciiCompare);
      for (const name of names) await visit(`${path}/${name}`);
      if (
        JSON.stringify((await readdir(full)).sort(asciiCompare)) !==
        JSON.stringify(names)
      )
        throw changed();
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new ArtifactError(
        'INVALID_BUILD_ARTIFACT',
        '產物只接受一般檔案及目錄，不接受符號連結或裝置。',
      );
    const handle = await open(
      full,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw changed();
      const hash = createHash('sha256');
      let byteSize = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        checkArtifactCancelled(signal);
        const bytes = chunk as Buffer;
        byteSize += bytes.byteLength;
        hash.update(bytes);
      }
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== BigInt(byteSize) ||
        after.size !== before.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw changed();
      entries.push({
        path,
        kind: 'file',
        byteSize,
        sha256: hash.digest('hex'),
      });
    } finally {
      await handle.close();
    }
  }
  const names = (await readdir(target)).sort(asciiCompare);
  for (const name of names) await visit(name);
  if (
    JSON.stringify((await readdir(target)).sort(asciiCompare)) !==
    JSON.stringify(names)
  )
    throw changed();
  entries.sort((a, b) => asciiCompare(a.path, b.path));
  const files = entries.filter((entry) => entry.kind === 'file');
  return {
    schemaVersion: 1,
    digest: artifactDigest(entries),
    entries,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.byteSize, 0),
  };
}
export async function copyArtifactTree(
  root: string,
  source: string,
  destination: string,
  expected: ArtifactManifest,
  signal?: AbortSignal,
): Promise<void> {
  checkArtifactCancelled(signal);
  try {
    await lstat(await safePath(root, destination));
    throw new ArtifactError(
      'ARTIFACT_TARGET_EXISTS',
      '產物保留位置已存在，不覆蓋既有資料。',
    );
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await safeMkdir(root, destination);
  for (const entry of expected.entries) {
    checkArtifactCancelled(signal);
    if (entry.kind === 'directory')
      await safeMkdir(root, `${destination}/${entry.path}`);
    else {
      const directory = dirname(entry.path);
      if (directory !== '.')
        await safeMkdir(root, `${destination}/${directory}`);
      await copyDurable(
        await safePath(root, `${source}/${entry.path}`),
        await safePath(root, `${destination}/${entry.path}`),
      );
    }
  }
  checkArtifactCancelled(signal);
  if (
    (await scanArtifactTree(root, destination, signal))?.digest !==
      expected.digest ||
    (await scanArtifactTree(root, source, signal))?.digest !== expected.digest
  )
    throw changed();
  await syncDirectory(await safePath(root, destination));
}
export async function syncArtifactTree(
  root: string,
  resource: string,
  manifest: ArtifactManifest,
): Promise<void> {
  for (const entry of manifest.entries) {
    if (entry.kind === 'file') {
      const handle = await open(
        await safePath(root, `${resource}/${entry.path}`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  for (const entry of [...manifest.entries].reverse())
    if (entry.kind === 'directory')
      await syncDirectory(await safePath(root, `${resource}/${entry.path}`));
  await syncDirectory(await safePath(root, resource));
}
