import { CONTENT_LIMITS } from '@foliohaven/core';

export async function mapConcurrent<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const queue = items.entries();
  const results: R[] = [];
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from(
      { length: Math.min(CONTENT_LIMITS.loaderConcurrency, items.length) },
      async () => {
        while (failure === undefined) {
          const next = queue.next();
          if (next.done) return;
          const [index, item] = next.value;
          try {
            results[index] = await read(item);
          } catch (error) {
            failure ??= { error };
          }
        }
      },
    ),
  );
  // Callers may close a read session or release a lock after this settles.
  if (failure !== undefined) throw failure.error;
  return results;
}
