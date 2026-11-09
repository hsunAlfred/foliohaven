import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 只修正本帳號的專案私有目錄，不讀取內容或追蹤symlink。
 * @param {string} repositoryRoot
 * @param {string} resource
 * @returns {string}
 */
export function ensurePrivateDirectory(repositoryRoot, resource) {
  if (!/^\.(?:foliohaven|alfred)(?:\/[a-zA-Z0-9_-]+)*$/.test(resource))
    throw new Error('私有工具目錄識別無效。');
  let current = repositoryRoot;
  for (const segment of resource.split('/')) {
    current = join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    }
    const stat = lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.()
    )
      throw new Error(
        '私有工具目錄必須由目前非root帳號擁有，且不可為符號連結。',
      );
    if ((stat.mode & 0o077) !== 0) chmodSync(current, 0o700);
  }
  return current;
}
