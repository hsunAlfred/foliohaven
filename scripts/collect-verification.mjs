import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAX_VERIFICATION_JSON_BYTES,
  RELEASE_VERIFICATION_LANES,
  VerificationContractError,
  describeVerificationSource,
  validateVerificationEvidence,
  validateVerificationLane,
} from './verification-contract.mjs';
import {
  CORE_VERIFICATION_LANES,
  createVerificationPlan,
  validateVerificationCoverage,
} from './verification-plan.mjs';

const fail = (code) => {
  throw new VerificationContractError(code);
};
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (stat) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(
    ':',
  );

async function regularJson(path) {
  const absolute = resolve(path);
  let current = dirname(absolute);
  for (;;) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('VERIFICATION_REPORT_INVALID');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_VERIFICATION_JSON_BYTES))
      fail('VERIFICATION_REPORT_INVALID');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (identity(before) !== identity(after))
      fail('VERIFICATION_REPORT_CHANGED');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    await handle.close();
  }
}

async function save(path, value) {
  if (!isAbsolute(path)) fail('VERIFICATION_OUTPUT_INVALID');
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (let current = parent; ; current = dirname(current)) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('VERIFICATION_OUTPUT_INVALID');
    if (current === dirname(current)) break;
  }
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_VERIFICATION_JSON_BYTES)
    fail('VERIFICATION_OUTPUT_INVALID');
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const nativePhases = [
  'three-services-and-health',
  'studio-article-media-and-build',
  'editable-source-watch-and-restore',
  'restart-source-media-and-artifact-preserved',
];
const uidPhases = [
  'image',
  'source',
  'volume',
  'seed',
  'bootstrap',
  'first-start',
  'author-save-build',
  'first-stop',
  'restart',
  'preserved',
  'cleanup',
];
const uidChecks = [
  'coldDependencies',
  'offlineWarmStore',
  'nonRootIdentity',
  'realFlock',
  'privateStateOwned',
  'articleSaved',
  'mediaSaved',
  'successfulBuildPreserved',
  'restartedContainer',
  'gracefulStop',
  'ownResourcesRemoved',
];

/** Validate real acceptance reports before recording a safe public summary. */
export function validateExternalAcceptance(lane, value, sourceInfoDigest) {
  if (lane === 'native') {
    if (
      !object(value) ||
      value.status !== 'passed' ||
      value.scope !== 'linux-native-without-git' ||
      !Number.isInteger(value.uid) ||
      value.uid <= 0 ||
      !Array.isArray(value.phases) ||
      value.phases.length !== nativePhases.length ||
      nativePhases.some((phase) => !value.phases.includes(phase)) ||
      !Array.isArray(value.applications) ||
      value.applications.length !== 2 ||
      value.applications.some(
        (app) =>
          !object(app) ||
          app.exit?.code !== 0 ||
          app.exit?.signal !== null ||
          app.forced !== false ||
          app.closeObserved !== true ||
          app.portsReleased !== true,
      )
    )
      fail('VERIFICATION_ACCEPTANCE_INVALID');
    return {
      kind: 'native',
      phases: [...nativePhases],
      uid: value.uid,
      normalShutdowns: 2,
    };
  }
  const uid = /^uid-(\d+)-(\d+)$/u.exec(lane);
  if (uid) {
    if (
      !object(value) ||
      value.schemaVersion !== 1 ||
      value.scope !== 'docker-uid' ||
      value.status !== 'passed' ||
      value.exitCode !== 0 ||
      value.uid !== Number(uid[1]) ||
      value.gid !== Number(uid[2]) ||
      value.publicSourceDigest !== sourceInfoDigest ||
      value.network !== 'none' ||
      value.hostPortsPublished !== false ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.imageId ?? '') ||
      !/^[a-f0-9]{64}$/u.test(value.firstContainer ?? '') ||
      !/^[a-f0-9]{64}$/u.test(value.restartedContainer ?? '') ||
      value.firstContainer === value.restartedContainer ||
      !Array.isArray(value.steps) ||
      value.steps.length !== uidPhases.length ||
      uidPhases.some(
        (phase) =>
          value.steps.filter(
            (step) => step.phase === phase && step.status === 'passed',
          ).length !== 1,
      ) ||
      !object(value.checks) ||
      uidChecks.some((key) => value.checks[key] !== true)
    )
      fail('VERIFICATION_ACCEPTANCE_INVALID');
    return {
      kind: 'uid',
      uid: value.uid,
      gid: value.gid,
      sourceInfoDigest,
      phases: [...uidPhases],
      checks: Object.fromEntries(uidChecks.map((key) => [key, true])),
    };
  }
  if (lane === 'docker') {
    const { prepare, verify, dryRun, completed } = value ?? {};
    if (
      completed !== true ||
      !object(prepare) ||
      !object(verify) ||
      !object(dryRun) ||
      [prepare, verify].some(
        (report) =>
          report.scope !== 'docker' ||
          report.articleSaved !== true ||
          report.mediaSaved !== true ||
          report.artifactUnchanged !== true ||
          !Number.isInteger(report.environment?.uid) ||
          report.environment.uid <= 0,
      ) ||
      prepare.environment.uid !== verify.environment.uid ||
      dryRun.status !== 'passed' ||
      dryRun.commandExitCode !== 0 ||
      dryRun.remoteWrites !== false ||
      dryRun.credentialsCreated !== false ||
      dryRun.fakeConfigCleanup !== 'removed-own-file' ||
      dryRun.uploadStatus !== 'dry-run'
    )
      fail('VERIFICATION_ACCEPTANCE_INVALID');
    return {
      kind: 'docker',
      authoringPreserved: true,
      artifactPreserved: true,
      coldStartAndRebuild: true,
      remoteWrites: false,
      uid: verify.environment.uid,
    };
  }
  fail('VERIFICATION_LANE_INVALID');
}

