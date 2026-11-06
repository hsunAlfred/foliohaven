import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const product = 'foliohaven';
const ignoredNames = new Set([
  '.git',
  '.codex',
  '.ssh',
  '.alfred',
  'node_modules',
  'dist',
  'coverage',
  '.astro',
  '.vite',
  '.cache',
  '.pnpm-store',
  '.wrangler',
  '__pycache__',
  'playwright-report',
  'test-results',
  '.vscode',
  '.DS_Store',
]);

export class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseError(code, message);
}

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function safeRelative(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    ![...path].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

async function sourceStat(root, path) {
  let current = root;
  let stat;
  for (const part of path.split('/')) {
    current = join(current, part);
    stat = await statIfPresent(current);
    if (!stat) return undefined;
    if (stat.isSymbolicLink())
      fail('RELEASE_SOURCE_INVALID', `公開來源不得含符號連結：${path}。`);
  }
  return stat;
}

function excluded(path) {
  if (
    path === 'cloudflare.config.json' ||
    path === 'scripts/maintainer' ||
    path.startsWith('scripts/maintainer/') ||
    path === 'tests/maintainer' ||
    path.startsWith('tests/maintainer/') ||
    path === 'docs/deployment/bulk-redirects' ||
    path.startsWith('docs/deployment/bulk-redirects/') ||
    path === 'docs/development' ||
    path.startsWith('docs/development/')
  )
    return true;
  return path
    .split('/')
    .some(
      (part) =>
        ignoredNames.has(part) ||
        (part.startsWith('.env') &&
          part !== '.env.example' &&
          path !== '.env.cloudflare.example') ||
        /\.(?:pem|key|pyc|log|pid|tsbuildinfo|swp|swo)$/iu.test(part) ||
        part.startsWith('.devcontainer-write-check.'),
    );
}

async function jsonFile(path, label) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('RELEASE_SOURCE_INVALID', `無法讀取有效的${label}。`);
  }
}

async function policyFor(root) {
  await sourceStat(root, 'release/manifest.json');
  const policy = await jsonFile(
    join(root, 'release/manifest.json'),
    '發行規則',
  );
  if (
    !policy ||
    typeof policy !== 'object' ||
    policy.format !== 1 ||
    !['rootFiles', 'directories', 'requiredFiles'].every(
      (key) =>
        Array.isArray(policy[key]) &&
        policy[key].length > 0 &&
        policy[key].every(safeRelative),
    ) ||
    !safeRelative(policy.devcontainerTemplate) ||
    !safeRelative(policy.githubTemplate)
  )
    fail('RELEASE_SOURCE_INVALID', '發行規則格式不正確。');
  return policy;
}

function versionOf(manifest) {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    typeof manifest.version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/iu.test(
      manifest.version,
    )
  )
    fail('RELEASE_SOURCE_INVALID', 'package.json 必須提供有效的版本號。');
  return manifest.version;
}

