import { createServer } from 'node:net';

export interface FixturePortProbe {
  listen(): Promise<number>;
  close(): Promise<void>;
}
export type FixturePortProbeFactory = () => FixturePortProbe;

function socketProbe(): FixturePortProbe {
  const server = createServer();
  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('PORT_REQUIRED');
      return address.port;
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * Await each reservation inside select; all probes stay bound until it settles.
 * Returned ports are already released. This prevents internal reuse while
 * selecting a group, but cannot prevent another process taking a port later.
 */
export async function withReservedPorts<T>(
  select: (reserve: () => Promise<number>) => Promise<T>,
  factory: FixturePortProbeFactory = socketProbe,
): Promise<T> {
  const probes: FixturePortProbe[] = [];
  let selected: { ok: true; value: T } | { ok: false; error: unknown };
  let cleanupErrors: unknown[];
  try {
    selected = {
      ok: true,
      value: await select(async () => {
        const probe = factory();
        probes.push(probe);
        return probe.listen();
      }),
    };
  } catch (error) {
    selected = { ok: false, error };
  } finally {
    const released = await Promise.allSettled(
      probes.map(async (probe) => probe.close()),
    );
    cleanupErrors = released.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      selected.ok ? cleanupErrors : [selected.error, ...cleanupErrors],
      'FIXTURE_PORT_RELEASE_FAILED',
      selected.ok ? undefined : { cause: selected.error },
    );
  if (!selected.ok) throw selected.error;
  return selected.value;
}
