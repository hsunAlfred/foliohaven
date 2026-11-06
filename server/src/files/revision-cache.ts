import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { isMissing, RepositoryError } from './io.js';

/** atime is deliberately excluded: reading a file must not invalidate its hash. */
export function fileIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}
/** Same-tick writes can preserve even nanosecond stat fields on coarse filesystems. */
export function fileIdentityIsStable(stat: BigIntStats): boolean {
  const threshold = BigInt(Date.now() - 2000) * 1_000_000n;
  return stat.mtimeNs < threshold && stat.ctimeNs < threshold;
}

async function identity(path: string): Promise<{
  readonly identity: string;
  readonly stable: boolean;
} | null> {
  let handle;
  try {
    // Opening on hits preserves permission and no-follow checks. Callers still
    // validate the allowed resource and all ancestors with safePath/realpath.
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile())
      throw new RepositoryError('RESOURCE_NOT_FILE', '來源必須是一般檔案。');
    return { identity: fileIdentity(stat), stable: fileIdentityIsStable(stat) };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Bounded, process-local derived data; failures never return a previous value. */
export class FileRevisionCache<T> {
  readonly #entries = new Map<
    string,
    { readonly identity: string; readonly value: T }
  >();
  constructor(readonly maximumEntries = 1024) {}

  async read(
    paths: readonly string[],
    load: () => Promise<T>,
    namespace = '',
  ): Promise<T> {
    const key = JSON.stringify([namespace, paths]);
    const capture = async () => {
      const files = await Promise.all(paths.map(identity));
      return {
        identity: JSON.stringify(files.map((file) => file?.identity ?? null)),
        stable: files.every((file) => file === null || file.stable),
      };
    };
    try {
      const before = await capture();
      const cached = this.#entries.get(key);
      if (before.stable && cached?.identity === before.identity) {
        if ((await capture()).identity !== before.identity)
          throw new RepositoryError(
            'EXTERNAL_CHANGE',
            '來源在讀取期間被外部修改，請重新載入。',
          );
        this.#entries.delete(key);
        this.#entries.set(key, cached);
        return cached.value;
      }
      this.#entries.delete(key);
      const value = await load();
      const after = await capture();
      if (after.identity !== before.identity)
        throw new RepositoryError(
          'EXTERNAL_CHANGE',
          '來源在讀取期間被外部修改，請重新載入。',
        );
      if (!before.stable || !after.stable) {
        // Loads used here derive digests/ETags only. Each call owns its local
        // dependency array; compare values, never object identity or mtime alone.
        const verified = await load();
        if (
          !isDeepStrictEqual(value, verified) ||
          (await capture()).identity !== before.identity
        )
          throw new RepositoryError(
            'EXTERNAL_CHANGE',
            '來源在讀取期間被外部修改，請重新載入。',
          );
        return verified;
      }
      this.#entries.set(key, { identity: before.identity, value });
      if (this.#entries.size > this.maximumEntries) {
        const oldest = this.#entries.keys().next().value;
        if (oldest !== undefined) this.#entries.delete(oldest);
      }
      return value;
    } catch (error) {
      this.#entries.delete(key);
      throw error;
    }
  }
}
