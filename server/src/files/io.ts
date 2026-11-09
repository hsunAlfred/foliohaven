import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  privateResource as workspaceResource,
  privateDirectoryName as workspaceDirectory,
  isBuildSnapshotResource as workspaceSnapshot,
  pinPrivateDirectory as pinWorkspace,
} from '../../../scripts/workspace-paths.mjs';

export class RepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly etag?: string,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}
function privateDirectoryValue<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      [
        'PRIVATE_DIRECTORY_INVALID',
        'PRIVATE_DIRECTORY_PERMISSIONS',
        'PRIVATE_DIRECTORY_CHANGED',
        'PRIVATE_RESOURCE_INVALID',
      ].includes(String(error.code))
    )
      throw new RepositoryError(String(error.code), error.message);
    throw error;
  }
}
export function privateDirectoryName(root: string): '.foliohaven' | '.alfred' {
  return privateDirectoryValue(() => workspaceDirectory(root));
}
export function privateResource(root: string, resource = ''): string {
  return privateDirectoryValue(() => workspaceResource(root, resource));
}
export function isBuildSnapshotResource(
  root: string,
  resource: string,
): boolean {
  return privateDirectoryValue(() => workspaceSnapshot(root, resource));
}
export function pinPrivateDirectory(root: string): () => void {
  return privateDirectoryValue(() => pinWorkspace(root));
}
export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function stableHash(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value)));
}
export function representationEtag(rawEtag: string, value: unknown): string {
  return `"${stableHash([rawEtag, value])}"`;
}
export function requireEtagMatch(
  ifMatch: string | undefined,
  current: string,
): void {
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
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function safeRelative(resource: string): boolean {
  return (
    resource.length > 0 &&
    !isAbsolute(resource) &&
    !/[\\\0]/u.test(resource) &&
    resource
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
/** 私有檔與受控資源共用祖先檢查；呼叫者仍須先驗證資源白名單。 */
export async function safePath(
  root: string,
  resource: string,
): Promise<string> {
  if (!safeRelative(resource))
    throw new RepositoryError(
      'INVALID_RESOURCE_KEY',
      '資源識別不符合安全規則。',
      400,
    );
  const target = resolve(root, resource);
  const within = relative(root, target);
  if (within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within))
    throw new RepositoryError('INVALID_RESOURCE_KEY', '資源超出工作區。', 400);
  let current = root;
  for (const part of ['', ...resource.split('/')]) {
    if (part) current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new RepositoryError(
          'RESOURCE_SYMLINK',
          '來源與私有資料不得使用符號連結。',
          409,
        );
      if (current !== target && !stat.isDirectory())
        throw new RepositoryError(
          'RESOURCE_NOT_DIRECTORY',
          '資源祖先必須是一般目錄。',
          409,
        );
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
  return target;
}
export async function safeMkdir(root: string, resource: string): Promise<void> {
  let prefix = '';
  for (const part of resource.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const target = await safePath(root, prefix);
    try {
      await mkdir(target, { mode: 0o700 });
      await syncDirectory(dirname(target));
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
      if (!(await lstat(target)).isDirectory())
        throw new RepositoryError(
          'RESOURCE_NOT_DIRECTORY',
          '資源必須是一般目錄。',
        );
      if (
        /^(?:\.foliohaven|\.alfred)(?:\/|$)/u.test(prefix) &&
        ((await lstat(target)).mode & 0o077) !== 0
      )
        throw new RepositoryError(
          'PRIVATE_DIRECTORY_PERMISSIONS',
          '私有資料目錄僅允許擁有者存取，請修正權限。',
        );
    }
  }
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function durableBytes(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}
export async function atomicJson(
  root: string,
  resource: string,
  value: unknown,
): Promise<void> {
  const target = await safePath(root, resource);
  const temp = `${target}.${randomUUID()}.tmp`;
  await durableBytes(temp, Buffer.from(`${JSON.stringify(value)}\n`));
  await rename(temp, target);
  await syncDirectory(dirname(target));
}
export async function readJson(
  root: string,
  resource: string,
): Promise<unknown> {
  const path = await safePath(root, resource);
  const bytes = await readOptional(path, 64 * 1024 * 1024);
  if (bytes === null)
    throw Object.assign(new Error('私有資料不存在。'), { code: 'ENOENT' });
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new RepositoryError(
      'INVALID_PRIVATE_JSON',
      '私有資料必須是有效的 UTF-8 JSON。',
    );
  }
}
export async function readOptional(
  path: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new RepositoryError('RESOURCE_NOT_FILE', '來源必須是一般檔案。');
    if (stat.size > maxBytes)
      throw new RepositoryError(
        'SOURCE_TOO_LARGE',
        '來源檔案超過允許大小。',
        422,
      );
    const chunks: Buffer[] = [];
    let byteSize = 0;
    while (byteSize <= maxBytes) {
      const bytes = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - byteSize));
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength);
      if (bytesRead === 0) break;
      byteSize += bytesRead;
      chunks.push(bytes.subarray(0, bytesRead));
    }
    if (byteSize > maxBytes)
      throw new RepositoryError(
        'SOURCE_TOO_LARGE',
        '來源檔案超過允許大小。',
        422,
      );
    return Buffer.concat(chunks, byteSize);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
export async function hashFile(path: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      throw new RepositoryError('RESOURCE_NOT_FILE', '來源必須是一般檔案。');
    }
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
export async function copyDurable(
  source: string,
  destination: string,
): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const handle = await open(
    destination,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(destination));
}
