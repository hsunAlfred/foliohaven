import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const directories: string[] = [];

interface Policy {
  rootFiles: string[];
  directories: string[];
  requiredFiles: string[];
  devcontainerTemplate: string;
  githubTemplate: string;
}

interface ReleaseInfo {
  format: number;
  product: string;
  version: string;
  files: { path: string; bytes: number; mode: string; sha256: string }[];
}

afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function put(root: string, path: string, value: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'alfred-release-package-'));
  directories.push(directory);
  const source = join(directory, 'input');
  await mkdir(source);
  const policy = JSON.parse(
    await readFile(join(repository, 'release/manifest.json'), 'utf8'),
  ) as Policy;
  for (const path of [...policy.rootFiles, ...policy.requiredFiles])
    await put(source, path, `${path}\n`);
  for (const path of [
    'LICENSE',
    'cloudflare.config.example.json',
    '.env.cloudflare.example',
    'cloudflare/wrangler.template.json',
    'docs/deployment/Cloudflare部署.md',
    'scripts/deploy-cloudflare.mjs',
    'scripts/release-source.mjs',
    'scripts/workspace-paths.mjs',
    'scripts/package-release.mjs',
    'release/manifest.json',
  ])
    await copyFile(join(repository, path), join(source, path));
  await cp(
    join(repository, policy.devcontainerTemplate),
    join(source, policy.devcontainerTemplate),
    { recursive: true },
  );
  await cp(
    join(repository, policy.githubTemplate),
    join(source, policy.githubTemplate),
    { recursive: true },
  );
  await put(
    source,
    'package.json',
    '{"name":"foliohaven","version":"0.1.0"}\n',
  );
  await put(
    source,
    '.gitignore',
    '.foliohaven/\n.alfred/\n.env\nnode_modules/\n',
  );
  await copyFile(
    join(repository, '.gitattributes'),
    join(source, '.gitattributes'),
  );
  await put(
    source,
    'packages/ui/src/pages/HomePage.tsx',
    'export const Home = 1;\n',
  );
  await put(source, 'scripts/executable.sh', '#!/bin/sh\nexit 0\n');
  await chmod(join(source, 'scripts/executable.sh'), 0o755);
  await put(source, 'tests/fixtures/contract.json', '{"isolated":true}\n');
  await put(
    source,
    'packages/ui/src/styles/fonts/LICENSE.txt',
    'font license\n',
  );
  await put(
    source,
    'content/articles/文章/content.html',
    '<p>示範文章。</p>\n',
  );
  await put(
    source,
    'media/source/example/original.png',
    'neutral image bytes\n',
  );
  await put(
    source,
    '.devcontainer/devcontainer.json',
    '{"private":"producer"}\n',
  );
  await put(
    source,
    '.devcontainer/conversation.txt',
    'private producer record\n',
  );
  await put(source, 'docs/development/producer.md', 'private producer notes\n');
  await put(source, '.alfred/conversation.json', '{"private":true}\n');
  await put(source, '.foliohaven/conversation.json', '{"private":true}\n');
  await put(
    source,
    '.github/workflows/publish-release.yml',
    'private workflow\n',
  );
  await put(
    source,
    'scripts/maintainer/publish-release.mjs',
    'private publisher\n',
  );
  await put(
    source,
    'tests/maintainer/publish-release.test.mjs',
    'private test\n',
  );
  await put(
    source,
    'docs/deployment/bulk-redirects/actual.csv',
    'private redirect\n',
  );
  await put(source, '.env', 'PRIVATE_VALUE=do-not-package\n');
  await put(source, 'scripts/credentials.key', 'private key placeholder\n');
  await put(source, 'site/dist/private.html', 'generated output\n');
  await put(source, 'node_modules/private.txt', 'installed dependency\n');
  return { directory, source, policy };
}

