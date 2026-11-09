import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const CORE_VERIFICATION_LANES = Object.freeze([
  'quality',
  'integration-1',
  'integration-2',
  'e2e-chromium',
  'e2e-firefox',
  'e2e-webkit',
]);
export const SERIAL_INTEGRATION_FILE =
  'tests/integration/dev-supervisor.test.ts';
export const QUICK_INTEGRATION_FILES = Object.freeze([
  'tests/integration/cloudflare-config-workflow.test.ts',
  'tests/integration/http.test.ts',
  'tests/integration/private-directories.test.ts',
  'tests/integration/render-environment.test.ts',
  'tests/integration/studio-client.test.ts',
  'tests/integration/workspace-directory-compat.test.ts',
]);
export const QUICK_E2E_FILES = Object.freeze([
  'tests/e2e/public-site.spec.ts',
  'tests/e2e/studio-settings-sections.spec.ts',
]);
export const QUICK_E2E_GREP = [
  'the actual root dist follows current public source models without JavaScript at 375px',
  '全站設定初載只讀取一份設定，SEO不預抓首頁文章，開過的分區保留搜尋與緩衝',
].join('|');

export function verificationError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function filesBelow(root, directory, pattern) {
  const files = [];
  async function visit(relative) {
    for (const item of await readdir(join(root, relative), {
      withFileTypes: true,
    })) {
      const path = `${relative}/${item.name}`;
      if (item.isSymbolicLink())
        throw verificationError(
          'VERIFY_SOURCE_INVALID',
          '驗證來源不可包含符號連結。',
        );
      if (item.isDirectory()) await visit(path);
      else if (item.isFile() && pattern.test(item.name)) files.push(path);
    }
  }
  await visit(directory);
  return files.sort();
}

function coverage(
  unitFiles = [],
  integrationFiles = [],
  e2eFiles = [],
  browser = null,
) {
  return { unitFiles, integrationFiles, e2eFiles, browser };
}

/** Whole-file deterministic partitions: no assertion, test or platform skip is removed. */
export async function createVerificationPlan(sourceRoot) {
  const [unitFiles, integrationFiles, e2eFiles] = await Promise.all([
    filesBelow(sourceRoot, 'tests/unit', /\.test\.(?:ts|tsx|mts)$/u),
    filesBelow(sourceRoot, 'tests/integration', /\.test\.(?:ts|tsx|mts)$/u),
    filesBelow(sourceRoot, 'tests/e2e', /\.spec\.ts$/u),
  ]);
  if (
    !unitFiles.length ||
    !e2eFiles.length ||
    !integrationFiles.includes(SERIAL_INTEGRATION_FILE)
  )
    throw verificationError(
      'VERIFY_PLAN_INVALID',
      '必要驗證集合或固定埠測試不存在。',
    );
  for (const file of QUICK_INTEGRATION_FILES)
    if (!integrationFiles.includes(file))
      throw verificationError(
        'VERIFY_PLAN_INVALID',
        '快速驗證的必要整合案例不存在。',
      );
  for (const file of QUICK_E2E_FILES)
    if (!e2eFiles.includes(file))
      throw verificationError(
        'VERIFY_PLAN_INVALID',
        '快速驗證的必要瀏覽器案例不存在。',
      );
  const weighted = await Promise.all(
    integrationFiles
      .filter((file) => file !== SERIAL_INTEGRATION_FILE)
      .map(async (file) => ({
        file,
        // File size balances large suites; native SSG cases retain an explicit cost allowance.
        weight:
          (await stat(join(sourceRoot, file))).size +
          (/\/(?:build-reproducibility|samples|site-render|studio-production)\.test\.tsx?$/u.test(
            file,
          )
            ? 80_000
            : 0),
      })),
  );
  weighted.sort(
    (a, b) => b.weight - a.weight || a.file.localeCompare(b.file, 'en'),
  );
  const shards = [[], []];
  const loads = [0, 0];
  for (const item of weighted) {
    const index = loads[0] <= loads[1] ? 0 : 1;
    shards[index].push(item.file);
    loads[index] += item.weight;
  }
  const lanes = {
    quality: coverage(unitFiles, [SERIAL_INTEGRATION_FILE]),
    'integration-1': coverage([], shards[0].sort()),
    'integration-2': coverage([], shards[1].sort()),
    'e2e-chromium': coverage([], [], e2eFiles, 'chromium'),
    'e2e-firefox': coverage([], [], e2eFiles, 'firefox'),
    'e2e-webkit': coverage([], [], e2eFiles, 'webkit'),
  };
  const plan = {
    schemaVersion: 1,
    unitFiles,
    integrationFiles,
    e2eFiles,
    lanes,
    quick: {
      integrationFiles: [...QUICK_INTEGRATION_FILES],
      e2eFiles: [...QUICK_E2E_FILES],
      e2eGrep: QUICK_E2E_GREP,
    },
  };
  return {
    ...plan,
    planDigest: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
  };
}

export function expectedLaneCoverage(plan, lane, scope = 'full') {
  if (scope === 'quick' && lane === 'quality')
    return coverage(
      plan.unitFiles,
      plan.quick.integrationFiles,
      plan.quick.e2eFiles,
      'chromium',
    );
  if (scope !== 'full' || !Object.hasOwn(plan.lanes, lane))
    throw verificationError('VERIFY_PLAN_INVALID', '驗證範圍或lane不合法。');
  return plan.lanes[lane];
}

function sameFiles(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.every((file) => typeof file === 'string') &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

export function validateLaneCoverage(plan, receipt) {
  const expected = expectedLaneCoverage(plan, receipt.lane, receipt.scope);
  const actual = receipt.coverage;
  if (
    !actual ||
    actual.planDigest !== plan.planDigest ||
    actual.browser !== expected.browser ||
    !['unitFiles', 'integrationFiles', 'e2eFiles'].every((key) =>
      sameFiles(actual[key], expected[key]),
    )
  )
    throw verificationError(
      'VERIFY_COVERAGE_INVALID',
      '驗證結果的測試集合缺漏、重複或不符合本次計畫。',
    );
  return receipt;
}

export function validateVerificationCoverage(plan, receipts) {
  for (const lane of CORE_VERIFICATION_LANES) {
    const values = receipts.filter((receipt) => receipt.lane === lane);
    if (
      values.length !== 1 ||
      values[0].scope !== 'full' ||
      values[0].status !== 'passed'
    )
      throw verificationError(
        'VERIFY_COVERAGE_INVALID',
        '完整驗證缺少成功lane或含重複lane。',
      );
    validateLaneCoverage(plan, values[0]);
  }
  return true;
}

export {
  effectiveVerificationResources,
  verificationResources,
  verificationConcurrency,
  verificationUnitWorkers,
  effectiveMemoryHeadroom,
  cgroupMemoryDirectories,
  cgroupMemoryHeadroom,
  parseMemAvailable,
  verificationLaneResources,
  verificationResourceMessage,
  verificationConfiguredUnitWorkers,
} from './verification-resources.mjs';
