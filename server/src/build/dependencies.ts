import { relative, resolve } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runControlledProcess } from '../runtime/process.js';
import { buildProcessEnvironment } from '../runtime/environment.js';
import { BuildInputError } from './inputs.js';
import { isMissing, safePath } from '../files/io.js';

export interface SnapshotDependencyOptions {
  readonly repositoryRoot: string;
  readonly snapshotRoot: string;
  readonly signal?: AbortSignal;
  readonly leaseFd?: number;
}
const dependencyFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/core/package.json',
  'packages/ui/package.json',
  'site/package.json',
  'studio/package.json',
  'server/package.json',
];

/** 本job私有node_modules及workspace links；不執行lifecycle、不回連registry。 */
export async function prepareSnapshotDependencies(
  options: SnapshotDependencyOptions,
): Promise<void> {
  const root = resolve(options.repositoryRoot);
  const snapshot = resolve(options.snapshotRoot);
  const key = relative(root, snapshot);
  if (
    !/^\.alfred\/builds\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/snapshot$/.test(
      key,
    )
  )
    throw new BuildInputError(
      'INVALID_SNAPSHOT_DESTINATION',
      '依賴只能建立於本job的私有快照。',
    );
  await safePath(root, key);
  try {
    await lstat(await safePath(snapshot, 'node_modules'));
    throw new BuildInputError(
      'SNAPSHOT_DEPENDENCIES_EXIST',
      '本job快照已存在依賴，不能沿用其他安裝結果。',
    );
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  async function hashes(): Promise<string> {
    const hash = createHash('sha256');
    for (const file of dependencyFiles) {
      hash
        .update(file)
        .update('\0')
        .update(await readFile(await safePath(snapshot, file)))
        .update('\0');
    }
    return hash.digest('hex');
  }
  const before = await hashes();
  await runControlledProcess({
    command: 'pnpm',
    args: [
      'install',
      '--offline',
      '--frozen-lockfile',
      '--prod=false',
      '--ignore-scripts',
    ],
    cwd: snapshot,
    env: buildProcessEnvironment({ NODE_ENV: 'development' }),
    timeoutMs: 15 * 60_000,
    ...(options.leaseFd !== undefined ? { passFds: [options.leaseFd] } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if ((await hashes()) !== before)
    throw new BuildInputError(
      'SNAPSHOT_DEPENDENCIES_CHANGED',
      '離線安裝改變了快照的manifest或lockfile。',
    );
  const workspaces: Readonly<Record<string, string>> = {
    '@foliohaven/core': 'packages/core',
    '@foliohaven/ui': 'packages/ui',
    '@foliohaven/site': 'site',
    '@foliohaven/studio': 'studio',
    '@foliohaven/server': 'server',
  };
  for (const manifestPath of dependencyFiles.filter((file) =>
    file.endsWith('package.json'),
  )) {
    const parsed: unknown = JSON.parse(
      await readFile(await safePath(snapshot, manifestPath), 'utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null)
      throw new BuildInputError(
        'SNAPSHOT_MANIFEST_INVALID',
        '套件manifest格式不正確。',
      );
    const manifest = parsed as Record<string, unknown>;
    for (const section of ['dependencies', 'devDependencies']) {
      const dependencies = manifest[section];
      if (typeof dependencies !== 'object' || dependencies === null) continue;
      for (const name of Object.keys(dependencies)) {
        const target = workspaces[name];
        if (!target) continue;
        const packageDirectory =
          manifestPath === 'package.json'
            ? snapshot
            : resolve(snapshot, manifestPath, '..');
        if (
          (await realpath(resolve(packageDirectory, 'node_modules', name))) !==
          (await realpath(resolve(snapshot, target)))
        )
          throw new BuildInputError(
            'SNAPSHOT_WORKSPACE_LINK_INVALID',
            '快照套件連結未指向本job來源。',
          );
      }
    }
  }
}