async function run(
  source: string,
  mode: '--directory' | '--output',
  target: string,
  mask?: number,
) {
  return execute(
    process.execPath,
    [
      ...(mask === undefined
        ? []
        : [
            '--input-type=module',
            '-e',
            `process.umask(${mask}); await import(process.argv[1]);`,
          ]),
      join(source, 'scripts/package-release.mjs'),
      mode,
      target,
      '--source',
      source,
    ],
    { timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
}

async function allFiles(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await allFiles(root, path)));
    else result.push(path);
  }
  return result.sort();
}

async function git(source: string, args: string[]) {
  return execute('git', ['--no-optional-locks', ...args], {
    cwd: source,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Release fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Release fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
}

describe('public release packaging', () => {
  it.each([
    { label: 'legacy only', roots: ['.alfred'], refused: '.foliohaven' },
    { label: 'both', roots: ['.foliohaven', '.alfred'], refused: '.alfred' },
    { label: 'neither', roots: [], refused: '.alfred' },
  ])(
    'refuses an unselected private output root for $label without creating or modifying either root',
    async ({ roots, refused }) => {
      const { source } = await fixture();
      for (const name of ['.foliohaven', '.alfred'])
        await rm(join(source, name), { recursive: true, force: true });
      for (const name of roots) {
        await mkdir(join(source, name), { mode: 0o700 });
        await writeFile(
          join(source, name, 'sentinel'),
          `${name}: unchanged\n`,
          { mode: 0o600 },
        );
      }
      await expect(
        run(source, '--directory', join(source, refused, 'releases/candidate')),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('RELEASE_DESTINATION_INVALID'),
      });
      for (const name of ['.foliohaven', '.alfred']) {
        if (roots.includes(name)) {
          expect(await readdir(join(source, name))).toEqual(['sentinel']);
          expect(await readFile(join(source, name, 'sentinel'), 'utf8')).toBe(
            `${name}: unchanged\n`,
          );
          expect((await lstat(join(source, name))).mode & 0o777).toBe(0o700);
        } else
          await expect(lstat(join(source, name))).rejects.toMatchObject({
            code: 'ENOENT',
          });
      }
    },
  );

  it.each([
    { label: 'legacy only', roots: ['.alfred'], selected: '.alfred' },
    { label: 'new only', roots: ['.foliohaven'], selected: '.foliohaven' },
    {
      label: 'both',
      roots: ['.foliohaven', '.alfred'],
      selected: '.foliohaven',
    },
    { label: 'neither', roots: [], selected: '.foliohaven' },
  ])(
    'exports inside the selected root for $label and preserves unused state',
    async ({ roots, selected }) => {
      const { source } = await fixture();
      for (const name of ['.foliohaven', '.alfred'])
        await rm(join(source, name), { recursive: true, force: true });
      for (const name of roots) {
        await mkdir(join(source, name), { mode: 0o700 });
        await writeFile(
          join(source, name, 'sentinel'),
          `${name}: unchanged\n`,
          { mode: 0o600 },
        );
      }
      const destination = join(source, selected, 'releases/candidate');
      await run(source, '--directory', destination);
      expect(
        JSON.parse(
          await readFile(join(destination, 'release-info.json'), 'utf8'),
        ),
      ).toMatchObject({ product: 'foliohaven', version: '0.1.0' });
      const unused = selected === '.foliohaven' ? '.alfred' : '.foliohaven';
      if (roots.includes(unused)) {
        expect(await readdir(join(source, unused))).toEqual(['sentinel']);
        expect(await readFile(join(source, unused, 'sentinel'), 'utf8')).toBe(
          `${unused}: unchanged\n`,
        );
      } else
        await expect(lstat(join(source, unused))).rejects.toMatchObject({
          code: 'ENOENT',
        });
    },
  );

  it('exports product sources, tests and licenses with neutral Dev Container and verifiable file inventory', async () => {
    const { source, directory, policy } = await fixture();
    const destination = join(directory, 'public');
    await run(source, '--directory', destination);
    const files = await allFiles(destination);
    for (const path of policy.requiredFiles) expect(files).toContain(path);
    expect(files).toEqual(
      expect.arrayContaining([
        'LICENSE',
        'cloudflare.config.example.json',
        '.env.cloudflare.example',
        'tests/fixtures/contract.json',
        'packages/ui/src/styles/fonts/LICENSE.txt',
        'content/articles/文章/content.html',
        'media/source/example/original.png',
        '.devcontainer/check-environment.sh',
      ]),
    );
    expect(await readFile(join(destination, 'LICENSE'))).toEqual(
      await readFile(join(repository, 'LICENSE')),
    );
    for (const path of [
      'cloudflare.config.example.json',
      '.env.cloudflare.example',
      'cloudflare/wrangler.template.json',
      'docs/deployment/Cloudflare部署.md',
      'scripts/deploy-cloudflare.mjs',
    ])
      expect(await readFile(join(destination, path))).toEqual(
        await readFile(join(repository, path)),
      );
    expect(
      await readFile(
        join(destination, 'packages/ui/src/styles/fonts/LICENSE.txt'),
        'utf8',
      ),
    ).toBe('font license\n');
    expect(files.join('\n')).not.toMatch(
      /docs\/development|\.foliohaven|\.alfred|conversation|credentials\.key|node_modules|site\/dist|maintainer|publish-release|bulk-redirects|^\.env$/mu,
    );
    const config = await readFile(
      join(destination, '.devcontainer/devcontainer.json'),
      'utf8',
    );
    expect(config).toBe(
      await readFile(
        join(source, policy.devcontainerTemplate, 'devcontainer.json'),
        'utf8',
      ),
    );
    expect(config).not.toMatch(/codex|postStartCommand|openai\.chatgpt/iu);
    const info = JSON.parse(
      await readFile(join(destination, 'release-info.json'), 'utf8'),
    ) as ReleaseInfo;
    expect(info).toMatchObject({
      format: 1,
      product: 'foliohaven',
      version: '0.1.0',
    });
    expect(info.files.map((file) => file.path).sort()).toEqual(
      files.filter((file) => file !== 'release-info.json'),
    );
    for (const file of info.files) {
      const bytes = await readFile(join(destination, file.path));
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(file.mode).toBe(
        ((await lstat(join(destination, file.path))).mode & 0o777)
          .toString(8)
          .padStart(3, '0'),
      );
    }
    expect(
      (await lstat(join(destination, 'scripts/executable.sh'))).mode & 0o777,
    ).toBe(0o755);
    expect(JSON.stringify(info)).not.toMatch(
      /branch|commit|producer|conversation|PRIVATE_VALUE/u,
    );
  });

  it('includes only the root Cloudflare credential example and never exports active settings even when allowlisted', async () => {
    const { source, directory, policy } = await fixture();
    const privateFiles = [
      'cloudflare.config.json',
      '.env.cloudflare',
      '.env.cloudflare.example.local',
      'tests/fixtures/.env.cloudflare.example',
      'tests/fixtures/.env.cloudflare',
      '.wrangler/private-state.json',
      'scripts/cloudflare/.wrangler/private.log',
      'cloudflare/.wrangler/private-state.json',
    ];
    for (const path of privateFiles)
      await put(source, path, 'PRIVATE_CLOUDFLARE_FIXTURE=not-for-release\n');
    policy.rootFiles.push(...privateFiles);
    await put(
      source,
      'release/manifest.json',
      `${JSON.stringify(policy, null, 2)}\n`,
    );
    const destination = join(directory, 'public');
    await run(source, '--directory', destination);
    const files = await allFiles(destination);
    expect(files).toContain('.env.cloudflare.example');
    expect(files).toContain('cloudflare.config.example.json');
    for (const path of privateFiles) expect(files).not.toContain(path);
    const config = JSON.parse(
      await readFile(
        join(destination, 'cloudflare.config.example.json'),
        'utf8',
      ),
    ) as { schemaVersion: number; accountId: string };
    expect(config).toMatchObject({
      schemaVersion: 1,
      accountId: 'YOUR_CLOUDFLARE_ACCOUNT_ID',
    });
    const example = await readFile(
      join(destination, '.env.cloudflare.example'),
      'utf8',
    );
    const assignments = example
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(assignments).toHaveLength(3);
    for (const assignment of assignments)
      expect(assignment).toMatch(/^[A-Z0-9_]+=YOUR_[A-Z0-9_]+$/u);
    expect(
      await readFile(join(destination, 'release-info.json'), 'utf8'),
    ).not.toContain('PRIVATE_CLOUDFLARE_FIXTURE');
  });

  it('repackages an edited no-Git release and retains custom pages and actual public Dev Container settings', async () => {
    const { source, directory } = await fixture();
    const first = join(directory, 'first');
    await run(source, '--directory', first);
    await put(
      first,
      'site/src/pages/about.astro',
      '<main>Custom About</main>\n',
    );
    await put(
      first,
      'packages/ui/src/pages/HomePage.tsx',
      'export const Home = "custom";\n',
    );
    await put(first, '.devcontainer/my-editor.json', '{"custom":true}\n');
    const config = JSON.parse(
      await readFile(join(first, '.devcontainer/devcontainer.json'), 'utf8'),
    ) as { name: string };
    config.name = 'My website';
    await put(first, '.devcontainer/devcontainer.json', JSON.stringify(config));
    await put(first, '.alfred/private.json', '{"private":true}\n');
    const second = join(directory, 'second');
    await run(first, '--directory', second);
    expect(
      await readFile(join(second, 'site/src/pages/about.astro'), 'utf8'),
    ).toContain('Custom About');
    expect(
      await readFile(
        join(second, 'packages/ui/src/pages/HomePage.tsx'),
        'utf8',
      ),
    ).toContain('custom');
    expect(
      await readFile(join(second, '.devcontainer/my-editor.json'), 'utf8'),
    ).toBe('{"custom":true}\n');
    expect(
      await readFile(join(second, '.devcontainer/devcontainer.json'), 'utf8'),
    ).toContain('My website');
    expect(await allFiles(second)).not.toContain('.alfred/private.json');
    // Consumers may initialize Git in the public source. Later archives must
    // preserve their actual Dev Container rather than restoring its template.
    await git(first, ['init', '--quiet', '--initial-branch=main']);
    await git(first, ['add', '.']);
    await git(first, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Customized website',
    ]);
    const third = join(directory, 'third');
    await run(first, '--directory', third);
    expect(
      await readFile(join(third, '.devcontainer/my-editor.json'), 'utf8'),
    ).toBe('{"custom":true}\n');
    expect(
      await readFile(join(third, '.devcontainer/devcontainer.json'), 'utf8'),
    ).toContain('My website');
    expect(
      await readFile(join(third, 'site/src/pages/about.astro'), 'utf8'),
    ).toContain('Custom About');
  });

  it('exports committed Git source and rejects both modified and untracked working files', async () => {
    const { source, directory } = await fixture();
    await git(source, ['init', '--quiet', '--initial-branch=main']);
    await git(source, ['add', '.']);
    await git(source, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Fixture source',
    ]);
    await run(source, '--directory', join(directory, 'clean'));
    await put(source, 'site/src/pages/index.astro', 'uncommitted\n');
    await expect(
      run(source, '--directory', join(directory, 'modified')),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('RELEASE_GIT_DIRTY'),
    });
    await git(source, ['restore', 'site/src/pages/index.astro']);
    await put(source, 'site/src/pages/untracked.astro', 'untracked\n');
    await expect(
      run(source, '--directory', join(directory, 'untracked')),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('RELEASE_GIT_DIRTY'),
    });
  });

  it('refuses existing data, source overlap and destination symlinks without changing their contents', async () => {
    const { source, directory } = await fixture();
    const target = join(directory, 'occupied');
    await put(target, 'keep.txt', 'must remain');
    await expect(run(source, '--directory', target)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('RELEASE_DESTINATION_INVALID'),
    });
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe(
      'must remain',
    );
    for (const path of [source, directory, join(source, 'public')])
      await expect(run(source, '--directory', path)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('RELEASE_DESTINATION_INVALID'),
      });
    const link = join(directory, 'link');
    await symlink(target, link);
    await expect(
      run(source, '--directory', join(link, 'nested')),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('RELEASE_DESTINATION_INVALID'),
    });
    expect(await readdir(target)).toEqual(['keep.txt']);
  });

  it('rejects missing required files, malformed metadata and symlinked public sources or ancestors', async () => {
    const { source, directory } = await fixture();
    await rm(join(source, 'LICENSE'));
    await expect(
      run(source, '--directory', join(directory, 'missing-license')),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('缺少必要的公開檔案：LICENSE'),
    });
    await copyFile(join(repository, 'LICENSE'), join(source, 'LICENSE'));
    await rm(join(source, 'scripts/setup.mjs'));
    await expect(
      run(source, '--directory', join(directory, 'missing')),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('缺少必要的公開檔案：scripts/setup.mjs'),
    });
    await put(source, 'scripts/setup.mjs', 'restored\n');
    await put(source, 'release-info.json', '{"format":99}\n');
    await expect(
      run(source, '--directory', join(directory, 'metadata')),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('公開來源資訊格式不正確'),
    });
    await rm(join(source, 'release-info.json'));
    await symlink(join(source, '.env'), join(source, 'scripts/leak.txt'));
    await expect(
      run(source, '--directory', join(directory, 'file-link')),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('公開來源不得含符號連結'),
    });
    await rm(join(source, 'scripts/leak.txt'));
    const externalMedia = join(directory, 'external-media');
    await mkdir(externalMedia);
    await rm(join(source, 'media'), { recursive: true });
    await symlink(externalMedia, join(source, 'media'));
    await expect(
      run(source, '--directory', join(directory, 'parent-link')),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('公開來源不得含符號連結'),
    });
  });

  it('creates a versioned tarball whose SHA256SUMS and extracted files match the public tree', async () => {
    const { source, directory } = await fixture();
    const target = join(directory, 'package');
    const first = JSON.parse(
      (await run(source, '--output', target)).stdout,
    ) as { archive: string; sha256: string };
    expect(first.archive).toBe('foliohaven-0.1.0-source.tar.gz');
    const bytes = await readFile(join(target, first.archive));
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(first.sha256).toBe(digest);
    expect(await readFile(join(target, 'SHA256SUMS'), 'utf8')).toBe(
      `${digest}  ${first.archive}\n`,
    );
    const extracted = join(directory, 'extracted');
    await mkdir(extracted);
    // Check stored modes rather than applying the extracting user's umask.
    await execute('tar', [
      '-xzf',
      join(target, first.archive),
      '-C',
      extracted,
      '--same-permissions',
    ]);
    const files = await allFiles(join(target, 'source'));
    expect(await allFiles(extracted)).toEqual(files);
    for (const path of files) {
      expect(await readFile(join(extracted, path))).toEqual(
        await readFile(join(target, 'source', path)),
      );
      expect((await lstat(join(extracted, path))).mode & 0o777).toBe(
        (await lstat(join(target, 'source', path))).mode & 0o777,
      );
    }
    const second = JSON.parse(
      (await run(source, '--output', join(directory, 'repeat'), 0o077)).stdout,
    ) as { sha256: string };
    expect(second.sha256).toBe(first.sha256);
  });
});
