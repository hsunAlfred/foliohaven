import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedProcess } from './managed-process.mjs';
import { ensurePrivateDirectory } from './private-directory.mjs';
import { pinPrivateDirectory, privateResource } from './workspace-paths.mjs';
import {
  describeVerificationSource,
  validateVerificationLane,
} from './verification-contract.mjs';
import {
  CORE_VERIFICATION_LANES,
  createVerificationPlan,
  expectedLaneCoverage,
  validateLaneCoverage,
  verificationError,
  verificationResources,
  verificationLaneResources,
} from './verification-plan.mjs';

/** Do not forward deployment credentials or an author's runtime overrides to test children. */
export function verificationEnvironment(environment = process.env, lane) {
  const result = {};
  for (const key of [
    'PATH',
    'HOME',
    'PNPM_HOME',
    'PLAYWRIGHT_BROWSERS_PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'CI',
    'SYSTEMROOT',
    'LD_LIBRARY_PATH',
    'FONTCONFIG_PATH',
  ])
    if (environment[key] !== undefined) result[key] = environment[key];
  return {
    ...result,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    ...(process.platform === 'linux'
      ? { TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' }
      : {}),
    NPM_CONFIG_USERCONFIG: '/dev/null',
    ...(lane ? { FOLIOHAVEN_VERIFICATION_LANE: lane } : {}),
  };
}

export function parseLaneArguments(args) {
  let lane;
  let scope = 'full';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--lane' && lane === undefined) lane = args[++index];
    else if (
      args[index] === '--profile' &&
      scope === 'full' &&
      args[index + 1] === 'quick'
    ) {
      scope = 'quick';
      index++;
    } else
      throw verificationError('VERIFY_ARGUMENT_INVALID', '驗證參數不合法。');
  }
  if (
    !CORE_VERIFICATION_LANES.includes(lane) ||
    (scope === 'quick' && lane !== 'quality')
  )
    throw verificationError(
      'VERIFY_ARGUMENT_INVALID',
      '請指定有效的驗證lane。',
    );
  return { lane, scope };
}