async function assertNoSymlinkAncestors(path) {
  let current = resolve(path);
  for (;;) {
    const stat = await statIfPresent(current);
    if (stat?.isSymbolicLink())
      fail('RELEASE_DESTINATION_INVALID', '輸出路徑不得經過符號連結。');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function prepareDestination(sourceRoot, destination) {
  const target = resolve(destination);
  await assertNoSymlinkAncestors(target);
  const fromSource = relative(sourceRoot, target);
  const fromTarget = relative(target, sourceRoot);
  if (
    fromSource === '' ||
    (!fromTarget.startsWith(`..${sep}`) && fromTarget !== '..') ||
    (!fromSource.startsWith(`..${sep}`) &&
      fromSource !== '..' &&
      fromSource.split(sep)[0] !== '.alfred')
  )
    fail(
      'RELEASE_DESTINATION_INVALID',
      '請使用專案外的空目錄，或專案內 .alfred/ 下的新目錄。',
    );
  const stat = await statIfPresent(target);
  if (stat && (!stat.isDirectory() || (await readdir(target)).length > 0))
    fail('RELEASE_DESTINATION_INVALID', '輸出目錄必須為新目錄或空目錄。');
  await mkdir(target, { recursive: true, mode: 0o700 });
  return target;
}

async function withSource(sourceRoot, operation) {
  const input = resolve(sourceRoot);
  const stat = await statIfPresent(input);
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    fail('RELEASE_SOURCE_INVALID', '來源必須為可讀取的專案目錄。');
  const root = await realpath(input);
  if (!(await statIfPresent(join(root, '.git')))) return operation(root, root);
  let temporary;
  try {
    const status = await execute(
      'git',
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
      ],
      { cwd: root, maxBuffer: 4 * 1024 * 1024 },
    );
    if (status.stdout.trim())
      fail('RELEASE_GIT_DIRTY', 'Git 來源含未提交變更，請先完成檢查與提交。');
    const revision = (
      await execute('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
        cwd: root,
      })
    ).stdout.trim();
    temporary = await mkdtemp(join(tmpdir(), 'alfred-release-source-'));
    const snapshot = join(temporary, 'source');
    const archive = join(temporary, 'source.tar');
    await mkdir(snapshot, { mode: 0o700 });
    await execute(
      'git',
      [
        '--no-optional-locks',
        'archive',
        '--format=tar',
        `--output=${archive}`,
        revision,
      ],
      { cwd: root },
    );
    await execute('tar', [
      '-xf',
      archive,
      '-C',
      snapshot,
      '--no-same-owner',
      '--same-permissions',
    ]);
    const [afterStatus, afterRevision] = await Promise.all([
      execute(
        'git',
        [
          '--no-optional-locks',
          'status',
          '--porcelain=v1',
          '--untracked-files=normal',
        ],
        { cwd: root },
      ),
      execute('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
        cwd: root,
      }),
    ]);
    if (afterStatus.stdout.trim() || afterRevision.stdout.trim() !== revision)
      fail('RELEASE_GIT_DIRTY', '匯出期間 Git 來源改變，請停止修改後重試。');
    return await operation(snapshot, root);
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    fail(
      'RELEASE_SOURCE_INVALID',
      '無法建立 Git 來源快照；請檢查 Git 與 tar 工具。',
    );
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function copyPublicSource(root, destination) {
  const policy = await policyFor(root);
  await sourceStat(root, 'package.json');
  const version = versionOf(
    await jsonFile(join(root, 'package.json'), '套件設定'),
  );
  const files = [];
  const copied = new Set();

  async function ensureOutputDirectory(path) {
    if (await statIfPresent(path)) return;
    await ensureOutputDirectory(dirname(path));
    await mkdir(path, { mode: 0o755 });
    await chmod(path, 0o755);
  }

  async function copyEntry(sourcePath, outputPath) {
    if (excluded(outputPath) || copied.has(outputPath)) return;
    const input = join(root, sourcePath);
    const stat = await sourceStat(root, sourcePath);
    if (!stat) return;
    if (stat.isSymbolicLink())
      fail('RELEASE_SOURCE_INVALID', `公開來源不得含符號連結：${outputPath}。`);
    const output = join(destination, outputPath);
    if (stat.isDirectory()) {
      await ensureOutputDirectory(output);
      await chmod(output, stat.mode & 0o777);
      for (const name of (await readdir(input)).sort())
        await copyEntry(`${sourcePath}/${name}`, `${outputPath}/${name}`);
      return;
    }
    if (!stat.isFile())
      fail(
        'RELEASE_SOURCE_INVALID',
        `公開來源含不支援的檔案類型：${outputPath}。`,
      );
    await ensureOutputDirectory(dirname(output));
    await copyFile(input, output, constants.COPYFILE_EXCL);
    await chmod(output, stat.mode & 0o777);
    const bytes = await readFile(output);
    files.push({
      path: outputPath,
      bytes: bytes.length,
      mode: (stat.mode & 0o777).toString(8).padStart(3, '0'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    copied.add(outputPath);
  }

  for (const path of [...policy.rootFiles, ...policy.directories]) {
    if (path === '.devcontainer' || path.startsWith('.devcontainer/'))
      fail(
        'RELEASE_SOURCE_INVALID',
        '發行規則不得直接納入個人 Dev Container。',
      );
    await copyEntry(path, path);
  }

  const existingInfo = await sourceStat(root, 'release-info.json');
  let template = policy.devcontainerTemplate;
  if (existingInfo) {
    const info = await jsonFile(
      join(root, 'release-info.json'),
      '公開來源資訊',
    );
    if (
      !info ||
      typeof info !== 'object' ||
      info.format !== 1 ||
      info.product !== product ||
      typeof info.version !== 'string'
    )
      fail('RELEASE_SOURCE_INVALID', '公開來源資訊格式不正確。');
    template = '.devcontainer';
  }
  for (const name of [
    'devcontainer.json',
    'docker-compose.yml',
    'check-environment.sh',
  ]) {
    const sourcePath = `${template}/${name}`;
    const stat = await sourceStat(root, sourcePath);
    if (!stat?.isFile() || stat.isSymbolicLink())
      fail('RELEASE_SOURCE_INVALID', '公開 Dev Container 設定不完整。');
  }
  await copyEntry(template, '.devcontainer');
  const githubTemplate = existingInfo ? '.github' : policy.githubTemplate;
  const publicWorkflow = `${githubTemplate}/workflows/check.yml`;
  const workflowStat = await sourceStat(root, publicWorkflow);
  if (!workflowStat?.isFile() || workflowStat.isSymbolicLink())
    fail('RELEASE_SOURCE_INVALID', '公開 CI 設定不完整。');
  await copyEntry(publicWorkflow, '.github/workflows/check.yml');
  for (const path of policy.requiredFiles) {
    if (!copied.has(path))
      fail('RELEASE_SOURCE_INVALID', `缺少必要的公開檔案：${path}。`);
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const info = { format: 1, product, version, files };
  await writeFile(
    join(destination, 'release-info.json'),
    `${JSON.stringify(info, null, 2)}\n`,
    {
      flag: 'wx',
      mode: 0o644,
    },
  );
  await chmod(join(destination, 'release-info.json'), 0o644);
  return { destination, version, fileCount: files.length + 1 };
}

export async function exportReleaseWorkspace({ sourceRoot, destination }) {
  return withSource(sourceRoot, async (root, originalRoot) => {
    const target = await prepareDestination(originalRoot, destination);
    return copyPublicSource(root, target);
  });
}

export async function packageRelease({ sourceRoot, destination }) {
  return withSource(sourceRoot, async (root, originalRoot) => {
    const target = await prepareDestination(originalRoot, destination);
    const source = join(target, 'source');
    await mkdir(source, { mode: 0o755 });
    await chmod(source, 0o755);
    const result = await copyPublicSource(root, source);
    const archiveName = `${product}-${result.version}-source.tar.gz`;
    const archive = join(target, archiveName);
    await execute('tar', [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      archive,
      '-C',
      source,
      '.',
    ]);
    const sha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    await writeFile(join(target, 'SHA256SUMS'), `${sha256}  ${archiveName}\n`, {
      flag: 'wx',
      mode: 0o644,
    });
    await chmod(join(target, 'SHA256SUMS'), 0o644);
    return {
      ...result,
      destination: target,
      source,
      archive: archiveName,
      sha256,
    };
  });
}
