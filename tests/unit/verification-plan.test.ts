import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CORE_VERIFICATION_LANES,
  QUICK_E2E_FILES,
  QUICK_INTEGRATION_FILES,
  SERIAL_INTEGRATION_FILE,
  createVerificationPlan,
  expectedLaneCoverage,
  validateLaneCoverage,
  validateVerificationCoverage,
  verificationConcurrency,
  effectiveVerificationResources,
  verificationUnitWorkers,
  effectiveMemoryHeadroom,
  cgroupMemoryDirectories,
  cgroupMemoryHeadroom,
  parseMemAvailable,
  verificationLaneResources,
  verificationConfiguredUnitWorkers,
} from '../../scripts/verification-plan.mjs';
import {
  laneSteps,
  parseLaneArguments,
  summarizeFrameworkReport,
  verificationEnvironment,
} from '../../scripts/verify-lane.mjs';
import {
  parseVerificationArguments,
  runBounded,
} from '../../scripts/verify.mjs';
import { exportVerificationWorkspace } from '../../scripts/release-source.mjs';

const GIB = 1024 ** 3;
function memoryFixture(
  available: number,
  nominal = { cpus: 8, memoryBytes: 17 * GIB },
) {
  return effectiveMemoryHeadroom(nominal, {
    hostAvailableBytes: Math.floor(available * GIB),
    cgroup: { status: 'unlimited', headroomBytes: null },
  });
}
const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'foliohaven-verification-plan-'));
  directories.push(root);
  return root;
}
async function put(root: string, path: string, value = '') {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function planFixture() {
  const root = await fixture();
  for (const path of [
    'tests/unit/a.test.ts',
    'tests/unit/z.test.mts',
    SERIAL_INTEGRATION_FILE,
    ...QUICK_INTEGRATION_FILES,
    'tests/integration/large.test.ts',
    ...QUICK_E2E_FILES,
    'tests/e2e/extra.spec.ts',
  ])
    await put(
      root,
      path,
      path.includes('large') ? 'x'.repeat(1000) : 'fixture',
    );
  return { root, plan: await createVerificationPlan(root) };
}

describe('verification plans and lanes', () => {
  it('partitions every integration file exactly once and retains every browser spec', async () => {
    const { root, plan } = await planFixture();
    const assigned = ['quality', 'integration-1', 'integration-2'].flatMap(
      (lane) => plan.lanes[lane]?.integrationFiles ?? [],
    );
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.sort()).toEqual(plan.integrationFiles);
    expect(plan.lanes.quality?.integrationFiles).toEqual([
      SERIAL_INTEGRATION_FILE,
    ]);
    for (const browser of ['chromium', 'firefox', 'webkit'])
      expect(plan.lanes[`e2e-${browser}`]?.e2eFiles).toEqual(plan.e2eFiles);
    expect(await createVerificationPlan(root)).toEqual(plan);
    await put(root, 'tests/integration/new.test.ts', 'extra');
    expect((await createVerificationPlan(root)).planDigest).not.toBe(
      plan.planDigest,
    );
  });
  it('rejects coverage holes, duplicate receipts, quick masquerading as full and changed plans', async () => {
    const { plan } = await planFixture();
    const receipts = CORE_VERIFICATION_LANES.map((lane) => ({
      lane,
      scope: 'full',
      status: 'passed',
      coverage: {
        planDigest: plan.planDigest,
        ...expectedLaneCoverage(plan, lane),
      },
    }));
    expect(validateVerificationCoverage(plan, receipts)).toBe(true);
    expect(() =>
      validateVerificationCoverage(plan, receipts.slice(1)),
    ).toThrow();
    expect(() =>
      validateVerificationCoverage(plan, [...receipts, receipts[0]]),
    ).toThrow();
    expect(() =>
      validateVerificationCoverage(
        plan,
        receipts.map((r) =>
          r.lane === 'quality' ? { ...r, scope: 'quick' } : r,
        ),
      ),
    ).toThrow();
    const first = receipts[0];
    expect(first).toBeDefined();
    if (!first) throw new Error('fixture');
    expect(() =>
      validateLaneCoverage(plan, {
        ...first,
        coverage: { ...first.coverage, unitFiles: [] },
      }),
    ).toThrow();
    expect(() =>
      validateLaneCoverage(plan, {
        ...first,
        coverage: { ...first.coverage, planDigest: '0'.repeat(64) },
      }),
    ).toThrow();
  });
  it('enforces resource caps and strict CLI arguments', () => {
    const resources = memoryFixture(17);
    expect(verificationConcurrency(undefined, resources)).toBe(2);
    expect(verificationConcurrency(4, resources)).toBe(4);
    expect(() =>
      verificationConcurrency(3, { ...memoryFixture(17), cpus: 4 }),
    ).toThrow();
    for (const args of [
      ['--concurrency', '0'],
      ['--profile', 'none'],
      ['--profile', 'full', '--profile', 'quick'],
    ])
      expect(() => parseVerificationArguments(args, resources)).toThrow();
    expect(
      parseVerificationArguments(['--profile', 'quick'], resources),
    ).toEqual({ profile: 'quick', concurrency: 1, concurrencyExplicit: false });
    expect(
      parseLaneArguments(['--lane', 'quality', '--profile', 'quick']),
    ).toEqual({ lane: 'quality', scope: 'quick' });
    expect(() =>
      parseLaneArguments(['--lane', 'e2e-webkit', '--profile', 'quick']),
    ).toThrow();
  });
  it('respects cgroup CPU quotas and constrained memory instead of host capacity', () => {
    const host = { availableCpus: 8, hostMemoryBytes: 16 * 1024 ** 3 };
    const limited = effectiveVerificationResources({
      ...host,
      cpuMax: '250000 100000\n',
      constrainedMemoryBytes: 6 * 1024 ** 3,
    });
    expect(limited).toEqual({ cpus: 2.5, memoryBytes: 6 * 1024 ** 3 });
    expect(verificationConcurrency(undefined, memoryFixture(6, limited))).toBe(
      1,
    );
    expect(verificationUnitWorkers(undefined, memoryFixture(6, limited))).toBe(
      2,
    );
    expect(() =>
      verificationConcurrency(2, memoryFixture(6, limited)),
    ).toThrow();
    const tiny = effectiveVerificationResources({
      ...host,
      cpuMax: '50000 100000',
      constrainedMemoryBytes: 1024 ** 3,
    });
    expect(() =>
      verificationConcurrency(undefined, memoryFixture(1, tiny)),
    ).toThrow();
    expect(verificationUnitWorkers(undefined, memoryFixture(1, tiny))).toBe(1);
    expect(() => verificationUnitWorkers(2, memoryFixture(1, tiny))).toThrow();
    expect(
      effectiveVerificationResources({
        ...host,
        cpuQuota: '200000',
        cpuPeriod: '100000',
      }).cpus,
    ).toBe(2);
    for (const cpuMax of ['max 100000', 'invalid', '0 100000', '100000 0'])
      expect(effectiveVerificationResources({ ...host, cpuMax })).toEqual({
        cpus: 8,
        memoryBytes: 16 * 1024 ** 3,
      });
    expect(
      effectiveVerificationResources({
        ...host,
        constrainedMemoryBytes: 32 * 1024 ** 3,
      }).memoryBytes,
    ).toBe(host.hostMemoryBytes);
  });

  it('budgets heavy lanes from actual headroom without lowering the 4 GiB budget', () => {
    expect(() =>
      verificationConcurrency(undefined, memoryFixture(2.7)),
    ).toThrow(/最多可執行 0/u);
    expect(verificationConcurrency(undefined, memoryFixture(4.6))).toBe(1);
    expect(() => verificationConcurrency(3, memoryFixture(4.6))).toThrow(
      /最多可執行 1/u,
    );
    expect(verificationConcurrency(undefined, memoryFixture(9.5))).toBe(2);
    expect(() => verificationConcurrency(3, memoryFixture(9.5))).toThrow(
      /最多可執行 2/u,
    );
    expect(verificationConcurrency(3, memoryFixture(13.5))).toBe(3);
    expect(memoryFixture(4.6)).toMatchObject({
      memoryBytes: 17 * GIB,
      memoryReserveBytes: 512 * 1024 ** 2,
    });
  });
  it('uses only known headroom for fallback and never treats nominal RAM or swap as idle', () => {
    expect(
      parseMemAvailable('MemAvailable: 1048576 kB\nSwapFree: 1073741824 kB\n'),
    ).toBe(GIB);
    expect(
      parseMemAvailable('MemTotal: 16777216 kB\nSwapFree: 1073741824 kB'),
    ).toBeNull();
    const nominal = { cpus: 8, memoryBytes: 17 * GIB };
    const partial = effectiveMemoryHeadroom(nominal, {
      hostAvailableBytes: 12 * GIB,
    });
    expect(partial.memoryCapacityStatus).toBe('fallback');
    expect(verificationConcurrency(undefined, partial)).toBe(1);
    expect(() => verificationConcurrency(2, partial)).toThrow();
    const groupOnly = effectiveMemoryHeadroom(nominal, {
      cgroup: { status: 'finite', headroomBytes: 8 * GIB },
    });
    expect(verificationConcurrency(undefined, groupOnly)).toBe(1);
    const unknown = effectiveMemoryHeadroom(nominal);
    expect(unknown).toMatchObject({
      memoryHeadroomBytes: null,
      usableMemoryBytes: 0,
      memoryCapacityStatus: 'unknown',
    });
    expect(() => verificationConcurrency(undefined, unknown)).toThrow(/未知/u);
  });
  it('subtracts all sibling usage from every finite cgroup ancestor and applies the smallest remaining bound', () => {
    const group = cgroupMemoryHeadroom([
      { limit: String(8 * GIB), current: String(5 * GIB) },
      { limit: String(16 * GIB), current: String(14 * GIB) },
      { limit: 'max', current: '0' },
    ]);
    expect(group).toEqual({ status: 'finite', headroomBytes: 2 * GIB });
    const resources = effectiveMemoryHeadroom(
      { cpus: 8, memoryBytes: 17 * GIB },
      { hostAvailableBytes: 9.5 * GIB, cgroup: group },
    );
    expect(resources.memoryHeadroomBytes).toBe(2 * GIB);
    expect(() => verificationConcurrency(undefined, resources)).toThrow();
    expect(cgroupMemoryHeadroom([{ limit: '100', current: '150' }])).toEqual({
      status: 'finite',
      headroomBytes: 0,
    });
    expect(cgroupMemoryHeadroom([{ limit: 'max' }])).toEqual({
      status: 'unlimited',
      headroomBytes: null,
    });
    expect(cgroupMemoryHeadroom([{ limit: '100' }])).toEqual({
      status: 'unknown',
      headroomBytes: null,
    });
  });
  it('resolves only this process cgroup and its mounted ancestors, for v2 and v1', () => {
    const mount = '31 20 0:29 / /sys/fs/cgroup rw - cgroup2 cgroup rw';
    expect(cgroupMemoryDirectories('0::/containers/own', mount)).toEqual({
      version: 2,
      directories: [
        '/sys/fs/cgroup/containers/own',
        '/sys/fs/cgroup/containers',
        '/sys/fs/cgroup',
      ],
    });
    expect(
      cgroupMemoryDirectories(
        '0::/containers/own/app',
        '31 20 0:29 /containers/own /sys/fs/cgroup rw - cgroup2 cgroup rw',
      ),
    ).toEqual({
      version: 2,
      directories: ['/sys/fs/cgroup/app', '/sys/fs/cgroup'],
    });
    expect(
      cgroupMemoryDirectories(
        '0::/other',
        '31 20 0:29 /containers/own /sys/fs/cgroup rw - cgroup2 cgroup rw',
      ),
    ).toBeNull();
    expect(cgroupMemoryDirectories('0::/../other', mount)).toBeNull();
    expect(
      cgroupMemoryDirectories(
        '3:memory:/cg/app',
        '32 20 0:30 /cg /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory',
      ),
    ).toEqual({
      version: 1,
      directories: ['/sys/fs/cgroup/memory/app', '/sys/fs/cgroup/memory'],
    });
  });
  it('keeps quick and direct quality at their own minimum and does not validate unused integration unit overrides', () => {
    const resources = memoryFixture(3);
    expect(
      parseVerificationArguments(['--profile', 'quick'], resources),
    ).toEqual({ profile: 'quick', concurrency: 1, concurrencyExplicit: false });
    expect(() =>
      parseVerificationArguments(
        ['--profile', 'quick', '--concurrency', '1'],
        resources,
      ),
    ).toThrow(/不接受/u);
    expect(verificationLaneResources('quality', 'quick', resources)).toBe(
      resources,
    );
    expect(() =>
      verificationLaneResources('integration-1', 'full', resources),
    ).toThrow();
    expect(() =>
      verificationLaneResources('quality', 'full', memoryFixture(2.4)),
    ).toThrow(/2.50/u);
    expect(
      verificationConfiguredUnitWorkers(2, resources, [
        '--project',
        'integration',
      ]),
    ).toBe(1);
    expect(
      verificationConfiguredUnitWorkers(2, resources, [
        '--project=integration',
      ]),
    ).toBe(1);
    expect(() =>
      verificationConfiguredUnitWorkers(2, resources, ['--project', 'unit']),
    ).toThrow();
    expect(() =>
      verificationConfiguredUnitWorkers(2, resources, [
        '--project',
        'integration',
        '--project',
        'unit',
      ]),
    ).toThrow();
    expect(
      verificationEnvironment({ FOLIOHAVEN_UNIT_WORKERS: '4' }, 'quality')
        .FOLIOHAVEN_UNIT_WORKERS,
    ).toBeUndefined();
    expect(
      verificationEnvironment({ FOLIOHAVEN_UNIT_WORKERS: '4' }, 'integration-1')
        .FOLIOHAVEN_UNIT_WORKERS,
    ).toBeUndefined();
  });
  it('retains full quality checks, serial supervisor and genuine per-browser Build', async () => {
    const { plan } = await planFixture();
    const paths = {
      unit: 'unit.json',
      integration: 'integration.json',
      playwright: 'playwright.json',
    };
    const full = laneSteps(plan, 'quality', 'full', paths);
    expect(full.map((step) => step.argv.join(' '))).toEqual(
      expect.arrayContaining([
        'pnpm run format:check',
        'pnpm run lint',
        'pnpm run check:compiler',
        'pnpm run typecheck',
        'pnpm run test:environment',
      ]),
    );
    expect(full.at(-1)?.files).toEqual([SERIAL_INTEGRATION_FILE]);
    const browser = laneSteps(plan, 'e2e-webkit', 'full', paths);
    expect(browser[0]?.argv).toEqual(['pnpm', 'run', 'build']);
    expect(browser[1]?.argv).toContain('--project=webkit');
    const quick = laneSteps(plan, 'quality', 'quick', paths);
    expect(quick.some((step) => step.argv.includes('test:environment'))).toBe(
      false,
    );
    expect(quick.at(-1)?.argv).toContain('--grep');
  });
  it('does not forward credentials or author runtime configuration', () => {
    const environment = verificationEnvironment(
      {
        PATH: '/bin',
        HOME: '/home/test',
        CLOUDFLARE_API_TOKEN: 'secret-placeholder',
        FOLIOHAVEN_PORT: '9999',
        ALFRED_PORT: '9998',
        NODE_OPTIONS: '--require malicious',
      },
      'quality',
    );
    expect(environment.PATH).toBe('/bin');
    for (const key of [
      'CLOUDFLARE_API_TOKEN',
      'FOLIOHAVEN_PORT',
      'ALFRED_PORT',
      'NODE_OPTIONS',
    ])
      expect(environment[key]).toBeUndefined();
    expect(environment.NPM_CONFIG_USERCONFIG).toBe('/dev/null');
  });
  it('validates real report file coverage and rejects failed or missing assertions', () => {
    const step = {
      argv: ['test'],
      framework: 'vitest' as const,
      report: '.foliohaven/reports/unit.json',
      files: ['tests/unit/a.test.ts'],
    };
    const value = {
      success: true,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      numTotalTests: 2,
      numPassedTests: 1,
      numPendingTests: 1,
      numTodoTests: 0,
      testResults: [{ name: '/snapshot/tests/unit/a.test.ts' }],
    };
    expect(
      summarizeFrameworkReport(value, step, '/snapshot', {
        browser: null,
        profile: 'full',
      }),
    ).toMatchObject({ total: 2, passed: 1, skipped: 1 });
    expect(() =>
      summarizeFrameworkReport(
        { ...value, testResults: [] },
        step,
        '/snapshot',
        { browser: null, profile: 'full' },
      ),
    ).toThrow();
    expect(() =>
      summarizeFrameworkReport(
        { ...value, numFailedTests: 1 },
        step,
        '/snapshot',
        { browser: null, profile: 'full' },
      ),
    ).toThrow();
    const browser = {
      ...step,
      framework: 'playwright' as const,
      files: ['tests/e2e/smoke.spec.ts'],
    };
    const report = {
      errors: [],
      stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
      suites: [
        {
          file: 'smoke.spec.ts',
          specs: [
            {
              file: 'smoke.spec.ts',
              tests: [
                { projectName: 'chromium', results: [{ status: 'passed' }] },
              ],
            },
          ],
        },
      ],
    };
    expect(
      summarizeFrameworkReport(report, browser, '/snapshot', {
        browser: 'chromium',
        profile: 'full',
      }),
    ).toMatchObject({ passed: 1 });
    expect(() =>
      summarizeFrameworkReport(report, browser, '/snapshot', {
        browser: 'chromium',
        profile: 'quick',
      }),
    ).toThrow();
    expect(() =>
      summarizeFrameworkReport(report, browser, '/snapshot', {
        browser: 'webkit',
        profile: 'full',
      }),
    ).toThrow();
  });
  it('bounds parallel work and cancels queued work after one failure', async () => {
    let current = 0;
    let maximum = 0;
    const result = await runBounded(
      [1, 2, 3, 4],
      2,
      async (value) => {
        current++;
        maximum = Math.max(maximum, current);
        await new Promise((done) => setTimeout(done, 5));
        current--;
        return value * 2;
      },
      new AbortController(),
    );
    expect(maximum).toBe(2);
    expect(result).toEqual([2, 4, 6, 8]);
    const seen: number[] = [];
    const controller = new AbortController();
    await expect(
      runBounded(
        [1, 2, 3],
        1,
        async (value) => {
          seen.push(value);
          throw new Error('failed');
        },
        controller,
      ),
    ).rejects.toThrow('failed');
    expect(seen).toEqual([1]);
    expect(controller.signal.aborted).toBe(true);
  });
  it('snapshots working bytes without Git or private state, preserving modes and refusing symlinks', async () => {
    const base = await fixture();
    const source = join(base, 'input');
    const destination = join(base, 'output');
    await put(
      source,
      'package.json',
      '{"name":"foliohaven","version":"1.0.0"}',
    );
    await put(
      source,
      'release/manifest.json',
      JSON.stringify({
        format: 1,
        rootFiles: ['package.json', 'release/manifest.json'],
        directories: ['content', 'scripts'],
        requiredFiles: ['package.json', 'content/example.json'],
        devcontainerTemplate: 'release/templates/devcontainer',
        githubTemplate: 'release/templates/github',
      }),
    );
    await put(source, 'content/example.json', '{"working":"uncommitted"}');
    await put(source, 'content/.env.local', 'excluded-placeholder');
    await put(source, '.git/invalid', 'not a Git checkout');
    await put(source, '.foliohaven/do-not-copy.json', 'private-placeholder');
    await put(source, 'scripts/example.mjs', 'export const sample = 1;');
    for (const path of [
      'devcontainer.json',
      'docker-compose.yml',
      'check-environment.sh',
    ])
      await put(source, `release/templates/devcontainer/${path}`, '{}');
    for (const path of [
      'workflows/check.yml',
      'workflows/release-verify.yml',
      'actions/prepare-verification/action.yml',
    ])
      await put(source, `release/templates/github/${path}`, 'public');
    await exportVerificationWorkspace({ sourceRoot: source, destination });
    expect(
      await readFile(join(destination, 'content/example.json'), 'utf8'),
    ).toContain('uncommitted');
    const info = JSON.parse(
      await readFile(join(destination, 'release-info.json'), 'utf8'),
    ) as { files: { path: string }[] };
    expect(info.files.map((entry) => entry.path)).toContain(
      '.github/actions/prepare-verification/action.yml',
    );
    expect(
      info.files.some((entry) =>
        /(?:\.git\/|\.foliohaven|\.env.local)/u.test(entry.path),
      ),
    ).toBe(false);
    await symlink('../package.json', join(source, 'scripts/link.mjs'));
    await expect(
      exportVerificationWorkspace({
        sourceRoot: source,
        destination: join(base, 'refused'),
      }),
    ).rejects.toMatchObject({ code: 'RELEASE_SOURCE_INVALID' });
  });
});
