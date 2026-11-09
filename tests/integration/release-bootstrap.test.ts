import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runControlledProcess } from '../../server/src/runtime/process.js';

const roots: string[] = [];
const repository = fileURLToPath(new URL('../../', import.meta.url));
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each(['fresh', 'legacy', 'both'] as const)(
  'release bootstrap loads only copied Node modules with %s workspace and no node_modules',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'foliohaven-bootstrap-'));
    roots.push(root);
    const bootstrap = join(root, 'bootstrap');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { mode: 0o700 });
    for (const path of [
      'server/dist/runtime/lease.js',
      'server/dist/files/io.js',
      'scripts/workspace-paths.mjs',
    ]) {
      await mkdir(dirname(join(bootstrap, path)), { recursive: true });
      await cp(join(repository, path), join(bootstrap, path));
    }
    await writeFile(join(bootstrap, 'package.json'), '{"type":"module"}');
    if (mode !== 'fresh') {
      await mkdir(join(workspace, '.alfred'), { mode: 0o700 });
      await writeFile(join(workspace, '.alfred/proof.txt'), 'unchanged');
    }
    if (mode === 'both')
      await mkdir(join(workspace, '.foliohaven'), { mode: 0o700 });
    const result = await runControlledProcess({
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { readFile, readdir, lstat } from 'node:fs/promises';
      import { pathToFileURL } from 'node:url';
      const [entry, root, mode] = process.argv.slice(1);
      const { acquireFileLease } = await import(pathToFileURL(entry).href);
      const selected = mode === 'legacy' ? '.alfred' : '.foliohaven';
      const lease = await acquireFileLease({root, name:'bootstrap', owner:'release-test'});
      assert(lease);
      await lease.release();
      assert((await lstat(root+'/'+selected+'/locks/bootstrap.lock')).isFile());
      assert(!((await readdir(root)).includes('node_modules')));
      if (mode === 'fresh') assert.deepEqual(await readdir(root), ['.foliohaven']);
      if (mode === 'legacy') assert.deepEqual(await readdir(root), ['.alfred']);
      if (mode === 'both') {
        assert.equal(await readFile(root+'/.alfred/proof.txt','utf8'),'unchanged');
        assert.deepEqual(await readdir(root+'/.alfred'), ['proof.txt']);
      }
      console.log('BOOTSTRAP_OK');
    `,
        join(bootstrap, 'server/dist/runtime/lease.js'),
        workspace,
        mode,
      ],
      cwd: workspace,
      timeoutMs: 10_000,
    });
    expect(result.stdout.toString().trim()).toBe('BOOTSTRAP_OK');
  },
);
