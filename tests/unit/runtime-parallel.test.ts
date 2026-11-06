import { describe, expect, it } from 'vitest';
import { CONTENT_LIMITS } from '@foliohaven/core';
import { mapConcurrent } from '../../server/src/runtime/parallel.js';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

describe('bounded parallel reads', () => {
  it('limits active reads and preserves input order when completion order differs', async () => {
    const items = Array.from(
      { length: CONTENT_LIMITS.loaderConcurrency * 2 + 1 },
      (_, index) => index,
    );
    const gates = items.map(deferred);
    const started: number[] = [];
    const completed: number[] = [];
    let active = 0;
    let peak = 0;
    const result = mapConcurrent(items, async (item) => {
      started.push(item);
      peak = Math.max(peak, ++active);
      await gates[item]?.promise;
      completed.push(item);
      active--;
      return item * 2;
    });
    expect(started).toHaveLength(CONTENT_LIMITS.loaderConcurrency);
    for (const gate of [...gates].reverse()) gate.resolve();
    expect(await result).toEqual(items.map((item) => item * 2));
    expect(completed[0]).toBe(CONTENT_LIMITS.loaderConcurrency - 1);
    expect(peak).toBe(CONTENT_LIMITS.loaderConcurrency);
    expect(active).toBe(0);
  });

  it.each([new Error('read failed'), undefined])(
    'waits for all active reads before rejecting and starts no later work (%s)',
    async (error) => {
      const release = deferred();
      const failed = deferred();
      const items = Array.from(
        { length: CONTENT_LIMITS.loaderConcurrency + 1 },
        (_, index) => index,
      );
      const started: number[] = [];
      let active = 0;
      let settled = false;
      const result = mapConcurrent(items, async (item) => {
        started.push(item);
        active++;
        try {
          if (item === 0) {
            failed.resolve();
            throw error;
          }
          await release.promise;
          return item;
        } finally {
          active--;
        }
      });
      const observed = result.then(
        () => {
          settled = true;
          return { error: null };
        },
        (caught: unknown) => {
          settled = true;
          return { error: caught };
        },
      );
      await failed.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(active).toBe(CONTENT_LIMITS.loaderConcurrency - 1);
      expect(started).toHaveLength(CONTENT_LIMITS.loaderConcurrency);
      release.resolve();
      expect((await observed).error).toBe(error);
      expect(active).toBe(0);
      expect(started).toHaveLength(CONTENT_LIMITS.loaderConcurrency);
    },
  );

  it('returns an empty result without starting a read', async () => {
    let started = false;
    expect(
      await mapConcurrent([], async () => {
        started = true;
      }),
    ).toEqual([]);
    expect(started).toBe(false);
  });
});
