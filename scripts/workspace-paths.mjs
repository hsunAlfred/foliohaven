import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

export const PRIVATE_DIRECTORY_NAMES = Object.freeze([
  '.foliohaven',
  '.alfred',
]);
const activeDirectories = new Map();

/** Select an existing private root before any bootstrap writes. Never merge roots. */
function discoverPrivateDirectory(repositoryRoot) {
  for (const name of PRIVATE_DIRECTORY_NAMES) {
    let stat;
    try {
      stat = lstatSync(resolve(repositoryRoot, name));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Object.assign(
        new Error('私有資料目錄必須是一般目錄，不可為符號連結。'),
        {
          code: 'PRIVATE_DIRECTORY_INVALID',
        },
      );
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw Object.assign(
        new Error('私有資料目錄必須由目前帳號擁有且僅允許擁有者存取。'),
        {
          code: 'PRIVATE_DIRECTORY_PERMISSIONS',
        },
      );
    return name;
  }
  return '.foliohaven';
}

export function privateDirectoryName(repositoryRoot) {
  const selected = discoverPrivateDirectory(repositoryRoot);
  const active = activeDirectories.get(resolve(repositoryRoot));
  if (active && active.name !== selected)
    throw Object.assign(
      new Error('工作區使用中，私有資料目錄已變更；請停止工作後重新啟動。'),
      {
        code: 'PRIVATE_DIRECTORY_CHANGED',
      },
    );
  return selected;
}

/** Guard active leases without caching choices across completed sessions. */
export function pinPrivateDirectory(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const name = privateDirectoryName(root);
  const active = activeDirectories.get(root) ?? { name, count: 0 };
  active.count++;
  activeDirectories.set(root, active);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.count--;
    if (active.count === 0) activeDirectories.delete(root);
  };
}

/** Return a workspace-relative resource below the selected private root. */
export function privateResource(repositoryRoot, resource = '') {
  if (
    typeof resource !== 'string' ||
    resource.includes('\\') ||
    /\p{Cc}/u.test(resource) ||
    (resource !== '' &&
      resource
        .split('/')
        .some((part) => !part || part === '.' || part === '..'))
  )
    throw Object.assign(new Error('私有資源路徑無效。'), {
      code: 'PRIVATE_RESOURCE_INVALID',
    });
  const name = privateDirectoryName(repositoryRoot);
  return resource ? `${name}/${resource}` : name;
}

/** New environment names win even when empty; callers validate the selected value. */
export function compatibleEnvironment(name, environment = process.env) {
  if (!/^FOLIOHAVEN_[A-Z0-9_]+$/u.test(name))
    throw new TypeError('環境變數名稱無效。');
  return environment[name] !== undefined
    ? environment[name]
    : environment[name.replace(/^FOLIOHAVEN_/u, 'ALFRED_')];
}

export function isBuildSnapshotResource(repositoryRoot, resource) {
  return (
    resource.startsWith(`${privateDirectoryName(repositoryRoot)}/`) &&
    /^\.(?:foliohaven|alfred)\/builds\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/snapshot$/u.test(
      resource,
    )
  );
}
