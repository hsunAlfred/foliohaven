import { spawn, type ChildProcess } from 'node:child_process';
import { RepositoryError } from '../files/io.js';

export interface ProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly passFds?: readonly number[];
  readonly keepStdinOpen?: boolean;
  readonly input?: Uint8Array;
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
}
export interface ProcessResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}
export class ProcessFailure extends RepositoryError {
  constructor(code: string, message: string) {
    super(code, message, 503);
    this.name = 'ProcessFailure';
  }
}
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error;
  }
}
async function terminate(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  signalGroup(child, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (groupExists(child.pid) && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  if (groupExists(child.pid)) signalGroup(child, 'SIGKILL');
}

/** 只執行內部固定命令；失敗不附帶原始stderr、命令列、環境或私有路徑。 */
export async function runControlledProcess(
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 10_800_000
  )
    throw new ProcessFailure('INVALID_PROCESS_OPTIONS', '子程序時間限制無效。');
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new ProcessFailure('INVALID_PROCESS_OPTIONS', '子程序輸出限制無效。');
  if (options.keepStdinOpen && options.input !== undefined)
    throw new ProcessFailure(
      'INVALID_PROCESS_OPTIONS',
      '不能同時指定一次性輸入及保持輸入管線。',
    );
  if (options.signal?.aborted)
    throw new ProcessFailure('PROCESS_CANCELLED', '操作已取消。');
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', ...(options.passFds ?? [])],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let count = 0;
  let failure: ProcessFailure | undefined;
  let termination: Promise<void> | undefined;
  const stop = (error: ProcessFailure) => {
    failure ??= error;
    termination ??= terminate(child);
    // close後會await並處理，不讓事件回呼產生unhandled rejection。
    void termination.catch(() => undefined);
  };
  const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    count += chunk.length;
    if (count > limit) {
      stop(new ProcessFailure('PROCESS_OUTPUT_LIMIT', '子程序輸出超過限制。'));
      return;
    }
    (stream === 'stdout' ? stdout : stderr).push(chunk);
    try {
      options.onOutput?.(stream, chunk);
    } catch {
      stop(
        new ProcessFailure('PROCESS_OBSERVER_FAILED', '子程序進度接收失敗。'),
      );
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
  child.stdin?.on('error', () => undefined);
  if (!options.keepStdinOpen) child.stdin?.end(options.input);
  const abort = () =>
    stop(new ProcessFailure('PROCESS_CANCELLED', '操作已取消。'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () =>
      stop(new ProcessFailure('PROCESS_TIMEOUT', '子程序超過階段時間限制。')),
    options.timeoutMs,
  );
  timer.unref();
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => {
        failure ??= new ProcessFailure(
          'PROCESS_UNAVAILABLE',
          '無法啟動必要工具。',
        );
      });
      child.once('close', resolve);
    });
    if (code !== 0 && !failure)
      stop(
        new ProcessFailure(
          'PROCESS_EXITED',
          '必要工具執行失敗，請查看安全的階段診斷。',
        ),
      );
    if (termination) await termination;
    if (failure) throw failure;
    return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    child.stdin?.destroy();
  }
}
