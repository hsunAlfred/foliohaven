import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RepositoryError, safeMkdir, safePath } from '../files/io.js';

export interface FileLeaseOptions {
  readonly root: string;
  /** 內部固定識別，不接受 HTTP 路徑或使用者提供的檔名。 */
  readonly name: string;
  readonly owner: string;
  readonly timeoutMs?: number;
  readonly nonBlocking?: boolean;
  readonly signal?: AbortSignal;
}

export interface FileLease {
  /** 可繼承至受控 worker，使原生工作結束前不提早釋放額度。 */
  readonly fd: number;
  release(): Promise<void>;
}

/** flock 的 descriptor 模式鎖住相同 open file description；owner 保留 fd。 */
export async function acquireFileLease(
  options: FileLeaseOptions,
): Promise<FileLease | null> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (
    !/^[a-z][a-z0-9-]{0,79}$/.test(options.name) ||
    !/^[a-z][a-z0-9-]{0,79}$/.test(options.owner) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 10_800_000
  )
    throw new RepositoryError('INVALID_LEASE_OPTIONS', '程序鎖設定無效。', 500);
  if (options.signal?.aborted)
    throw new RepositoryError('OPERATION_CANCELLED', '操作已取消。');

  await safeMkdir(options.root, '.alfred/locks');
  const path = await safePath(
    options.root,
    `.alfred/locks/${options.name}.lock`,
  );
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  let transferred = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new RepositoryError(
        'LOCK_PERMISSIONS',
        '程序鎖必須是僅擁有者可讀寫的一般檔案。',
        503,
      );
    const args = [
      '--exclusive',
      '--conflict-exit-code',
      '75',
      ...(options.nonBlocking
        ? ['--nonblock']
        : ['--timeout', String(timeoutMs / 1000)]),
      '3',
    ];
    const child = spawn('flock', args, {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5_000);
      killTimer.unref();
    };
    const completion = new Promise<{ code: number | null; failed: boolean }>(
      (resolve) => {
        child.once('error', () => resolve({ code: null, failed: true }));
        child.once('close', (code) => resolve({ code, failed: false }));
      },
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let result;
    try {
      result = await completion;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
    }
    if (options.signal?.aborted)
      throw new RepositoryError('OPERATION_CANCELLED', '操作已取消。');
    if (result.code === 75) {
      if (options.nonBlocking) return null;
      throw new RepositoryError(
        'WORKSPACE_BUSY',
        '資源正由其他程序使用，請稍後重試。',
      );
    }
    if (result.failed || result.code !== 0)
      throw new RepositoryError(
        'LOCK_UNAVAILABLE',
        '無法取得程序鎖，請檢查工具環境。',
        503,
      );

    await handle.truncate(0);
    await handle.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        owner: options.owner,
        leaseId: randomUUID(),
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );
    await handle.sync();
    let released = false;
    transferred = true;
    return {
      fd: handle.fd,
      release: async () => {
        if (released) return;
        released = true;
        await handle.close();
      },
    };
  } finally {
    if (!transferred) await handle.close();
  }
}
