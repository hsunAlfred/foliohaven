import { acquireFileLease } from '../runtime/lease.js';
import { RepositoryError } from './io.js';

/** 共用 descriptor flock；owner FD 關閉或程序死亡才釋放。 */
export async function acquireRepositoryLock(
  root: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const lease = await acquireFileLease({
    root,
    name: 'writer',
    owner: 'file-repository',
    timeoutMs,
    ...(signal ? { signal } : {}),
  });
  if (!lease)
    throw new RepositoryError(
      'WORKSPACE_BUSY',
      '工作區正由其他程序使用，請稍後重試。',
    );
  return () => lease.release();
}
