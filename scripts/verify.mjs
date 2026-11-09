import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedProcess } from './managed-process.mjs';
import { ensurePrivateDirectory } from './private-directory.mjs';
import { pinPrivateDirectory, privateResource } from './workspace-paths.mjs';
import { exportVerificationWorkspace } from './release-source.mjs';
import { describeVerificationSource } from './verification-contract.mjs';
import {
  CORE_VERIFICATION_LANES,
  createVerificationPlan,
  validateVerificationCoverage,
  verificationConcurrency,
  verificationError,
  verificationResources,
  verificationLaneResources,
} from './verification-plan.mjs';
import {
  verificationEnvironment,
  writeVerificationJson,
} from './verify-lane.mjs';

export function parseVerificationArguments(args, resources) {
  let profile = 'full';
  let concurrency;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option))
      throw verificationError('VERIFY_ARGUMENT_INVALID', '驗證參數重複。');
    seen.add(option);
    if (option === '--profile' && ['quick', 'full'].includes(args[index + 1]))
      profile = args[++index];
    else if (
      option === '--concurrency' &&
      /^[1-4]$/u.test(args[index + 1] ?? '')
    )
      concurrency = args[++index];
    else throw verificationError('VERIFY_ARGUMENT_INVALID', '驗證參數不合法。');
  }
  if (profile === 'quick' && concurrency !== undefined)
    throw verificationError(
      'VERIFY_ARGUMENT_INVALID',
      '快速驗證只有一個 lane，不接受 --concurrency；請移除此參數。',
    );
  if (profile === 'quick')
    verificationLaneResources('quality', 'quick', resources);
  return {
    profile,
    concurrency:
      profile === 'quick' ? 1 : verificationConcurrency(concurrency, resources),
    concurrencyExplicit: concurrency !== undefined,
  };
}

/** Private maintainer files are excluded from public snapshots but retain root static checks. */
export async function maintainerRootSteps(root) {
  for (const path of ['scripts', 'scripts/maintainer']) {
    let entry;
    try {
      entry = await lstat(join(root, path));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw verificationError(
        'VERIFY_MAINTAINER_DIRECTORY_INVALID',
        '維護工具必須位於一般目錄，不可使用符號連結。',
      );
  }
  return [
    ['pnpm', 'run', 'format:check'],
    ['pnpm', 'run', 'lint'],
  ];
}

/** Bounded queue; the first failure prevents unstarted jobs and cancels only this run. */
export async function runBounded(items, concurrency, run, controller) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw verificationError(
      'VERIFY_CONCURRENCY_INVALID',
      '平行工作數必須為 1–4 的整數。',
    );
  let next = 0;
  let failure;
  const results = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!controller.signal.aborted) {
        const index = next++;
        if (index >= items.length) break;
        try {
          results[index] = await run(items[index], controller.signal);
        } catch (error) {
          failure ??= error;
          controller.abort();
        }
      }
    }),
  );
  if (failure) throw failure;
  if (controller.signal.aborted || results.some((value) => value === undefined))
    throw verificationError('VERIFY_CANCELLED', '驗證已中止。');
  return results;
}

async function assertAuthorPortsAvailable() {
  for (const port of [4321, 5173, 3001]) {
    const available = await new Promise((fulfill, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.setTimeout(1000);
      socket.once('connect', () => {
        socket.destroy();
        fulfill(false);
      });
      socket.once('error', (error) => {
        socket.destroy();
        if (error.code === 'ECONNREFUSED') fulfill(true);
        else reject(error);
      });
      socket.once('timeout', () => {
        socket.destroy();
        fulfill(false);
      });
    });
    if (!available)
      throw verificationError(
        'VERIFY_AUTHOR_SERVICE_ACTIVE',
        '完整驗證需要空的 4321／5173／3001；請先保存並停止自己的作者服務。',
      );
  }
}

export async function runVerification(options = {}) {
  const root = resolve(options.root);
  const unpin = pinPrivateDirectory(root);
  try {
    return await runVerificationPinned({ ...options, root });
  } finally {
    unpin();
  }
}

