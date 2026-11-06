import { constants } from 'node:fs';
import { lstat, mkdir, open, rm, statfs } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { CloudflareError, cancelled } from './errors.mjs';

function unsafeCharacters(value) {
  return [...value].some(
    (character) =>
      character === '\\' ||
      character.charCodeAt(0) <= 31 ||
      character.charCodeAt(0) === 127,
  );
}

export function safeKey(value) {
  return (
    typeof value === 'string' &&
    /^(assets|media)\//u.test(value) &&
    Buffer.byteLength(value) <= 1024 &&
    !unsafeCharacters(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

export async function localPath(root, relative, create = false) {
  if (
    typeof relative !== 'string' ||
    relative
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    unsafeCharacters(relative) ||
    resolve(root, relative) === resolve(root)
  )
    throw new CloudflareError('R2_LOCAL_PATH_INVALID', '媒體副本路徑無效。');
  let current = resolve(root);
  const base = await lstat(current);
  if (
    !base.isDirectory() ||
    base.isSymbolicLink() ||
    base.uid !== process.getuid?.()
  )
    throw new CloudflareError(
      'R2_LOCAL_PATH_INVALID',
      '部署副本必須是目前帳號的一般目錄。',
    );
  const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const stat = await lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.()
    )
      throw new CloudflareError(
        'R2_LOCAL_PATH_INVALID',
        '媒體副本不接受符號連結或其他帳號的目錄。',
      );
  }
  return join(current, parts.at(-1));
}

export async function inspectFile(root, relative, signal) {
  cancelled(signal);
  const path = await localPath(root, relative);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new CloudflareError(
        'R2_LOCAL_FILE_INVALID',
        '媒體副本必須是一般檔案。',
      );
    const sha = createHash('sha256');
    const md5 = createHash('md5');
    let byteSize = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      cancelled(signal);
      sha.update(bytes);
      md5.update(bytes);
      byteSize += bytes.length;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStat(before, after) || BigInt(byteSize) !== before.size)
      throw new CloudflareError(
        'R2_LOCAL_FILE_CHANGED',
        '媒體副本在檢查期間改變，請重新建立部署。',
      );
    return {
      byteSize,
      sha256: sha.digest('hex'),
      md5: md5.digest('base64'),
      stat: before,
    };
  } finally {
    await handle.close();
  }
}

function sameStat(a, b) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(
    (field) => a[field] === b[field],
  );
}

export async function fileBody(root, relative, expected, progress, signal) {
  const path = await localPath(root, relative);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size !== BigInt(expected.byteSize)) {
    await handle.close();
    throw new CloudflareError('R2_LOCAL_FILE_CHANGED', '媒體副本大小已改變。');
  }
  const hash = createHash('sha256');
  let size = 0;
  const source = handle.createReadStream({ autoClose: false });
  const stream = source.pipe(
    new Transform({
      transform(bytes, _encoding, callback) {
        try {
          cancelled(signal);
          hash.update(bytes);
          size += bytes.length;
          progress?.(bytes.length);
          callback(null, bytes);
        } catch (error) {
          callback(error);
        }
      },
    }),
  );
  source.on('error', (error) => stream.destroy(error));
  const finish = async () => {
    const after = await handle.stat({ bigint: true });
    if (
      !sameStat(before, after) ||
      size !== expected.byteSize ||
      hash.digest('hex') !== expected.sha256
    )
      throw new CloudflareError(
        'R2_LOCAL_FILE_CHANGED',
        '上傳中的媒體副本改變，請保留紀錄並檢查遠端結果。',
        { unknown: true },
      );
  };
  return {
    stream,
    finish,
    close: async () => {
      source.destroy();
      stream.destroy();
      await handle.close();
    },
  };
}

export async function availableBytes(root) {
  const value = await statfs(root, { bigint: true });
  return value.bavail * value.bsize;
}

export async function saveBackup(
  root,
  relative,
  body,
  expected,
  progress,
  signal,
) {
  const destination = await localPath(root, relative, true);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  let completed = false;
  const hash = createHash('sha256');
  let byteSize = 0;
  try {
    for await (const bytes of body) {
      cancelled(signal);
      const buffer = Buffer.from(bytes);
      hash.update(buffer);
      byteSize += buffer.length;
      if (byteSize > expected.byteSize)
        throw new CloudflareError(
          'R2_BACKUP_CHANGED',
          '遠端媒體大小在備份期間改變。',
        );
      let offset = 0;
      while (offset < buffer.length)
        offset += (await handle.write(buffer, offset)).bytesWritten;
      progress?.(buffer.length);
    }
    const sha256 = hash.digest('hex');
    if (
      byteSize !== expected.byteSize ||
      (expected.sha256 && sha256 !== expected.sha256)
    )
      throw new CloudflareError(
        'R2_BACKUP_CHANGED',
        '媒體備份內容與遠端基底不符。',
      );
    await handle.sync();
    await handle.close();
    // link does not replace an existing backup, including a symlink.
    const { link } = await import('node:fs/promises');
    await link(temporary, destination);
    await rm(temporary);
    const directory = await open(
      dirname(destination),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    completed = true;
    return { path: relative, byteSize, sha256 };
  } finally {
    if (!completed) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }
}
