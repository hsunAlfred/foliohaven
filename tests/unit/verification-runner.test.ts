import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  QUICK_E2E_FILES,
  QUICK_INTEGRATION_FILES,
  SERIAL_INTEGRATION_FILE,
} from '../../scripts/verification-plan.mjs';
import { maintainerRootSteps } from '../../scripts/verify.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(mode: string) {
  const base = await mkdtemp(join(tmpdir(), 'foliohaven-runner-control-'));
  directories.push(base);
  const root = join(base, 'source');
  const bin = join(base, 'bin');
  await mkdir(bin);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'release'));
  await mkdir(join(root, 'tests/unit'), { recursive: true });
  await mkdir(join(root, 'tests/integration'));
  await mkdir(join(root, 'tests/e2e'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'foliohaven', version: '1.0.0' }),
  );
  await writeFile(join(root, 'mode.json'), JSON.stringify({ mode }));
  await writeFile(
    join(root, 'release/manifest.json'),
    JSON.stringify({
      rootFiles: ['package.json', 'mode.json', 'release/manifest.json'],
      directories: ['scripts', 'tests'],
    }),
  );
  for (const name of [
    'verify-lane.mjs',
    'verify.mjs',
    'release-source.mjs',
    'managed-process.mjs',
    'private-directory.mjs',
    'workspace-paths.mjs',
    'verification-contract.mjs',
    'verification-plan.mjs',
    'verification-resources.mjs',
  ])
    await copyFile(
      join(repository, 'scripts', name),
      join(root, 'scripts', name),
    );
  await copyFile(
    join(root, 'scripts/verification-resources.mjs'),
    join(root, 'scripts/verification-resources-real.mjs'),
  );
  await writeFile(
    join(root, 'scripts/verification-resources.mjs'),
    `export * from './verification-resources-real.mjs';
import { effectiveMemoryHeadroom } from './verification-resources-real.mjs';
export async function verificationResources() { return effectiveMemoryHeadroom({ cpus: 8, memoryBytes: 20 * 1024 ** 3 }, { hostAvailableBytes: 20 * 1024 ** 3, cgroup: { status: 'unlimited', headroomBytes: null } }); }
`,
  );
  for (const path of [
    'tests/unit/example.test.ts',
    SERIAL_INTEGRATION_FILE,
    ...QUICK_INTEGRATION_FILES,
    ...QUICK_E2E_FILES,
  ])
    await writeFile(join(root, path), '// isolated control fixture');
  await writeFile(
    join(bin, 'pnpm'),
    `#!${process.execPath}\n` +
      String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const { mode } = JSON.parse(fs.readFileSync('mode.json', 'utf8'));
fs.appendFileSync('commands.ndjson', JSON.stringify(args) + '\n');
if (mode === 'failure') process.exit(7);
if (mode === 'lint-failure' && args[0] === 'run' && args[1] === 'lint') process.exit(7);
if (mode === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync('children.json', JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else {
  if (mode === 'changed') fs.appendFileSync('package.json', ' ');
  if (args[0] === 'exec' && args[1] === 'vitest') {
    const output = args.find((arg) => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
    let files = args.filter((arg) => /\.test\.(?:ts|tsx|mts)$/.test(arg));
    if (mode === 'missing') files = [];
    fs.writeFileSync(output, JSON.stringify({ success: true, numTotalTests: files.length, numPassedTests: files.length, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0, testResults: files.map((file) => ({ name: path.resolve(file) })) }));
  }
}
`,
  );
  await chmod(join(bin, 'pnpm'), 0o755);
  return { root, bin };
}
function launch(
  root: string,
  bin: string,
  args = ['scripts/verify-lane.mjs', '--lane', 'quality'],
) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (value: Buffer) => {
    output += value.toString();
  });
  child.stderr.on('data', (value: Buffer) => {
    output += value.toString();
  });
  const done = new Promise<number | null>((fulfill, reject) => {
    child.once('error', reject);
    child.once('close', (code) => fulfill(code));
  });
  return { child, done, output: () => output };
}
async function receipt(root: string) {
  return JSON.parse(
    await readFile(
      join(root, '.foliohaven/reports/verification/quality.json'),
      'utf8',
    ),
  ) as {
    status: string;
    error?: { code: string };
    commands: { exitCode: number }[];
    coverage: { reports: unknown[] };
  };
}
async function waitForFile(path: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('controlled child did not start');
}
async function terminated(pid: number) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).startsWith('Z');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return true;
    throw error;
  }
}

describe('verification lane process and receipt controls', () => {
  it('does not duplicate root static checks in public sources without maintainer files', async () => {
    const { root } = await fixture('passed');
    expect(await maintainerRootSteps(root)).toEqual([]);
  });
  it.each(['scripts', 'scripts/maintainer'])(
    'rejects symlinked maintainer ancestor %s before invoking commands',
    async (path) => {
      const { root, bin } = await fixture('passed');
      await rm(join(root, path), { recursive: true, force: true });
      await symlink(bin, join(root, path));
      await expect(maintainerRootSteps(root)).rejects.toMatchObject({
        code: 'VERIFY_MAINTAINER_DIRECTORY_INVALID',
      });
    },
  );
  it.each([
    ['passed', 'RELEASE_SOURCE_INVALID', 0],
    ['lint-failure', 'VERIFY_FAILED', 7],
  ] as const)(
    'runs and records root static checks in order before snapshots (%s)',
    async (mode, code, lintExit) => {
      const { root, bin } = await fixture(mode);
      await mkdir(join(root, 'scripts/maintainer'));

      // The deliberately incomplete export manifest must be reached only after root checks.
      const run = launch(root, bin, [
        '--input-type=module',
        '-e',
        `import {runVerification} from './scripts/verify.mjs'; try {await runVerification({root:process.cwd(),profile:'quick'});} catch(error) {process.stderr.write(error.code);process.exitCode=1;}`,
      ]);
      expect(await run.done, run.output()).toBe(1);
      expect(run.output()).toContain(code);
      expect(
        (await readFile(join(root, 'commands.ndjson'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]),
      ).toEqual([
        ['run', 'format:check'],
        ['run', 'lint'],
      ]);
      const reports = join(root, '.foliohaven/reports/verification/runs');
      const runs = await readdir(reports);
      expect(runs).toHaveLength(1);
      const report = JSON.parse(
        await readFile(join(reports, runs[0] ?? '', 'summary.json'), 'utf8'),
      ) as {
        status: string;
        commands: { argv: string[]; cwd: string; exitCode: number }[];
        lanes: unknown[];
      };
      expect(report).toMatchObject({
        status: 'failed',
        lanes: [],
        commands: [
          { argv: ['pnpm', 'run', 'format:check'], cwd: '.', exitCode: 0 },
          { argv: ['pnpm', 'run', 'lint'], cwd: '.', exitCode: lintExit },
        ],
      });
    },
  );
  it('writes a passed receipt only after both real framework report collections match', async () => {
    const { root, bin } = await fixture('passed');
    const run = launch(root, bin);
    expect(await run.done, run.output()).toBe(0);
    expect(await receipt(root)).toMatchObject({
      status: 'passed',
      coverage: { reports: [{ framework: 'vitest' }, { framework: 'vitest' }] },
    });
  });
  it.each([
    ['failure', 'VERIFY_FAILED'],
    ['missing', 'VERIFY_REPORT_INVALID'],
    ['changed', 'VERIFY_SOURCE_CHANGED'],
  ])('does not accept %s as successful verification', async (mode, code) => {
    const { root, bin } = await fixture(mode);
    const run = launch(root, bin);
    expect(await run.done, run.output()).toBe(1);
    expect(await receipt(root)).toMatchObject({
      status: 'failed',
      error: { code },
    });
  });
  it('cancels the owned child group, waits for termination and records cancellation', async () => {
    const { root, bin } = await fixture('hang');
    const run = launch(root, bin);
    try {
      const pids = JSON.parse(
        await waitForFile(join(root, 'children.json')),
      ) as number[];
      run.child.kill('SIGTERM');
      expect(await run.done, run.output()).toBe(130);
      expect(await receipt(root)).toMatchObject({ status: 'cancelled' });
      for (const pid of pids) await expect(terminated(pid)).resolves.toBe(true);
    } finally {
      run.child.kill('SIGKILL');
      await run.done;
    }
  });
});
