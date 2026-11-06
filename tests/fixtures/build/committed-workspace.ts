import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  lstat,
  open,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runControlledProcess } from '../../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../../server/src/runtime/environment.js';
import { scanBuildInputs } from '../../../server/src/build/inputs.js';
import { safePath, isMissing } from '../../../server/src/files/io.js';

/** Docker context不含Git；以相同正式輸入manifest建立可重驗的穩定基底。 */
async function copySourceContext(repository: string, root: string) {
  const before = await scanBuildInputs(repository);
  for (const entry of before.entries) {
    const target = join(root, entry.path);
    if (entry.kind === 'directory') {
      await mkdir(target, { recursive: true, mode: 0o700 });
      continue;
    }
    const input = await open(
      await safePath(repository, entry.path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await input.stat()).isFile())
        throw new Error('Fixture source must be a regular file');
      const bytes = await input.readFile();
      if (
        bytes.length !== entry.byteSize ||
        createHash('sha256').update(bytes).digest('hex') !== entry.sha256
      )
        throw new Error('Fixture source changed while copying');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, {
        flag: 'wx',
        mode: entry.executable ? 0o700 : 0o600,
      });
    } finally {
      await input.close();
    }
  }
  if (
    (await scanBuildInputs(repository)).revision !== before.revision ||
    (await scanBuildInputs(root)).revision !== before.revision
  )
    throw new Error('Fixture source context is not a stable complete copy');
}

/** 唯讀Git物件建立穩定沙箱；不含未提交檔、live node_modules或Git狀態。 */
export async function committedWorkspace(sourceRoot?: string): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const repository =
    sourceRoot ?? fileURLToPath(new URL('../../../', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'alfred-committed-workspace-'));
  try {
    let hasGit = true;
    try {
      await lstat(join(repository, '.git'));
    } catch (error) {
      if (!isMissing(error)) throw error;
      hasGit = false;
    }
    if (!hasGit) {
      await copySourceContext(repository, root);
      return {
        root,
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    }
    const common = {
      command: 'git',
      cwd: repository,
      env: buildProcessEnvironment(),
      timeoutMs: 30_000,
    };
    const listing = await runControlledProcess({
      ...common,
      args: [
        '--no-optional-locks',
        'ls-tree',
        '-r',
        '-z',
        '--full-tree',
        'HEAD',
      ],
    });
    const entries = listing.stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/su.exec(
          line,
        );
        if (
          !match?.[1] ||
          !match[2] ||
          !match[3] ||
          match[3]
            .split('/')
            .some((part) => part === '..' || part === '.' || part === '')
        )
          throw new Error(
            'Committed workspace contains an unsupported fixture entry',
          );
        return {
          executable: match[1] === '100755',
          sha: match[2],
          path: match[3],
        };
      });
    const objects = await runControlledProcess({
      ...common,
      args: ['--no-optional-locks', 'cat-file', '--batch'],
      input: Buffer.from(entries.map((entry) => entry.sha).join('\n') + '\n'),
      maxOutputBytes: 128 * 1024 * 1024,
    });
    let offset = 0;
    for (const entry of entries) {
      const end = objects.stdout.indexOf(10, offset);
      if (end === -1)
        throw new Error('Fixture Git object header is incomplete');
      const header = objects.stdout
        .subarray(offset, end)
        .toString('ascii')
        .split(' ');
      const size = Number(header[2]);
      if (
        header[0] !== entry.sha ||
        header[1] !== 'blob' ||
        !Number.isSafeInteger(size) ||
        size < 0
      )
        throw new Error('Fixture Git object does not match its tree');
      offset = end + 1;
      if (
        offset + size >= objects.stdout.length ||
        objects.stdout[offset + size] !== 10
      )
        throw new Error('Fixture Git object content is incomplete');
      const path = join(root, entry.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, objects.stdout.subarray(offset, offset + size), {
        flag: 'wx',
        mode: entry.executable ? 0o700 : 0o600,
      });
      await chmod(path, entry.executable ? 0o700 : 0o600);
      offset += size + 1;
    }
    if (offset !== objects.stdout.length)
      throw new Error('Fixture Git object stream has unexpected trailing data');
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
