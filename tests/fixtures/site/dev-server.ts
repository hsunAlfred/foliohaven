import { createServer } from 'node:net';
import { join } from 'node:path';
import { runControlledProcess } from '../../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../../server/src/runtime/environment.js';
/** 測試持有程序Promise；finally等待整組子程序退出，不留下本機服務。 */
export async function withSiteDev(
  snapshot: string,
  work: (origin: string) => Promise<void>,
): Promise<void> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (address === null || typeof address === 'string')
    throw new Error('DEV_FIXTURE_ADDRESS_INVALID');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const controller = new AbortController();
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const execution = runControlledProcess({
    command: 'pnpm',
    args: [
      '--filter',
      '@foliohaven/site',
      'exec',
      'astro',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    cwd: snapshot,
    env: buildProcessEnvironment({
      FOLIOHAVEN_RENDER_CONTEXT: join(snapshot, '.foliohaven/render'),
      FOLIOHAVEN_RENDER_OUTPUT: join(snapshot, '.foliohaven/dev-output'),
    }),
    signal: controller.signal,
    timeoutMs: 60_000,
    onOutput: (_stream, chunk) => {
      if (chunk.toString('utf8').includes('Local')) started?.();
    },
  });
  try {
    await Promise.race([
      ready,
      execution.then(() => {
        throw new Error('DEV_SERVER_EXITED_BEFORE_READY');
      }),
    ]);
    await work(`http://127.0.0.1:${port}`);
  } finally {
    controller.abort();
    await execution.catch((error) => {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROCESS_CANCELLED'
      ))
        throw error;
    });
  }
}
