import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = new URL('../../', import.meta.url);
const require = createRequire(new URL('package.json', repository));
const compiler = require.resolve('typescript/bin/tsc');
const roots: string[] = [];
const privateDirectories = [
  '.alfred',
  '.alfred/cache',
  '.alfred/cache/typescript',
];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-cold-compiler-'));
  roots.push(root);
  const manifest = JSON.parse(
    await readFile(new URL('package.json', repository), 'utf8'),
  ) as { scripts: Record<string, string> };
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      scripts: { 'build:packages': manifest.scripts['build:packages'] },
    }),
  );
  await mkdir(join(root, 'scripts'));
  for (const name of [
    'prepare-tool-directories.mjs',
    'private-directory.mjs',
    'sync-ui-assets.mjs',
  ])
    await copyFile(
      new URL(`scripts/${name}`, repository),
      join(root, 'scripts', name),
    );
  for (const [directory, config] of [
    ['packages/core', 'tsconfig.node.json'],
    ['packages/ui', 'tsconfig.json'],
    ['site', 'tsconfig.registry.json'],
  ]) {
    if (!directory || !config)
      throw new Error('Compiler fixture is incomplete');
    const project = join(root, directory);
    await mkdir(join(project, 'src'), { recursive: true });
    await writeFile(
      join(project, 'src/index.ts'),
      'export const value: number = 42;\n',
    );
    const cache = `${directory.startsWith('packages/') ? '../..' : '..'}/.alfred/cache/typescript/${directory.replaceAll('/', '-')}.tsbuildinfo`;
    await writeFile(
      join(project, config),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          target: 'ES2022',
          types: [],
          rootDir: 'src',
          outDir: 'dist',
          tsBuildInfoFile: cache,
        },
        include: ['src/**/*.ts'],
      }),
    );
  }
  await mkdir(join(root, 'packages/ui/src/styles'));
  await writeFile(
    join(root, 'packages/ui/src/styles/index.css'),
    'body { color: #222; }\n',
  );
  await writeFile(
    join(root, 'author.html'),
    '<p>Author content must survive.</p>\n',
    { mode: 0o640 },
  );
  // 明訂受保護原檔的前提，避免呼叫端 umask 過濾建立模式。
  await chmod(join(root, 'author.html'), 0o640);
  return root;
}

async function buildPackages(root: string) {
  // 真實執行產品的 build:packages；022 可重現全新原生環境的建立模式。
  return execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import {spawnSync} from "node:child_process";process.umask(0o022);const result=spawnSync("pnpm",["run","build:packages"],{stdio:"inherit"});if(result.error)throw result.error;process.exitCode=result.status??1;',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${dirname(compiler)}:${process.env.PATH ?? ''}`,
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
}

async function expectPrivateCompilerOutput(root: string) {
  for (const directory of privateDirectories) {
    const stat = await lstat(join(root, directory));
    expect(stat.mode & 0o777).toBe(0o700);
    expect(stat.uid).toBe(process.getuid?.());
  }
  const cache = join(root, '.alfred/cache/typescript');
  expect((await readdir(cache)).sort()).toEqual([
    'packages-core.tsbuildinfo',
    'packages-ui.tsbuildinfo',
    'site.tsbuildinfo',
  ]);
  const buildInfo = JSON.parse(
    await readFile(join(cache, 'site.tsbuildinfo'), 'utf8'),
  ) as { version?: string };
  expect(buildInfo.version).toMatch(/^\d+\.\d+\.\d+/u);
  expect(await readFile(join(root, 'site/dist/index.js'), 'utf8')).toContain(
    'value = 42',
  );
  expect(await readFile(join(root, 'author.html'), 'utf8')).toBe(
    '<p>Author content must survive.</p>\n',
  );
  expect((await lstat(join(root, 'author.html'))).mode & 0o777).toBe(0o640);
}

describe('cold native compiler directory preparation', () => {
  it('prepares owner-only directories before real TypeScript emits its first build caches', async () => {
    const root = await fixture();
    await expect(lstat(join(root, '.alfred'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await buildPackages(root);
    await expectPrivateCompilerOutput(root);
  });

  it('repairs owned 0755 tool directories without changing existing files', async () => {
    const root = await fixture();
    await mkdir(join(root, '.alfred/cache/typescript'), { recursive: true });
    for (const directory of privateDirectories)
      await chmod(join(root, directory), 0o755);
    await writeFile(
      join(root, '.alfred/existing.txt'),
      'keep existing private state\n',
    );
    await buildPackages(root);
    await expectPrivateCompilerOutput(root);
    expect(await readFile(join(root, '.alfred/existing.txt'), 'utf8')).toBe(
      'keep existing private state\n',
    );
  });

  it.each(['.alfred', '.alfred/cache/typescript'])(
    'rejects symlink redirection at %s before the compiler writes outside its private tree',
    async (redirect) => {
      const root = await fixture();
      const target = join(root, 'outside');
      await mkdir(target);
      await chmod(target, 0o755);
      await writeFile(join(target, 'original.txt'), 'unchanged target\n');
      await mkdir(dirname(join(root, redirect)), { recursive: true });
      await symlink(target, join(root, redirect));
      await expect(buildPackages(root)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('TOOL_DIRECTORIES_INVALID'),
      });
      expect((await lstat(target)).mode & 0o777).toBe(0o755);
      expect(await readdir(target)).toEqual(['original.txt']);
      expect(await readFile(join(target, 'original.txt'), 'utf8')).toBe(
        'unchanged target\n',
      );
      await expect(lstat(join(root, 'site/dist'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
});