async function runVerificationPinned({
  root,
  profile = 'full',
  concurrency,
  concurrencyExplicit = concurrency !== undefined,
  controller = new AbortController(),
} = {}) {
  root = resolve(root);
  if (!['full', 'quick'].includes(profile))
    throw verificationError(
      'VERIFY_ARGUMENT_INVALID',
      '驗證範圍或平行工作數不合法。',
    );
  if (controller.signal.aborted)
    throw verificationError('VERIFY_CANCELLED', '驗證已中止。');
  const requestedConcurrency = concurrencyExplicit ? concurrency : undefined;
  if (profile === 'quick' && concurrencyExplicit)
    throw verificationError(
      'VERIFY_ARGUMENT_INVALID',
      '快速驗證只有一個 lane，不接受 --concurrency；請移除此參數。',
    );
  const resources = await verificationResources();
  if (profile === 'quick')
    verificationLaneResources('quality', 'quick', resources);
  concurrency =
    profile === 'quick'
      ? 1
      : verificationConcurrency(requestedConcurrency, resources);
  if (profile === 'full') await assertAuthorPortsAvailable();
  const runId = randomUUID();
  const resource = privateResource(root, `reports/verification/runs/${runId}`);
  const reportRoot = ensurePrivateDirectory(root, resource);
  const temporary = await mkdtemp(
    join(
      process.platform === 'linux' ? '/tmp' : tmpdir(),
      'foliohaven-verification-',
    ),
  );
  await chmod(temporary, 0o700);
  const active = new Set();
  const run = async (
    cwd,
    argv,
    env = verificationEnvironment(),
    capture = false,
  ) => {
    if (controller.signal.aborted)
      throw verificationError('VERIFY_CANCELLED', '驗證已中止。');
    const command = capture ? { argv, cwd: '.', exitCode: null } : undefined;
    if (command) {
      summary.commands.push(command);
      process.stdout.write(`[root] ${argv.join(' ')}\n`);
    }
    const child = managedProcess(argv[0], argv.slice(1), {
      cwd,
      env,
      stopGraceMs: 30_000,
    });
    active.add(child);
    try {
      const result = await child.done;
      if (command) command.exitCode = result.code;
      if (controller.signal.aborted)
        throw verificationError('VERIFY_CANCELLED', '驗證已中止。');
      if (result.code !== 0)
        throw verificationError('VERIFY_FAILED', '必要驗證命令失敗。');
    } finally {
      active.delete(child);
      await child.stop();
    }
  };
  const stop = () => {
    void Promise.allSettled([...active].map((child) => child.stop()));
  };
  controller.signal.addEventListener('abort', stop);
  const summary = {
    schemaVersion: 1,
    scope: profile,
    status: 'running',
    runId,
    startedAt: new Date().toISOString(),
    resources,
    concurrency,
    resourceSnapshots: [
      {
        stage: 'start',
        observedAt: new Date().toISOString(),
        resources,
        concurrency,
      },
    ],
    commands: [],
    lanes: [],
  };
  await writeVerificationJson(join(reportRoot, 'summary.json'), summary);
  try {
    for (const argv of await maintainerRootSteps(root))
      await run(root, argv, verificationEnvironment(), true);
    const baseline = join(temporary, 'baseline');
    await exportVerificationWorkspace({
      sourceRoot: root,
      destination: baseline,
    });
    const descriptor = await describeVerificationSource(baseline, {
      requirePublicExport: true,
    });
    Object.assign(summary, descriptor);
    const plan = await createVerificationPlan(baseline);
    const runLane = async (lane) => {
      const workspace = join(temporary, lane);
      await exportVerificationWorkspace({
        sourceRoot: baseline,
        destination: workspace,
      });
      // Separate installs are intentional: workspace links and compiler outputs may never be shared.
      await run(workspace, [
        'pnpm',
        'install',
        '--offline',
        '--frozen-lockfile',
        '--prod=false',
      ]);
      try {
        await run(workspace, [
          'node',
          'scripts/verify-lane.mjs',
          '--lane',
          lane,
          ...(profile === 'quick' ? ['--profile', 'quick'] : []),
        ]);
      } finally {
        const destination = ensurePrivateDirectory(root, `${resource}/${lane}`);
        const sourceReports = join(
          workspace,
          privateResource(workspace, 'reports/verification'),
        );
        await cp(sourceReports, destination, {
          recursive: true,
          force: false,
        }).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      const receipt = JSON.parse(
        await readFile(
          join(
            workspace,
            privateResource(workspace, `reports/verification/${lane}.json`),
          ),
          'utf8',
        ),
      );
      if (receipt.sourceFingerprint !== descriptor.sourceFingerprint)
        throw verificationError(
          'VERIFY_SOURCE_CHANGED',
          'lane與基準來源不一致。',
        );
      receipt.coverage.reports = receipt.coverage.reports.map((report) => ({
        ...report,
        path: `${resource}/${lane}/${report.path.split('/reports/verification/')[1]}`,
      }));
      await writeVerificationJson(
        join(root, privateResource(root, `reports/verification/${lane}.json`)),
        receipt,
      );
      summary.lanes.push(receipt);
      return receipt;
    };
    await runLane('quality');
    if (profile === 'full') {
      // Preserve the established contract: a successful full verify also produces the root website.
      await run(root, ['pnpm', 'run', 'build']);
      const queueResources = await verificationResources();
      const queueSnapshot = {
        stage: 'heavy-queue',
        observedAt: new Date().toISOString(),
        resources: queueResources,
        concurrency: null,
      };
      summary.resourceSnapshots.push(queueSnapshot);
      summary.resources = queueResources;
      summary.concurrency = 0;
      concurrency = verificationConcurrency(
        requestedConcurrency,
        queueResources,
      );
      queueSnapshot.concurrency = concurrency;
      summary.concurrency = concurrency;
      await runBounded(
        CORE_VERIFICATION_LANES.filter((lane) => lane !== 'quality'),
        concurrency,
        runLane,
        controller,
      );
      validateVerificationCoverage(plan, summary.lanes);
    }
    const after = join(temporary, 'after');
    await exportVerificationWorkspace({ sourceRoot: root, destination: after });
    if (
      (await describeVerificationSource(after, { requirePublicExport: true }))
        .sourceFingerprint !== descriptor.sourceFingerprint
    )
      throw verificationError(
        'VERIFY_SOURCE_CHANGED',
        '驗證期間工作區來源變更，結果不可視為通過。',
      );
    summary.status = 'passed';
    summary.completedAt = new Date().toISOString();
    await writeVerificationJson(join(reportRoot, 'summary.json'), summary);
    process.stdout.write(
      `驗證通過（${profile}）；報告：${resource}/summary.json\n`,
    );
    return summary;
  } catch (error) {
    summary.status =
      controller.signal.aborted && error?.code === 'VERIFY_CANCELLED'
        ? 'cancelled'
        : 'failed';
    summary.completedAt = new Date().toISOString();
    summary.error = {
      code: /^[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'VERIFY_FAILED',
    };
    await writeVerificationJson(join(reportRoot, 'summary.json'), summary);
    throw error;
  } finally {
    controller.signal.removeEventListener('abort', stop);
    await Promise.allSettled([...active].map((child) => child.stop()));
    await rm(temporary, { recursive: true, force: true });
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
    const options = parseVerificationArguments(
      process.argv.slice(2),
      await verificationResources(),
    );
    await runVerification({
      root: fileURLToPath(new URL('../', import.meta.url)),
      ...options,
      controller,
    });
  } catch (error) {
    process.stderr.write(
      `${/^[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'VERIFY_FAILED'}：${['VERIFY_AUTHOR_SERVICE_ACTIVE', 'VERIFY_RESOURCE_INSUFFICIENT', 'VERIFY_CONCURRENCY_INVALID', 'VERIFY_RESOURCE_INVALID', 'VERIFY_ARGUMENT_INVALID'].includes(error?.code) ? error.message : '驗證未完成，請檢查上述命令輸出。'}\n`,
    );
    process.exitCode = error?.code === 'VERIFY_CANCELLED' ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
