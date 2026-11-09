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
const privateDirectories = (name: string) => [
  name,
  `${name}/cache`,
  `${name}/cache/typescript`,
];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(privateRoot = '.foliohaven') {
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
    'workspace-paths.mjs',
    'check-types.mjs',
    'managed-process.mjs',
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
    const cache = `${directory.startsWith('packages/') ? '../..' : '..'}/${privateRoot}/cache/typescript/${directory.replaceAll('/', '-')}.tsbuildinfo`;
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
  await writeFile(
    join(root, 'tools-entry.ts'),
    'export const value: number = 42;\n',
  );
  await writeFile(
    join(root, 'tsconfig.tools.json'),
    JSON.stringify({
      compilerOptions: {
        incremental: true,
        noEmit: true,
        types: [],
        target: 'ES2022',
      },
      include: ['tools-entry.ts'],
    }),
  );
  if (privateRoot === '.alfred')
    await mkdir(join(root, privateRoot), { mode: 0o700 });
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

async function expectPrivateCompilerOutput(
  root: string,
  privateRoot = '.foliohaven',
) {
  for (const directory of privateDirectories(privateRoot)) {
    const stat = await lstat(join(root, directory));
    expect(stat.mode & 0o777).toBe(0o700);
    expect(stat.uid).toBe(process.getuid?.());
  }
  const cache = join(root, privateRoot, 'cache/typescript');
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
  it.each(['new', 'legacy', 'both'])(
    'the real typecheck wrapper writes only the selected %s root',
    async (mode) => {
      const selected = mode === 'legacy' ? '.alfred' : '.foliohaven';
      const root = await fixture(selected);
      if (mode === 'both') {
        await mkdir(join(root, '.foliohaven'), { mode: 0o700 });
        await mkdir(join(root, '.alfred'), { mode: 0o700 });
        await writeFile(join(root, '.alfred/sentinel'), 'old bytes\n', {
          mode: 0o600,
        });
      }
      await execute(process.execPath, ['scripts/check-types.mjs', 'tools'], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${dirname(compiler)}:${process.env.PATH ?? ''}`,
        },
        timeout: 30_000,
      });
      const info = JSON.parse(
        await readFile(
          join(root, selected, 'cache/typescript/tools.tsbuildinfo'),
          'utf8',
        ),
      ) as { version: string };
      expect(info.version).toMatch(/^\d+\.\d+\.\d+/u);
      if (mode === 'both') {
        expect(await readdir(join(root, '.alfred'))).toEqual(['sentinel']);
        expect(await readFile(join(root, '.alfred/sentinel'), 'utf8')).toBe(
          'old bytes\n',
        );
      } else
        await expect(
          lstat(join(root, mode === 'legacy' ? '.foliohaven' : '.alfred')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('prepares owner-only directories before real TypeScript emits its first build caches', async () => {
    const root = await fixture();
    await expect(lstat(join(root, '.foliohaven'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await buildPackages(root);
    await expectPrivateCompilerOutput(root);
  });

  it('keeps the legacy root when it is the only private root', async () => {
    const root = await fixture('.alfred');
    await buildPackages(root);
    await expectPrivateCompilerOutput(root, '.alfred');
    await expect(lstat(join(root, '.foliohaven'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses the new root and leaves a coexisting legacy tree untouched', async () => {
    const root = await fixture();
    await mkdir(join(root, '.foliohaven'), { mode: 0o700 });
    await mkdir(join(root, '.alfred'), { mode: 0o700 });
    await writeFile(
      join(root, '.alfred/existing.txt'),
      'keep existing private state\n',
      { mode: 0o600 },
    );
    await buildPackages(root);
    await expectPrivateCompilerOutput(root);
    expect(await readdir(join(root, '.alfred'))).toEqual(['existing.txt']);
    expect(await readFile(join(root, '.alfred/existing.txt'), 'utf8')).toBe(
      'keep existing private state\n',
    );
  });

  it('rejects unsafe root permissions without rewriting or falling back', async () => {
    const root = await fixture();
    await mkdir(join(root, '.foliohaven'), { mode: 0o755 });
    await chmod(join(root, '.foliohaven'), 0o755);
    await mkdir(join(root, '.alfred'), { mode: 0o700 });
    await writeFile(join(root, '.foliohaven/existing.txt'), 'unchanged\n');
    await expect(buildPackages(root)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('TOOL_DIRECTORIES_INVALID'),
    });
    expect((await lstat(join(root, '.foliohaven'))).mode & 0o777).toBe(0o755);
    expect(await readdir(join(root, '.alfred'))).toEqual([]);
    expect(await readFile(join(root, '.foliohaven/existing.txt'), 'utf8')).toBe(
      'unchanged\n',
    );
  });

  it('tightens owned inner tool directories without changing existing files', async () => {
    const root = await fixture();
    await mkdir(join(root, '.foliohaven'), { mode: 0o700 });
    await mkdir(join(root, '.foliohaven/cache/typescript'), {
      recursive: true,
    });
    for (const directory of privateDirectories('.foliohaven').slice(1))
      await chmod(join(root, directory), 0o755);
    await writeFile(
      join(root, '.foliohaven/existing.txt'),
      'keep existing private state\n',
    );
    await buildPackages(root);
    await expectPrivateCompilerOutput(root);
    expect(await readFile(join(root, '.foliohaven/existing.txt'), 'utf8')).toBe(
      'keep existing private state\n',
    );
  });

  it.each(['.foliohaven', '.foliohaven/cache/typescript'])(
    'rejects symlink redirection at %s before the compiler writes outside its private tree',
    async (redirect) => {
      const root = await fixture();
      const target = join(root, 'outside');
      await mkdir(target);
      await chmod(target, 0o755);
      await writeFile(join(target, 'original.txt'), 'unchanged target\n');
      await mkdir(dirname(join(root, redirect)), { recursive: true });
      if (redirect !== '.foliohaven')
        await chmod(join(root, '.foliohaven'), 0o700);
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
