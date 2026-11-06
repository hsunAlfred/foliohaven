import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { withReservedPorts } from '../fixtures/ports.js';
import type { FixturePortProbeFactory } from '../fixtures/ports.js';

function recyclablePool(
  options: { failListen?: number; failClose?: number } = {},
) {
  const held = new Set<number>();
  const events: { type: 'listen' | 'close'; index: number; port?: number }[] =
    [];
  const listenFailure = new Error('controlled listen failure');
  const closeFailure = new Error('controlled close failure');
  let created = 0;
  const factory: FixturePortProbeFactory = () => {
    const index = ++created;
    let assigned: number | null = null;
    return {
      listen() {
        if (options.failListen === index) throw listenFailure;
        let port = 42000;
        while (held.has(port)) port++;
        assigned = port;
        held.add(port);
        events.push({ type: 'listen', index, port });
        return Promise.resolve(port);
      },
      close() {
        if (assigned !== null) held.delete(assigned);
        events.push({ type: 'close', index });
        if (options.failClose === index) throw closeFailure;
        return Promise.resolve();
      },
    };
  };
  return { factory, held, events, listenFailure, closeFailure };
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function rebindAll(ports: readonly number[]) {
  const servers: Server[] = [];
  try {
    for (const port of ports) {
      const server = createServer();
      servers.push(server);
      await listen(server, port);
    }
    expect(servers.every((server) => server.listening)).toBe(true);
  } finally {
    await Promise.all(servers.map(close));
  }
}

describe('fixture grouped port reservations', () => {
  it('keeps every reservation live when released numbers are immediately recycled', async () => {
    const pool = recyclablePool();
    const ports = await withReservedPorts(async (reserve) => {
      const selected = {
        site: await reserve(),
        studio: await reserve(),
        preview: await reserve(),
        api: await reserve(),
      };
      expect(pool.held.size).toBe(4);
      expect(pool.events.every((event) => event.type === 'listen')).toBe(true);
      return selected;
    }, pool.factory);
    expect(ports).toEqual({
      site: 42000,
      studio: 42001,
      preview: 42002,
      api: 42003,
    });
    expect(new Set(Object.values(ports)).size).toBe(4);
    expect(pool.held.size).toBe(0);
    expect(pool.events.filter((event) => event.type === 'close')).toHaveLength(
      4,
    );
  });

  it('holds four distinct real sockets together and releases every port before returning', async () => {
    const ports = await withReservedPorts(async (reserve) => {
      const selected = [
        await reserve(),
        await reserve(),
        await reserve(),
        await reserve(),
      ];
      expect(new Set(selected).size).toBe(4);
      for (const port of selected) {
        const contender = createServer();
        try {
          await expect(listen(contender, port)).rejects.toMatchObject({
            code: 'EADDRINUSE',
          });
        } finally {
          await close(contender);
        }
      }
      return selected;
    });
    await rebindAll(ports);
  });

  it('releases earlier and failing probes after a synchronous listen error', async () => {
    const pool = recyclablePool({ failListen: 3 });
    await expect(
      withReservedPorts(async (reserve) => {
        await reserve();
        await reserve();
        await reserve();
      }, pool.factory),
    ).rejects.toBe(pool.listenFailure);
    expect(pool.held.size).toBe(0);
    expect(
      pool.events
        .filter((event) => event.type === 'close')
        .map((event) => event.index),
    ).toEqual([1, 2, 3]);
  });

  it('releases real sockets when selection fails before returning a port map', async () => {
    const selected: number[] = [];
    const failure = new Error('controlled selection failure');
    await expect(
      withReservedPorts(async (reserve) => {
        selected.push(await reserve(), await reserve());
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(selected).toHaveLength(2);
    await rebindAll(selected);
  });

  it('attempts every release and reports a cleanup failure after successful selection', async () => {
    const pool = recyclablePool({ failClose: 1 });
    const failure = await withReservedPorts(async (reserve) => {
      await reserve();
      await reserve();
      await reserve();
    }, pool.factory).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError))
      throw new Error('AggregateError required');
    expect(failure.errors).toHaveLength(1);
    expect(failure.errors[0]).toBe(pool.closeFailure);
    expect(
      pool.events
        .filter((event) => event.type === 'close')
        .map((event) => event.index),
    ).toEqual([1, 2, 3]);
    expect(pool.held.size).toBe(0);
  });

  it('preserves the primary failure and cleanup errors while releasing every other probe', async () => {
    const pool = recyclablePool({ failListen: 3, failClose: 1 });
    const failure = await withReservedPorts(async (reserve) => {
      await reserve();
      await reserve();
      await reserve();
    }, pool.factory).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError))
      throw new Error('AggregateError required');
    expect(failure.cause).toBe(pool.listenFailure);
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(pool.listenFailure);
    expect(failure.errors[1]).toBe(pool.closeFailure);
    expect(
      pool.events
        .filter((event) => event.type === 'close')
        .map((event) => event.index),
    ).toEqual([1, 2, 3]);
    expect(pool.held.size).toBe(0);
  });
});