async function externalResult(lane, result) {
  if (lane === 'docker') {
    const entries = await readdir(result, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    if (
      directories.length !== 1 ||
      entries.some((entry) => entry.isSymbolicLink())
    )
      fail('VERIFICATION_ACCEPTANCE_INVALID');
    const directory = join(result, directories[0].name);
    const child = join(directory, 'release-docker-check');
    const logPath = join(directory, 'compose.log');
    const stat = await lstat(logPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      fail('VERIFICATION_ACCEPTANCE_INVALID');
    const log = await readFile(logPath, 'utf8');
    return {
      prepare: await regularJson(join(child, 'prepare.json')),
      verify: await regularJson(join(child, 'verify.json')),
      dryRun: await regularJson(join(child, 'cloudflare-dry-run.json')),
      completed: /Docker release 驗收通過；報告：/u.test(log),
    };
  }
  const value = await regularJson(result);
  if (lane.startsWith('uid-') && value.reportPath) {
    if (
      typeof value.reportPath !== 'string' ||
      !isAbsolute(value.reportPath) ||
      dirname(value.reportPath).includes('/../')
    )
      fail('VERIFICATION_REPORT_INVALID');
    // Only an adjacent, disposable-run report can be selected by the latest pointer.
    const relativeRoot = `${resolve(dirname(result))}/`;
    if (!resolve(value.reportPath).startsWith(relativeRoot))
      fail('VERIFICATION_REPORT_INVALID');
    return regularJson(value.reportPath);
  }
  return value;
}

export function assembleVerificationEvidence({
  descriptor,
  plan,
  lanes,
  context,
}) {
  if (
    !object(context) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(context.repository ?? '') ||
    !/^refs\/(?:heads|tags)\/[A-Za-z0-9_./-]+$/u.test(context.ref ?? '') ||
    !/^[a-f0-9]{40}$/u.test(context.checkoutSha ?? '') ||
    !Number.isSafeInteger(context.runId) ||
    context.runId <= 0 ||
    !Number.isSafeInteger(context.runAttempt) ||
    context.runAttempt <= 0
  )
    fail('VERIFICATION_EVIDENCE_INVALID');
  if (
    !Array.isArray(lanes) ||
    lanes.length !== RELEASE_VERIFICATION_LANES.length
  )
    fail('VERIFICATION_EVIDENCE_INVALID');
  for (const lane of lanes) {
    validateVerificationLane(lane, descriptor);
    if (
      !CORE_VERIFICATION_LANES.includes(lane.lane) &&
      (!object(lane.acceptance) ||
        lane.acceptance.kind !==
          (lane.lane.startsWith('uid-') ? 'uid' : lane.lane))
    )
      fail('VERIFICATION_ACCEPTANCE_INVALID');
    if (lane.coverage.planDigest !== plan.planDigest)
      fail('VERIFICATION_COVERAGE_INVALID');
  }
  validateVerificationCoverage(plan, lanes);
  const result = {
    ...descriptor,
    scope: 'full',
    status: 'passed',
    repository: context.repository,
    ref: context.ref,
    checkoutSha: context.checkoutSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    createdAt: new Date().toISOString(),
    lanes: [...lanes].sort((a, b) => a.lane.localeCompare(b.lane, 'en')),
  };
  return validateVerificationEvidence(result, {
    descriptor,
    repository: context.repository,
    ref: context.ref,
    checkoutSha: context.checkoutSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
  });
}

export async function recordExternalVerification({
  source,
  lane,
  result,
  output,
}) {
  if (
    CORE_VERIFICATION_LANES.includes(lane) ||
    !RELEASE_VERIFICATION_LANES.includes(lane)
  )
    fail('VERIFICATION_LANE_INVALID');
  const descriptor = await describeVerificationSource(source, {
    requirePublicExport: true,
  });
  const plan = await createVerificationPlan(source);
  const sourceInfoDigest = createHash('sha256')
    .update(await readFile(join(source, 'release-info.json')))
    .digest('hex');
  const acceptance = validateExternalAcceptance(
    lane,
    await externalResult(lane, result),
    sourceInfoDigest,
  );
  const argv =
    lane === 'docker'
      ? ['bash', 'scripts/check-release-docker.sh']
      : lane === 'native'
        ? [
            'node',
            'scripts/check-release-native.mjs',
            '--source',
            '$RUNNER_TEMP/native-workspace',
          ]
        : [
            'bash',
            'scripts/check-release-uids.sh',
            '--uid',
            String(acceptance.uid),
            '--gid',
            String(acceptance.gid),
          ];
  const receipt = {
    ...descriptor,
    lane,
    scope: 'full',
    status: 'passed',
    acceptance,
    commands: [{ argv, exitCode: 0, temporaryPathsOmitted: true }],
    coverage: {
      planDigest: plan.planDigest,
      unitFiles: [],
      integrationFiles: [],
      e2eFiles: [],
      browser: null,
      reports: [],
    },
  };
  validateVerificationLane(receipt, descriptor, { lane });
  await save(output, receipt);
  return receipt;
}

export async function collectVerification({
  source,
  reports,
  output,
  context,
}) {
  const descriptor = await describeVerificationSource(source, {
    requirePublicExport: true,
  });
  const plan = await createVerificationPlan(source);
  const entries = await readdir(reports, { withFileTypes: true });
  if (
    entries.length !== RELEASE_VERIFICATION_LANES.length ||
    entries.some(
      (entry) =>
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !RELEASE_VERIFICATION_LANES.some(
          (lane) => entry.name === `${lane}.json`,
        ),
    )
  )
    fail('VERIFICATION_EVIDENCE_INVALID');
  const lanes = await Promise.all(
    entries.map(async (entry) => {
      const value = await regularJson(join(reports, entry.name));
      return validateVerificationLane(value, descriptor, {
        lane: entry.name.slice(0, -'.json'.length),
      });
    }),
  );
  const evidence = assembleVerificationEvidence({
    descriptor,
    plan,
    lanes,
    context,
  });
  await save(output, evidence);
  return evidence;
}

function argumentsFor(argv) {
  const [mode, ...args] = argv;
  const allowed =
    mode === 'record'
      ? new Set(['source', 'lane', 'result', 'output'])
      : mode === 'collect'
        ? new Set([
            'source',
            'reports',
            'output',
            'repository',
            'ref',
            'sha',
            'run-id',
            'run-attempt',
          ])
        : fail('VERIFICATION_ARGUMENT_INVALID');
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/u, '');
    const value = args[index + 1];
    if (
      !args[index]?.startsWith('--') ||
      !allowed.has(key) ||
      key in result ||
      !value ||
      value.startsWith('--') ||
      /\p{Cc}/u.test(value)
    )
      fail('VERIFICATION_ARGUMENT_INVALID');
    result[key] = value;
  }
  if ([...allowed].some((key) => !(key in result)))
    fail('VERIFICATION_ARGUMENT_INVALID');
  if (
    mode === 'collect' &&
    (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(result.repository) ||
      !/^refs\/(?:heads|tags)\/[A-Za-z0-9_./-]+$/u.test(result.ref) ||
      !/^[a-f0-9]{40}$/u.test(result.sha) ||
      !/^[1-9]\d*$/u.test(result['run-id']) ||
      !/^[1-9]\d*$/u.test(result['run-attempt']))
  )
    fail('VERIFICATION_ARGUMENT_INVALID');
  return { mode, ...result };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const args = argumentsFor(process.argv.slice(2));
    const result =
      args.mode === 'record'
        ? await recordExternalVerification(args)
        : await collectVerification({
            ...args,
            context: {
              repository: args.repository,
              ref: args.ref,
              checkoutSha: args.sha,
              runId: Number(args['run-id']),
              runAttempt: Number(args['run-attempt']),
            },
          });
    process.stdout.write(
      `${JSON.stringify({
        status: result.status,
        scope: result.scope,
        lane: result.lane ?? null,
        sourceFingerprint: result.sourceFingerprint,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof VerificationContractError ? error.code : 'VERIFICATION_COLLECTION_FAILED'}：驗收資料不完整或來源無法確認，已停止。\n`,
    );
    process.exitCode = 1;
  }
}
