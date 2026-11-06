import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  copyFile,
  cp,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// Docker is deliberately replaced here. These cases exercise the real Bash
// orchestration, pipelines and EXIT cleanup; actual image acceptance stays on
// the host and is never inferred from this harness.
const commandStub = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const mode = process.env.RELEASE_HOST_TEST_MODE;
appendFileSync(process.env.RELEASE_HOST_TEST_COMMANDS, JSON.stringify({ command, args, cwd: process.cwd() }) + '\\n');
if (command === 'curl') {
  if (mode === 'probe-timeout') {
    const result = spawnSync(process.env.RELEASE_HOST_TEST_CURL, args, { stdio: 'inherit', timeout: 20_000 });
    process.exit(result.status ?? 99);
  }
  console.log('HTTP 200，耗時 0.01s');
  if (mode === 'probe-stop-failed') process.exit(28);
} else if (command === 'docker') {
  if (args[0] === 'build') {
    if (existsSync('author.txt') || existsSync('.devcontainer/private-only.txt') || existsSync('docs/development/author-private-notes.md')) process.exit(90);
    const config = JSON.parse(readFileSync('.devcontainer/devcontainer.json', 'utf8'));
    if (config.postStartCommand || config.customizations.vscode.extensions.includes('openai.chatgpt')) process.exit(91);
    if (/codex/i.test(readFileSync('.devcontainer/docker-compose.yml', 'utf8'))) process.exit(92);
    console.log('MOCK_PUBLIC_SOURCE_CURATION');
    console.log('MOCK_DIST_EXPORT_BUILD');
    if (mode === 'build-failed') process.exit(31);
    const target = args[args.indexOf('--output') + 1].split('dest=')[1];
    mkdirSync(dirname(target), { recursive: true });
    execFileSync('tar', ['-C', process.env.RELEASE_HOST_TEST_EXPORT, '-cf', target, '.']);
  } else if (args[0] === 'inspect') {
    if (mode === 'inspect-failed') process.exit(54);
    console.log('null');
  } else if (args[0] === 'image') {
    if (args[1] === 'ls') console.log(args.at(-1) + ':0.1.0');
    if (args[1] === 'rm' && mode === 'cleanup-failed') process.exit(61);
  } else if (args[0] === 'compose') {
    const projectDirectory = args[args.indexOf('--project-directory') + 1];
    const files = args.flatMap((value, index) => value === '-f' ? [args[index + 1]] : []);
    if (projectDirectory !== process.cwd() || files[0] !== join(process.cwd(), 'docker-compose.yml') || files.some(file => ![join(process.cwd(), 'docker-compose.yml'), join(process.cwd(), '.devcontainer/docker-compose.yml')].includes(file))) process.exit(93);
    const envFile = args[args.indexOf('--env-file') + 1];
    if (envFile !== join(process.cwd(), '.alfred/compose.env') || readFileSync(envFile, 'utf8') !== '') process.exit(97);
    for (const name of ['COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PATH_SEPARATOR', 'COMPOSE_CONVERT_WINDOWS_PATHS', 'COMPOSE_REMOVE_ORPHANS', 'COMPOSE_COMPATIBILITY']) {
      if (process.env[name] !== undefined) process.exit(94);
    }
    if (process.env.COMPOSE_DISABLE_ENV_FILE !== '1') process.exit(95);
    if (args.includes('--profile') && args[args.indexOf('--profile') + 1] !== 'repair') process.exit(96);
    if (args.includes('ps')) console.log('isolated-app-container');
    if (args.includes('logs')) console.log('MOCK_CONTAINER_LOG');
    if (args.includes('stop') && mode === 'probe-stop-failed') process.exit(71);
    if (args.includes('exec') && args.includes('tests/release/docker-check.mjs')) {
      const report = join(process.cwd(), '.alfred/reports/release-docker-check');
      mkdirSync(report, { recursive: true });
      writeFileSync(join(report, args.at(-1) + '.json'), JSON.stringify({ isolated: true }));
      console.log('MOCK_AUTHOR_CHECK_' + args.at(-1));
    }
    if (args.includes('exec') && args.includes('tests/release/cloudflare-docker-check.mjs')) {
      const report = join(process.cwd(), '.alfred/reports/release-docker-check');
      mkdirSync(report, { recursive: true });
      const failed = mode === 'cloudflare-dry-run-failed';
      writeFileSync(join(report, 'cloudflare-dry-run.json'), JSON.stringify({ isolated: true, scope: 'fake-docker-harness', status: failed ? 'failed' : 'passed', remoteWrites: false }));
      console.log('MOCK_CLOUDFLARE_DRY_RUN');
      if (failed) process.exit(67);
    }
  }
} else process.exit(99);
`;

interface CommandRecord {
  command: string;
  args: string[];
  cwd: string;
}

async function releaseSourceFixture(source: string) {
  const repository = new URL('../../', import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL('release/manifest.json', repository), 'utf8'),
  ) as {
    requiredFiles: string[];
    devcontainerTemplate: string;
    githubTemplate: string;
  };
  for (const path of manifest.requiredFiles) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), 'public release fixture\n');
  }
  for (const path of [
    'package.json',
    'scripts/package-release.mjs',
    'scripts/release-source.mjs',
    'release/manifest.json',
  ]) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await copyFile(new URL(path, repository), join(source, path));
  }
  await cp(
    new URL(manifest.devcontainerTemplate, repository),
    join(source, manifest.devcontainerTemplate),
    { recursive: true },
  );
  await cp(
    new URL(manifest.githubTemplate, repository),
    join(source, manifest.githubTemplate),
    { recursive: true },
  );
  await mkdir(join(source, '.devcontainer'), { recursive: true });
  await writeFile(
    join(source, '.devcontainer/private-only.txt'),
    'maker configuration must not be exported\n',
  );
  await mkdir(join(source, 'docs/development'), { recursive: true });
  await writeFile(
    join(source, 'docs/development/author-private-notes.md'),
    'maker notes must not be exported\n',
  );
  await writeFile(join(source, 'docker-compose.yml'), 'services: {}\n');
}

async function run(mode = 'success', port?: number) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-host-script-test-'));
  roots.push(root);
  const source = join(root, 'source');
  const exported = join(root, 'exported');
  const commandsFile = join(root, 'commands.jsonl');
  const bin = join(root, 'bin');
  for (const directory of [
    join(source, 'scripts'),
    exported,
    bin,
    join(root, 'tmp'),
  ])
    await mkdir(directory, { recursive: true });
  await releaseSourceFixture(source);
  await writeFile(join(source, 'author.txt'), 'author bytes must survive\n');
  if (mode === 'published-source') {
    await rm(join(source, '.devcontainer'), { recursive: true });
    await cp(
      join(source, 'release/templates/devcontainer'),
      join(source, '.devcontainer'),
      { recursive: true },
    );
    await writeFile(
      join(source, 'release-info.json'),
      JSON.stringify({ format: 1, product: 'foliohaven', version: '0.1.0' }),
    );
  }
  if (mode === 'source-invalid') await rm(join(source, 'Dockerfile'));
  if (mode === 'git-invalid') await mkdir(join(source, '.git'));
  for (const name of [
    'index.html',
    '404.html',
    'rss.xml',
    'search-index.json',
    'sitemap-index.xml',
    'robots.txt',
  ])
    await writeFile(join(exported, name), 'isolated export\n');
  const script = join(source, 'scripts/check-release-docker.sh');
  await writeFile(
    script,
    await readFile(
      new URL('../../scripts/check-release-docker.sh', import.meta.url),
    ),
  );
  const stub = join(root, 'command-stub.mjs');
  await writeFile(stub, commandStub, { mode: 0o700 });
  for (const command of ['curl', 'docker'])
    await symlink(stub, join(bin, command));
  let code = 0;
  let output: string;
  const realCurl = (
    await execute('bash', ['-c', 'command -v curl'])
  ).stdout.trim();
  try {
    const result = await execute('bash', [script], {
      cwd: source,
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TMPDIR: join(root, 'tmp'),
        RELEASE_HOST_TEST_MODE: mode,
        RELEASE_HOST_TEST_COMMANDS: commandsFile,
        RELEASE_HOST_TEST_EXPORT: exported,
        RELEASE_HOST_TEST_CURL: realCurl,
        ...(mode === 'compose-env-polluted'
          ? {
              COMPOSE_FILE: join(source, 'docker-compose.yml'),
              COMPOSE_PROFILES: 'development,repair',
              COMPOSE_ENV_FILES: join(source, '.env'),
              COMPOSE_PROJECT_NAME: 'author-existing-project',
              COMPOSE_PATH_SEPARATOR: ';',
              COMPOSE_CONVERT_WINDOWS_PATHS: '1',
              COMPOSE_REMOVE_ORPHANS: '1',
              COMPOSE_COMPATIBILITY: '1',
              COMPOSE_DISABLE_ENV_FILE: '0',
            }
          : {}),
        ...(port === undefined ? {} : { SITE_PORT: String(port) }),
      },
    });
    output = result.stdout + result.stderr;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      !('stdout' in error) ||
      !('stderr' in error)
    )
      throw error;
    expect(typeof error.code).toBe('number');
    code = Number(error.code);
    output = String(error.stdout) + String(error.stderr);
  }
  const recordedCommands = await readFile(commandsFile, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    },
  );
  const commands = recordedCommands
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CommandRecord);
  const reports = join(source, '.alfred/reports/release-docker-host');
  const report = join(reports, (await readdir(reports))[0] ?? 'missing-report');
  const workspace = commands.find(
    (item) => item.command === 'docker' && item.args[0] === 'build',
  )?.cwd;
  expect(await readFile(join(source, 'author.txt'), 'utf8')).toBe(
    'author bytes must survive\n',
  );
  return { code, output, commands, report, workspace, root };
}

describe('release host script progress and failure preservation', () => {
  it('logs every stage live, bounds direct host probes and only cleans its own project on success', async () => {
    const result = await run();
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('[12/12]');
    expect(result.output).toContain('Docker release 驗收通過');
    expect(result.output).toContain('MOCK_DIST_EXPORT_BUILD');
    expect(result.output).toContain('MOCK_PUBLIC_SOURCE_CURATION');
    const log = await readFile(join(result.report, 'compose.log'), 'utf8');
    expect(log).toContain('MOCK_DIST_EXPORT_BUILD');
    expect(log).toContain('MOCK_AUTHOR_CHECK_prepare');
    expect(log).toContain('MOCK_CLOUDFLARE_DRY_RUN');
    expect(log).toContain('Docker release 驗收通過');
    for (const call of result.commands.filter(
      (item) => item.command === 'curl',
    )) {
      expect(call.args).toContain('--noproxy');
      expect(call.args[call.args.indexOf('--noproxy') + 1]).toBe('*');
      expect(call.args[call.args.indexOf('--connect-timeout') + 1]).toBe('3');
      expect(call.args[call.args.indexOf('--max-time') + 1]).toBe('15');
    }
    const projects = result.commands
      .filter((item) => item.command === 'docker' && item.args[0] === 'compose')
      .map((item) => item.args[item.args.indexOf('-p') + 1]);
    expect(new Set(projects).size).toBe(1);
    expect(projects[0]).toMatch(/^foliohaven-release-check-\d+$/u);
    expect(await readdir(join(result.root, 'tmp'))).toEqual([]);
    expect(
      JSON.parse(
        await readFile(
          join(result.report, 'release-docker-check/verify.json'),
          'utf8',
        ),
      ),
    ).toEqual({ isolated: true });
    const helper = result.commands.filter((item) =>
      item.args.includes('tests/release/cloudflare-docker-check.mjs'),
    );
    expect(helper).toHaveLength(1);
    expect(helper[0]?.args.slice(-5)).toEqual([
      'exec',
      '-T',
      'app',
      'node',
      'tests/release/cloudflare-docker-check.mjs',
    ]);
    const helperIndex = result.commands.findIndex((item) =>
      item.args.includes('tests/release/cloudflare-docker-check.mjs'),
    );
    const verifyIndices = result.commands.flatMap((item, index) =>
      item.args.includes('tests/release/docker-check.mjs') &&
      item.args.at(-1) === 'verify'
        ? [index]
        : [],
    );
    expect(verifyIndices).toHaveLength(2);
    expect(helperIndex).toBeGreaterThan(Math.max(...verifyIndices));
    expect(
      JSON.parse(
        await readFile(
          join(result.report, 'release-docker-check/cloudflare-dry-run.json'),
          'utf8',
        ),
      ),
    ).toEqual({
      isolated: true,
      scope: 'fake-docker-harness',
      status: 'passed',
      remoteWrites: false,
    });
  });

  it('accepts an unpacked public release without Git history and uses its neutral Dev Container', async () => {
    const result = await run('published-source');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('MOCK_PUBLIC_SOURCE_CURATION');
    expect(result.output).toContain('Docker release 驗收通過');
    expect(await readdir(join(result.root, 'tmp'))).toEqual([]);
  });

  it('preserves the new Cloudflare helper failure and evidence without claiming real Docker coverage', async () => {
    const result = await run('cloudflare-dry-run-failed');
    expect(result.code, result.output).toBe(67);
    expect(result.output).toContain('MOCK_CLOUDFLARE_DRY_RUN');
    expect(result.output).not.toContain('Docker release 驗收通過');
    expect(
      await readFile(join(result.report, 'failed-stage.txt'), 'utf8'),
    ).toContain('[11b/12]');
    expect(
      JSON.parse(
        await readFile(
          join(result.report, 'release-docker-check/cloudflare-dry-run.json'),
          'utf8',
        ),
      ),
    ).toEqual({
      isolated: true,
      scope: 'fake-docker-harness',
      status: 'failed',
      remoteWrites: false,
    });
    expect(
      result.commands.some(
        (item) =>
          item.args.includes('stop') &&
          item.args.includes('app') &&
          item.args.includes('repair'),
      ),
    ).toBe(true);
    expect(
      result.commands.some(
        (item) =>
          item.args.includes('down') && item.args.includes('--remove-orphans'),
      ),
    ).toBe(false);
    expect(
      result.commands.some(
        (item) => item.args[0] === 'image' && item.args[1] === 'rm',
      ),
    ).toBe(false);
    expect((await readdir(join(result.root, 'tmp'))).length).toBe(1);
  });

  it.each([
    '.git',
    'cloudflare.config.json',
    '.env.cloudflare',
    'invalid-marker',
  ])(
    'the actual Cloudflare helper refuses author data or missing isolation evidence: %s',
    async (forbidden) => {
      const directory = await mkdtemp(
        join(tmpdir(), 'alfred-cloudflare-helper-guard-'),
      );
      roots.push(directory);
      await mkdir(join(directory, '.alfred'), { mode: 0o700 });
      await writeFile(
        join(directory, '.alfred/release-check-workspace.json'),
        JSON.stringify({
          schemaVersion: 1,
          purpose:
            forbidden === 'invalid-marker'
              ? 'author-workspace'
              : 'release-validation',
        }),
        { mode: 0o600 },
      );
      if (forbidden !== 'invalid-marker')
        await writeFile(
          join(directory, forbidden),
          'author fixture must survive\n',
          { mode: 0o600 },
        );
      await expect(
        execute(
          process.execPath,
          [
            fileURLToPath(
              new URL(
                '../release/cloudflare-docker-check.mjs',
                import.meta.url,
              ),
            ),
          ],
          { cwd: directory, timeout: 10_000 },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          'RELEASE_CLOUDFLARE_WORKSPACE_REQUIRED',
        ),
      });
      if (forbidden !== 'invalid-marker')
        expect(await readFile(join(directory, forbidden), 'utf8')).toBe(
          'author fixture must survive\n',
        );
      expect(await readdir(join(directory, '.alfred'))).toEqual([
        'release-check-workspace.json',
      ]);
    },
  );

  it('isolates every Compose invocation from inherited files, profiles, projects and env settings', async () => {
    const result = await run('compose-env-polluted');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Docker release 驗收通過');
    const calls = result.commands.filter(
      (item) => item.command === 'docker' && item.args[0] === 'compose',
    );
    expect(calls.length).toBeGreaterThan(10);
    for (const call of calls) {
      expect(call.args[call.args.indexOf('--project-directory') + 1]).toBe(
        call.cwd,
      );
      expect(call.args[call.args.indexOf('-f') + 1]).toBe(
        join(call.cwd, 'docker-compose.yml'),
      );
      expect(call.args[call.args.indexOf('--env-file') + 1]).toBe(
        join(call.cwd, '.alfred/compose.env'),
      );
      expect(call.args).not.toContain('development');
      expect(call.args).not.toContain('author-existing-project');
    }
    expect(await readdir(join(result.root, 'tmp'))).toEqual([]);
  });

  it('preserves the exact Docker build failure through tee and retains the isolated workspace', async () => {
    const result = await run('build-failed');
    expect(result.code, result.output).toBe(31);
    expect(result.output).not.toContain('Docker release 驗收通過');
    expect(
      await readFile(join(result.report, 'failed-stage.txt'), 'utf8'),
    ).toContain('[3/12]');
    expect(result.workspace).toBeDefined();
    expect(
      await readFile(
        join(result.workspace ?? '', 'docker-compose.yml'),
        'utf8',
      ),
    ).toBe('services: {}\n');
    expect(result.commands.some((item) => item.args.includes('up'))).toBe(
      false,
    );
    expect(
      await readFile(join(result.report, 'compose.log'), 'utf8'),
    ).toContain('MOCK_DIST_EXPORT_BUILD');
  });

  it.each(['probe-timeout', 'probe-stop-failed'])(
    'returns the probe timeout and preserves diagnostic evidence for %s',
    async (mode) => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.resume(); // Accept the HTTP request without sending a response.
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Probe fixture did not bind');
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run(mode, address.port);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      expect(result.code, result.output).toBe(28);
      expect(result.output).not.toContain('Docker release 驗收通過');
      expect(
        await readFile(join(result.report, 'failed-stage.txt'), 'utf8'),
      ).toContain('[6/12]');
      expect(
        await readFile(join(result.report, 'containers.log'), 'utf8'),
      ).toContain('MOCK_CONTAINER_LOG');
      expect(
        result.commands.some((item) => item.args.includes('prepare')),
      ).toBe(false);
      if (mode === 'probe-stop-failed')
        expect(result.output).toContain('無法確認驗收容器停止狀態');
      else expect(result.output).toContain('已停止並保留獨立 project');
      expect((await readdir(join(result.root, 'tmp'))).length).toBe(1);
    },
  );

  it('refuses to infer unpublished API ports when Docker inspection fails', async () => {
    const result = await run('inspect-failed');
    expect(result.code, result.output).toBe(54);
    expect(result.commands.some((item) => item.args.includes('prepare'))).toBe(
      false,
    );
    expect(result.output).not.toContain('Docker release 驗收通過');
  });

  it('does not report success or delete the workspace after cleanup fails', async () => {
    const result = await run('cleanup-failed');
    expect(result.code, result.output).toBe(61);
    expect(
      await readFile(join(result.report, 'failed-stage.txt'), 'utf8'),
    ).toContain('[12/12]');
    expect(result.output).not.toContain('Docker release 驗收通過');
    expect((await readdir(join(result.root, 'tmp'))).length).toBe(1);
    expect(
      JSON.parse(
        await readFile(
          join(result.report, 'release-docker-check/verify.json'),
          'utf8',
        ),
      ),
    ).toEqual({ isolated: true });
  });

  it.each(['source-invalid', 'git-invalid'])(
    'stops before any Docker operation when real public source curation rejects %s',
    async (mode) => {
      const result = await run(mode);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toMatch(/RELEASE_[A-Z_]+/u);
      expect(result.output).not.toContain('Docker release 驗收通過');
      expect(result.output).toContain('未啟動 Docker');
      expect(result.commands).toEqual([]);
      expect(
        await readFile(join(result.report, 'failed-stage.txt'), 'utf8'),
      ).toContain('[1/12]');
      expect((await readdir(join(result.root, 'tmp'))).length).toBe(1);
    },
  );
});