export function laneSteps(plan, lane, scope, paths) {
  const expected = expectedLaneCoverage(plan, lane, scope);
  const command = (...args) => ({ argv: ['pnpm', ...args] });
  const vitest = (project, files) => ({
    ...command(
      'exec',
      'vitest',
      'run',
      '--project',
      project,
      ...files,
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${paths[project]}`,
    ),
    framework: 'vitest',
    report: paths[project],
    files,
    project,
  });
  const playwright = () => ({
    ...command(
      'exec',
      'playwright',
      'test',
      ...expected.e2eFiles,
      `--project=${expected.browser}`,
      '--workers=1',
      ...(scope === 'quick' ? ['--grep', plan.quick.e2eGrep] : []),
    ),
    framework: 'playwright',
    report: paths.playwright,
    files: expected.e2eFiles,
  });
  if (lane === 'quality') {
    const steps = [
      'format:check',
      'lint',
      'check:compiler',
      'typecheck',
      scope === 'full' ? 'test:environment' : 'check:dependencies',
    ].map((name) => command('run', name));
    steps.push(
      vitest('unit', expected.unitFiles),
      vitest('integration', expected.integrationFiles),
    );
    if (scope === 'quick') steps.push(command('run', 'build'), playwright());
    return steps;
  }
  if (expected.browser) return [command('run', 'build'), playwright()];
  return [
    command('run', 'build:packages'),
    command('--filter', '@foliohaven/server', 'build'),
    vitest('integration', expected.integrationFiles),
  ];
}

function reportFile(root, value, prefix) {
  if (typeof value !== 'string')
    throw verificationError('VERIFY_REPORT_INVALID', '測試報告缺少來源檔案。');
  const absolute = isAbsolute(value)
    ? resolve(value)
    : resolve(root, prefix, value);
  const path = relative(root, absolute).replaceAll('\\', '/');
  if (path.startsWith('../') || isAbsolute(path))
    throw verificationError(
      'VERIFY_REPORT_INVALID',
      '測試報告來源超出工作區。',
    );
  return path;
}
function sameFiles(actual, expected) {
  return (
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}
export function summarizeFrameworkReport(value, step, root, scope) {
  const invalid = () => {
    throw verificationError(
      'VERIFY_REPORT_INVALID',
      '實際測試報告失敗、缺漏或不符合指定集合。',
    );
  };
  if (step.framework === 'vitest') {
    if (
      !value ||
      value.success !== true ||
      value.numFailedTests !== 0 ||
      value.numFailedTestSuites !== 0 ||
      !Array.isArray(value.testResults) ||
      !sameFiles(
        value.testResults.map((suite) => reportFile(root, suite.name, '')),
        step.files,
      )
    )
      invalid();
    const total = value.numTotalTests;
    const passed = value.numPassedTests;
    const skipped = (value.numPendingTests ?? 0) + (value.numTodoTests ?? 0);
    if (
      ![total, passed, skipped].every(Number.isSafeInteger) ||
      total < 1 ||
      passed + skipped !== total
    )
      invalid();
    return {
      framework: 'vitest',
      path: step.report,
      total,
      passed,
      failed: 0,
      skipped,
    };
  }
  if (
    !value ||
    !Array.isArray(value.suites) ||
    !Array.isArray(value.errors) ||
    value.errors.length ||
    !value.stats ||
    value.stats.unexpected !== 0 ||
    value.stats.flaky !== 0
  )
    invalid();
  const files = new Set();
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      files.add(reportFile(root, spec.file ?? suite.file, 'tests/e2e'));
      for (const test of spec.tests ?? [])
        if (
          test.projectName !== scope.browser ||
          test.results?.some((result) =>
            ['failed', 'timedOut', 'interrupted'].includes(result.status),
          )
        )
          invalid();
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of value.suites) visit(suite);
  const passed = value.stats.expected;
  const skipped = value.stats.skipped;
  const total = passed + skipped;
  if (
    !sameFiles([...files], step.files) ||
    ![total, passed, skipped].every(Number.isSafeInteger) ||
    total < 1 ||
    (scope.profile === 'quick' &&
      (total !== 2 || passed !== 2 || skipped !== 0))
  )
    invalid();
  return {
    framework: 'playwright',
    path: step.report,
    total,
    passed,
    failed: 0,
    skipped,
  };
}

export async function writeVerificationJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, path);
}

export async function runVerificationLane(options = {}) {
  const root = resolve(options.root);
  const unpin = pinPrivateDirectory(root);
  try {
    return await runVerificationLanePinned({ ...options, root });
  } finally {
    unpin();
  }
}

async function runVerificationLanePinned({
  root,
  lane,
  scope = 'full',
  signal,
  onProcess,
} = {}) {
  root = resolve(root);
  if (signal?.aborted)
    throw verificationError('VERIFY_CANCELLED', '驗證已中止。');
  const descriptor = await describeVerificationSource(root);
  const resources = await verificationResources();
  verificationLaneResources(lane, scope, resources);
  const plan = await createVerificationPlan(root);
  const expected = expectedLaneCoverage(plan, lane, scope);
  const resource = privateResource(
    root,
    `reports/verification/framework/${lane}`,
  );
  ensurePrivateDirectory(root, resource);
  const receiptPath = join(
    root,
    privateResource(root, `reports/verification/${lane}.json`),
  );
  const paths = Object.fromEntries(
    ['unit', 'integration', 'playwright'].map((name) => [
      name,
      `${resource}/${name}.json`,
    ]),
  );
  const receipt = {
    ...descriptor,
    schemaVersion: 1,
    lane,
    scope,
    status: 'running',
    startedAt: new Date().toISOString(),
    commands: [],
    coverage: { planDigest: plan.planDigest, ...expected, reports: [] },
  };
  await writeVerificationJson(receiptPath, receipt);
  let active;
  const abort = () => {
    void active?.stop();
  };
  signal?.addEventListener('abort', abort);
  try {
    for (const step of laneSteps(plan, lane, scope, paths)) {
      if (signal?.aborted)
        throw verificationError('VERIFY_CANCELLED', '驗證已中止。');
      process.stdout.write(`[${lane}] ${step.argv.join(' ')}\n`);
      if (step.framework) await rm(join(root, step.report), { force: true });
      active = managedProcess(step.argv[0], step.argv.slice(1), {
        cwd: root,
        env: verificationEnvironment(process.env, lane),
        stopGraceMs: 12_000,
      });
      onProcess?.(active);
      const result = await active.done;
      receipt.commands.push({
        argv: step.argv,
        cwd: '.',
        exitCode: result.code,
      });
      if (signal?.aborted)
        throw verificationError('VERIFY_CANCELLED', '驗證已中止。');
      if (result.code !== 0)
        throw verificationError('VERIFY_FAILED', '必要驗證命令失敗。');
      if (step.framework) {
        let report;
        try {
          report = JSON.parse(await readFile(join(root, step.report), 'utf8'));
        } catch {
          throw verificationError(
            'VERIFY_REPORT_INVALID',
            '無法讀取實際測試報告。',
          );
        }
        receipt.coverage.reports.push(
          summarizeFrameworkReport(report, step, root, {
            browser: expected.browser,
            profile: scope,
          }),
        );
      }
    }
    const after = await describeVerificationSource(root);
    if (JSON.stringify(descriptor) !== JSON.stringify(after))
      throw verificationError('VERIFY_SOURCE_CHANGED', '驗證過程中來源變更。');
    receipt.status = 'passed';
    receipt.completedAt = new Date().toISOString();
    validateLaneCoverage(plan, receipt);
    validateVerificationLane(receipt, descriptor, { lane, scope });
    await writeVerificationJson(receiptPath, receipt);
    return receipt;
  } catch (error) {
    receipt.status = signal?.aborted ? 'cancelled' : 'failed';
    receipt.completedAt = new Date().toISOString();
    receipt.error = {
      code: /^[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'VERIFY_FAILED',
    };
    await writeVerificationJson(receiptPath, receipt);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await active?.stop();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runVerificationLane({
      root: fileURLToPath(new URL('../', import.meta.url)),
      ...parseLaneArguments(process.argv.slice(2)),
      signal: controller.signal,
    });
  } catch (error) {
    process.stderr.write(
      `${/^[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'VERIFY_FAILED'}：${['VERIFY_RESOURCE_INSUFFICIENT', 'VERIFY_CONCURRENCY_INVALID', 'VERIFY_RESOURCE_INVALID', 'VERIFY_ARGUMENT_INVALID'].includes(error?.code) ? error.message : '驗證未完成，請檢查上述命令輸出。'}\n`,
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
