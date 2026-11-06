import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CloudflareError, cancelled } from './errors.mjs';

export const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const digestPattern = /^[a-f0-9]{64}$/;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}
export const digest = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(canonical(value)),
    )
    .digest('hex');

export const hasControl = (value) =>
  [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

export function validPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    !hasControl(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

export async function safePath(root, resource) {
  if (!validPath(resource))
    throw new CloudflareError(
      'CLOUDFLARE_PATH_INVALID',
      '資源路徑不符合規則。',
    );
  const full = resolve(root, resource);
  const within = relative(root, full);
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`))
    throw new CloudflareError(
      'CLOUDFLARE_PATH_INVALID',
      '資源路徑超出部署範圍。',
    );
  let current = root;
  for (const part of ['', ...resource.split('/')]) {
    if (part) current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (current !== full && !stat.isDirectory()))
        throw new CloudflareError(
          'CLOUDFLARE_PATH_INVALID',
          '資源與私有資料不得使用符號連結。',
        );
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return full;
}

export async function privateDirectory(root, resource) {
  let prefix = '';
  for (const part of resource.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const full = await safePath(root, prefix);
    try {
      await mkdir(full, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await lstat(full);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new CloudflareError(
        'CLOUDFLARE_PERMISSIONS',
        '部署私有目錄須由目前帳號擁有且僅擁有者可存取。',
      );
  }
  return safePath(root, resource);
}

export async function syncDirectory(path) {
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

export async function readOwnerFile(root, resource, maxBytes = 32768) {
  const path = await safePath(root, resource);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > maxBytes
    )
      throw new CloudflareError(
        'CLOUDFLARE_PERMISSIONS',
        '設定及紀錄須為目前帳號擁有的私有一般檔案，且不可超過容量限制。',
      );
    const text = await handle.readFile('utf8');
    const after = await handle.stat();
    if (
      stat.ino !== after.ino ||
      stat.dev !== after.dev ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs ||
      Buffer.byteLength(text) !== stat.size
    )
      throw new CloudflareError(
        'CLOUDFLARE_CONFIG_CHANGED',
        '設定或紀錄在讀取期間改變，請完成保存後重試。',
      );
    if (Buffer.byteLength(text) > maxBytes)
      throw new CloudflareError(
        'CLOUDFLARE_CONFIG_INVALID',
        '設定或紀錄超過容量限制。',
      );
    return text;
  } catch (error) {
    if (error instanceof CloudflareError) throw error;
    throw new CloudflareError(
      'CLOUDFLARE_FILE_UNAVAILABLE',
      '無法讀取必要設定或紀錄；請檢查檔案是否存在及權限。',
    );
  } finally {
    await handle?.close();
  }
}

export async function atomicJson(root, resource, value) {
  const path = await safePath(root, resource);
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
    await rm(temp, { force: true });
  }
}

export async function hashFile(root, resource, signal) {
  const handle = await open(
    await safePath(root, resource),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new CloudflareError(
        'CLOUDFLARE_SOURCE_INVALID',
        '部署來源須為一般檔案。',
      );
    const hash = createHash('sha256');
    let byteSize = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      cancelled(signal);
      hash.update(chunk);
      byteSize += chunk.length;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.size !== BigInt(byteSize)
    )
      throw new CloudflareError(
        'CLOUDFLARE_SOURCE_CHANGED',
        '部署副本已變更；停止使用這份產物。',
      );
    return { sha256: hash.digest('hex'), byteSize };
  } finally {
    await handle.close();
  }
}
