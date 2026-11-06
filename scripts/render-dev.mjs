import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  runControlledProcess,
  buildProcessEnvironment,
  prepareRenderContext,
  invalidateRenderContext,
  RenderError,
  RepositoryError,
} from '@foliohaven/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, '.alfred/dev/render');
const parentPipe = process.argv[3] === '--parent-pipe';
const cancelledCodes = new Set([
  'BUILD_CANCELLED',
  'MEDIA_CANCELLED',
  'PROCESS_CANCELLED',
  'OPERATION_CANCELLED',
]);
function diagnostic(error, phase, signal) {
  const code =
    error instanceof RepositoryError &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)
      ? error.code
      : ['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'ENOENT'].includes(error?.code)
        ? error.code
        : 'RENDER_PREPARE_FAILED';
  const cancelled =
    signal.aborted || cancelledCodes.has(code) || error?.name === 'AbortError';
  return {
    event: 'dev-render-diagnostic',
    code,
    phase,
    cancelled,
    at: new Date().toISOString(),
    ...(code === 'WORKSPACE_BUSY' && phase === 'prepare' && !cancelled
      ? { waiting: true }
      : {}),
  };
}
function safeDiagnostic(value) {
  if (
    value?.event !== 'dev-render-diagnostic' ||
    typeof value.code !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,79}$/u.test(value.code) ||
    !['prepare', 'invalidate', 'process'].includes(value.phase) ||
    typeof value.cancelled !== 'boolean' ||
    typeof value.at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.at) ||
    !Number.isFinite(Date.parse(value.at))
  )
    return null;
  if (
    value.retryExhausted !== undefined &&
    !(value.retryExhausted === true && value.waiting === true)
  )
    return null;
  if (
    value.waiting !== undefined &&
    !(
      value.waiting === true &&
      value.code === 'WORKSPACE_BUSY' &&
      value.phase === 'prepare' &&
      !value.cancelled
    )
  )
    return null;
  return {
    event: value.event,
    code: value.code,
    phase: value.phase,
    cancelled: value.cancelled,
    at: value.at,
    ...(value.waiting === true ? { waiting: true } : {}),
    ...(value.retryExhausted === true ? { retryExhausted: true } : {}),
  };
}
function report(value) {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}
async function prepareWithWriterWait(signal) {
  const started = performance.now();
  const waitBudgetMs = 3 * 60_000;
  let backoffMs = 250;
  for (;;) {
    try {
      return await prepareRenderContext({
        repositoryRoot: root,
        contextDirectory: directory,
        signal,
      });
    } catch (error) {
      if (
        !(error instanceof RepositoryError) ||
        error.code !== 'WORKSPACE_BUSY' ||
        signal.aborted
      )
        throw error;
      // Leave room for the unchanged ten-second writer acquisition. A busy
      // writer never changes the last complete generation into invalid data.
      if (performance.now() - started + backoffMs + 10_000 > waitBudgetMs)
        throw error;
      report(diagnostic(error, 'prepare', signal));
      try {
        await delay(backoffMs, undefined, { signal });
      } catch (cancelled) {
        if (signal.aborted)
          throw new RepositoryError('OPERATION_CANCELLED', '操作已取消。');
        throw cancelled;
      }
      backoffMs = Math.min(backoffMs * 2, 1_000);
    }
  }
}
if (
  process.argv.length > (parentPipe ? 4 : 3) ||
  (process.argv[3] !== undefined && !parentPipe) ||
  (parentPipe && process.argv[2] !== '--once') ||
  (process.argv[2] !== undefined &&
    !['--once', '--authoring'].includes(process.argv[2]))
) {
  process.stderr.write(
    'DEV_ARGUMENT_INVALID：開發呈現不接受任意路徑或選項。\n',
  );
  process.exitCode = 1;
} else if (['--once', '--authoring'].includes(process.argv[2])) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  if (parentPipe) {
    process.stdin.on('end', stop);
    process.stdin.resume();
  }
  try {
    await prepareWithWriterWait(controller.signal);
  } catch (error) {
    const detail = diagnostic(error, 'prepare', controller.signal);
    const busy =
      error instanceof RepositoryError && error.code === 'WORKSPACE_BUSY';
    report({
      ...detail,
      ...(busy && !detail.cancelled ? { retryExhausted: true } : {}),
    });
    let invalidationFailed = false;
    if (!detail.cancelled && !busy)
      try {
        await invalidateRenderContext(root, directory);
      } catch (invalid) {
        invalidationFailed = true;
        report(diagnostic(invalid, 'invalidate', controller.signal));
      }
    const repairableSource =
      !invalidationFailed &&
      ((error instanceof RepositoryError &&
        error.code === 'RECOVERY_REQUIRED') ||
        (error instanceof RenderError &&
          error.status === 422 &&
          ![
            'MEDIA_TOOL_UNAVAILABLE',
            'MEDIA_WORKER_PROTOCOL',
            'PROCESS_UNAVAILABLE',
            'PROCESS_OUTPUT_LIMIT',
            'MEDIA_CANCELLED',
            'BUILD_CANCELLED',
          ].includes(error.code)));
    process.exitCode = detail.cancelled
      ? 130
      : busy
        ? 75
        : process.argv[2] === '--authoring' && repairableSource
          ? 2
          : 1;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (parentPipe) {
      process.stdin.removeListener('end', stop);
      process.stdin.pause();
    }
  }
} else {
  const controller = new AbortController();
  let running = false;
  let pending = true;
  let timer;
  const refresh = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    pending = false;
    let buffered = '';
    const details = [];
    let lastDetail;
    let busy = false;
    try {
      await runControlledProcess({
        command: process.execPath,
        args: ['scripts/render-dev.mjs', '--once', '--parent-pipe'],
        cwd: root,
        env: buildProcessEnvironment(),
        timeoutMs: 3 * 60 * 60_000,
        signal: controller.signal,
        keepStdinOpen: true,
        onOutput: (_stream, chunk) => {
          buffered += chunk.toString('utf8');
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          if (buffered.length > 16_384) buffered = '';
          for (const line of lines) {
            if (line.length > 16_384) continue;
            try {
              const safe = safeDiagnostic(JSON.parse(line));
              if (safe) {
                lastDetail = safe;
                if (safe.waiting) report(safe);
                else if (details.length < 16) details.push(safe);
              }
            } catch {
              // Third-party stdout/stderr is not a trusted diagnostic channel.
            }
          }
        },
      });
    } catch (error) {
      busy =
        error instanceof RepositoryError &&
        error.code === 'PROCESS_EXITED' &&
        details.length === 0 &&
        lastDetail?.retryExhausted === true;
      for (const detail of details) report(detail);
      if (!controller.signal.aborted && !busy)
        report(diagnostic(error, 'process', controller.signal));
    } finally {
      running = false;
      if (busy && !controller.signal.aborted) {
        pending = true;
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 1_000);
      } else if (pending && !controller.signal.aborted) void refresh();
    }
  };
  const watchers = [];
  const schedule = () => {
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 150);
  };
  for (const resource of [
    'content',
    'media/source',
    'site/dist/registry',
    'site/src/pages',
    'packages/core/dist',
    'server/dist/build/render',
  ]) {
    try {
      if ((await stat(resolve(root, resource))).isDirectory())
        watchers.push(
          watch(resolve(root, resource), { recursive: true }, schedule),
        );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
  }
  const stop = () => {
    controller.abort();
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await refresh();
}
