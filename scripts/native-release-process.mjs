import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

const failure = (code) => Object.assign(new Error(code), { code });
export const nativePorts = Object.freeze({
  source: 4321,
  studio: 5173,
  preview: 4322,
  api: 3001,
});
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Only reserve and release probes we created; never stop a port's current owner. */
export async function assertNativePortsFree(ports) {
  if (
    !Array.isArray(ports) ||
    ports.length === 0 ||
    ports.length !== new Set(ports).size ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw failure('NATIVE_PORTS_INVALID');
  const probes = [];
  try {
    for (const port of ports) {
      const probe = createServer();
      probes.push(probe);
      await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
      });
    }
  } catch {
    throw failure('NATIVE_PORT_IN_USE');
  } finally {
    await Promise.all(
      probes.map(
        (probe) =>
          new Promise((resolve) => {
            if (probe.listening) probe.close(resolve);
            else resolve();
          }),
      ),
    );
  }
}

/** Run the documented Node entrypoint directly so its signal cleanup can finish. */
export async function createNativeApplication({
  source,
  environment,
  ports = nativePorts,
  signal,
  onOutput = () => {},
  readyTimeoutMs = 600_000,
  stopGraceMs = 35_000,
  releaseTimeoutMs = 5_000,
}) {
  if (
    !ports ||
    Object.keys(ports).length !== 4 ||
    Object.keys(nativePorts).some((name) => !Object.hasOwn(ports, name))
  )
    throw failure('NATIVE_PORTS_INVALID');
  if (signal?.aborted) throw failure('NATIVE_CHECK_CANCELLED');
  await assertNativePortsFree(Object.values(ports));
  if (signal?.aborted) throw failure('NATIVE_CHECK_CANCELLED');
  const child = spawn(process.execPath, ['scripts/start.mjs'], {
    cwd: source,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const evidence = {
    pid: child.pid ?? null,
    entrypoint: 'node scripts/start.mjs',
    startedAt: new Date().toISOString(),
    ports: { ...ports },
    readyEventAt: null,
    readyAt: null,
    stopRequestedAt: null,
    stoppedAt: null,
    exit: null,
    forced: false,
    closeObserved: false,
    portsReleased: false,
  };
  let exited;
  let spawnError;
  let readySeen = false;
  let pending = '';
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', (bytes) => {
    onOutput('stdout', bytes);
    pending += decoder.write(bytes);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    if (pending.length > 65_536) pending = pending.slice(-1024);
    for (const line of lines)
      if (line.startsWith('START_READY：')) {
        readySeen = true;
        evidence.readyEventAt ??= new Date().toISOString();
      }
  });
  child.stderr.on('data', (bytes) => onOutput('stderr', bytes));
  child.once('error', (error) => {
    spawnError = error;
  });
  child.once('exit', (code, exitSignal) => {
    exited = { code, signal: exitSignal };
    evidence.exit = exited;
  });
  const closed = new Promise((resolve) => {
    child.once('close', (code, exitSignal) => {
      exited ??= { code, signal: exitSignal };
      evidence.exit = exited;
      evidence.closeObserved = true;
      evidence.stoppedAt = new Date().toISOString();
      resolve(exited);
    });
  });
  function active() {
    if (signal?.aborted) throw failure('NATIVE_CHECK_CANCELLED');
    if (spawnError || exited) throw failure('NATIVE_SERVICE_EXITED');
  }
  async function probe(port, path = '/') {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(2_000)])
        : AbortSignal.timeout(2_000),
      redirect: 'manual',
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw failure('NATIVE_SERVICE_NOT_READY');
    }
    return response.text();
  }
  async function waitClosed(timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        closed,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  let shutdown;
  return {
    evidence,
    get exited() {
      return Boolean(exited || spawnError);
    },
    async ready() {
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline) {
        active();
        if (readySeen) {
          try {
            await Promise.all(
              [ports.source, ports.studio, ports.preview].map((port) =>
                probe(port),
              ),
            );
            const health = JSON.parse(await probe(ports.api, '/api/v1/health'));
            if (health.status !== 'ok')
              throw failure('NATIVE_SERVICE_NOT_READY');
            active();
            evidence.readyAt = new Date().toISOString();
            return;
          } catch {
            active();
          }
        }
        await pause(50);
      }
      throw failure('NATIVE_START_TIMEOUT');
    },
    stop() {
      shutdown ??= (async () => {
        const exitedBeforeStop = Boolean(exited || spawnError);
        evidence.stopRequestedAt = new Date().toISOString();
        if (!exitedBeforeStop) child.kill('SIGTERM');
        let result = await waitClosed(stopGraceMs);
        if (result === null) {
          evidence.forced = true;
          // This PGID was created for our still-live direct Node child. A port
          // owner is never selected as a termination target.
          if (child.exitCode === null && child.signalCode === null)
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch (error) {
              if (error.code !== 'ESRCH') throw error;
            }
          result = await waitClosed(2_000);
          if (result === null) {
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
          }
        }
        const deadline = Date.now() + releaseTimeoutMs;
        while (Date.now() < deadline) {
          try {
            await assertNativePortsFree(Object.values(ports));
            evidence.portsReleased = true;
            break;
          } catch {
            await pause(50);
          }
        }
        if (
          evidence.forced ||
          !evidence.closeObserved ||
          !evidence.portsReleased
        )
          throw failure('NATIVE_STOP_DID_NOT_FINISH');
        if (exitedBeforeStop || result.code !== 0 || result.signal !== null)
          throw failure('NATIVE_SERVICE_EXITED');
        return evidence;
      })();
      return shutdown;
    },
  };
}
