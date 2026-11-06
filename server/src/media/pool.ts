import { setTimeout as delay } from 'node:timers/promises';
import { acquireFileLease, type FileLease } from '../runtime/lease.js';
import { cancelled, MediaError } from './errors.js';

export async function acquireMediaSlot(
  root: string,
  kind: 'image' | 'video',
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FileLease> {
  const start = Date.now();
  for (;;) {
    cancelled(signal);
    for (let index = 0; index < (kind === 'image' ? 2 : 1); index += 1) {
      const lease = await acquireFileLease({
        root,
        name: `media-${kind}-${index}`,
        owner: 'media-pipeline',
        nonBlocking: true,
        ...(signal === undefined ? {} : { signal }),
      });
      if (lease !== null) return lease;
    }
    if (Date.now() - start >= timeoutMs)
      throw new MediaError(
        'MEDIA_BUSY',
        '媒體處理額度正由其他程序使用。',
        409,
        true,
      );
    try {
      await delay(Math.min(40, timeoutMs - (Date.now() - start)), undefined, {
        signal,
      });
    } catch {
      cancelled(signal);
    }
  }
}
