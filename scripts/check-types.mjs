import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedProcess } from './managed-process.mjs';
import { ensurePrivateDirectory } from './private-directory.mjs';
import { privateResource } from './workspace-paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [target, ...extra] = process.argv.slice(2);
let child;
let stopping = false;
const stop = () => {
  stopping = true;
  void child?.stop();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  if (extra.length || !['tools', 'studio', 'site'].includes(target))
    throw new Error('TYPECHECK_ARGUMENT_INVALID');
  const cache = ensurePrivateDirectory(
    root,
    privateResource(root, 'cache/typescript'),
  );
  const buildInfo = resolve(cache, `${target}.tsbuildinfo`);
  let args;
  if (target === 'site') {
    const sourceConfig = resolve(root, 'site/tsconfig.json');
    const source = JSON.parse(await readFile(sourceConfig, 'utf8'));
    const config = resolve(cache, 'site.tsconfig.json');
    const temporary = `${config}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        extends: sourceConfig,
        compilerOptions: { tsBuildInfoFile: buildInfo },
        references: source.references.map(({ path }) => ({
          path: resolve(root, 'site', path),
        })),
      }),
      { mode: 0o600, flag: 'wx' },
    );
    await rename(temporary, config);
    args = [
      '--filter',
      '@foliohaven/site',
      'exec',
      'astro',
      'check',
      '--tsconfig',
      config,
    ];
  } else {
    const config =
      target === 'tools' ? 'tsconfig.tools.json' : 'studio/tsconfig.json';
    args = ['exec', 'tsc', '-p', config, '--tsBuildInfoFile', buildInfo];
  }
  if (stopping) throw new Error('TYPECHECK_CANCELLED');
  child = managedProcess('pnpm', args, { cwd: root });
  const result = await child.done;
  process.exitCode = stopping ? 130 : (result.code ?? 1);
} catch {
  process.stderr.write(
    stopping
      ? 'TYPECHECK_CANCELLED：型別檢查已停止。\n'
      : 'TYPECHECK_FAILED：型別檢查未完成，請確認設定與私有目錄權限。\n',
  );
  process.exitCode = stopping ? 130 : 1;
} finally {
  await child?.stop();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
