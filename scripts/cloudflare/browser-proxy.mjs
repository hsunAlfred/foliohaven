import { createServer } from 'node:http';
import { lookup as lookupAddress } from 'node:dns/promises';
import { connect as connectSocket, isIP } from 'node:net';
import { CloudflareError, cancelled } from './errors.mjs';
import { isPublicAddress, normalizeDomain } from './verify-domain.mjs';

const limits = Object.freeze({
  headerBytes: 16 * 1024,
  headerMs: 15_000,
  connectMs: 30_000,
  idleMs: 120_000,
  tunnelMs: 300_000,
  clients: 16,
  activeTunnels: 8,
  totalTunnels: 128,
});
const failure = (code) =>
  new CloudflareError(code, '瀏覽器 HTTPS 串流代理未通過安全或連線檢查。');

async function publicAddress(hostname, lookup, signal) {
  cancelled(signal);
  let stop;
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        stop = () => reject(failure('CLOUDFLARE_BROWSER_PROXY_CANCELLED'));
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      }),
    ]);
    if (
      !Array.isArray(addresses) ||
      addresses.length === 0 ||
      addresses.some(
        (entry) =>
          !isPublicAddress(entry?.address) ||
          isIP(entry.address) !== entry.family,
      )
    )
      throw failure('CLOUDFLARE_BROWSER_PROXY_ADDRESS_BLOCKED');
    return addresses[0];
  } catch (error) {
    if (error instanceof CloudflareError) throw error;
    throw failure('CLOUDFLARE_BROWSER_PROXY_DNS_FAILED');
  } finally {
    if (stop) signal.removeEventListener('abort', stop);
  }
}

/**
 * Short-lived CONNECT-only transport. The caller must independently restrict
 * browser origins, methods and manifest paths, and verify public file hashes.
 * TLS stays between browser and origin; this module cannot inspect TLS paths.
 * Dependency injection is only for isolated tooling tests, never CLI options.
 */
export async function createBrowserProxy({
  domain,
  signal,
  lookup = lookupAddress,
  connect = connectSocket,
}) {
  cancelled(signal);
  const origin = normalizeDomain(domain);
  const hostname = new URL(origin).hostname;
  const authority = `${hostname}:443`;
  const clients = new Set();
  const sockets = new Set();
  const tunnels = new Set();
  const tasks = new Set();
  const headers = new Map();
  const stopped = new AbortController();
  let closing = false;
  let closingPromise;
  const stats = {
    schemaVersion: 1,
    connectRequests: 0,
    pinnedConnections: 0,
    rejectedConnections: 0,
    rejectedRequests: 0,
    dnsFailures: 0,
    socketFailures: 0,
    timeouts: 0,
    bytesFromBrowser: 0,
    bytesFromOrigin: 0,
    firstFailureCode: null,
  };
  const fail = (code) => {
    stats.firstFailureCode ??= code;
  };
  const clearHeader = (socket) => {
    clearTimeout(headers.get(socket));
    headers.delete(socket);
  };
  const server = createServer(
    {
      maxHeaderSize: limits.headerBytes,
      headersTimeout: limits.headerMs,
      requestTimeout: limits.connectMs,
    },
    (request, response) => {
      clearHeader(request.socket);
      stats.rejectedRequests++;
      fail('CLOUDFLARE_BROWSER_PROXY_HTTP_BLOCKED');
      response.writeHead(405, { Connection: 'close' }).end();
    },
  );
  server.maxConnections = limits.clients;
  server.on('drop', () => {
    stats.rejectedConnections++;
    fail('CLOUDFLARE_BROWSER_PROXY_LIMIT');
  });
  server.on('connection', (socket) => {
    clients.add(socket);
    sockets.add(socket);
    socket.once('error', () => undefined);
    const timeout = setTimeout(() => {
      if (!closing) {
        stats.timeouts++;
        fail('CLOUDFLARE_BROWSER_PROXY_HEADER_TIMEOUT');
      }
      socket.destroy();
    }, limits.headerMs);
    timeout.unref();
    headers.set(socket, timeout);
    socket.once('close', () => {
      clearHeader(socket);
      clients.delete(socket);
      sockets.delete(socket);
    });
  });
  server.on('upgrade', (request, socket) => {
    clearHeader(socket);
    stats.rejectedRequests++;
    fail('CLOUDFLARE_BROWSER_PROXY_UPGRADE_BLOCKED');
    socket.destroy();
  });
  server.on('clientError', (error, socket) => {
    clearHeader(socket);
    if (!closing) {
      stats.rejectedRequests++;
      fail(
        error.code === 'HPE_HEADER_OVERFLOW'
          ? 'CLOUDFLARE_BROWSER_PROXY_HEADER_LIMIT'
          : 'CLOUDFLARE_BROWSER_PROXY_PROTOCOL_INVALID',
      );
    }
    socket.destroy();
  });

  const handleConnect = async (request, client, head) => {
    clearHeader(client);
    stats.connectRequests++;
    if (
      closing ||
      signal?.aborted ||
      request.method !== 'CONNECT' ||
      request.url !== authority ||
      head.length > 64 * 1024 ||
      tunnels.size >= limits.activeTunnels ||
      stats.connectRequests > limits.totalTunnels
    ) {
      stats.rejectedConnections++;
      if (!closing && !signal?.aborted)
        fail(
          request.url !== authority
            ? 'CLOUDFLARE_BROWSER_PROXY_AUTHORITY_BLOCKED'
            : 'CLOUDFLARE_BROWSER_PROXY_LIMIT',
        );
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () =>
        client.destroy(),
      );
      return;
    }
    client.pause();
    const local = new AbortController();
    const combined = AbortSignal.any([
      stopped.signal,
      local.signal,
      ...(signal ? [signal] : []),
    ]);
    let upstream, idleTimer;
    let cleaned = false;
    let socketFailureRecorded = false;
    const recordSocketFailure = () => {
      if (
        !socketFailureRecorded &&
        !closing &&
        !combined.aborted &&
        !client.destroyed
      ) {
        socketFailureRecorded = true;
        stats.socketFailures++;
        fail('CLOUDFLARE_BROWSER_PROXY_SOCKET_FAILED');
      }
    };
    const stop = () => {
      client.destroy();
      upstream?.destroy();
    };
    const timedOut = (code) => {
      if (!closing && !combined.aborted) {
        stats.timeouts++;
        fail(code);
      }
      local.abort();
      stop();
    };
    const connectTimer = setTimeout(
      () => timedOut('CLOUDFLARE_BROWSER_PROXY_CONNECT_TIMEOUT'),
      limits.connectMs,
    );
    connectTimer.unref();
    const lifetime = setTimeout(
      () => timedOut('CLOUDFLARE_BROWSER_PROXY_TUNNEL_TIMEOUT'),
      limits.tunnelMs,
    );
    lifetime.unref();
    const tick = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => timedOut('CLOUDFLARE_BROWSER_PROXY_IDLE_TIMEOUT'),
        limits.idleMs,
      );
      idleTimer.unref();
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(connectTimer);
      clearTimeout(lifetime);
      clearTimeout(idleTimer);
      combined.removeEventListener('abort', stop);
      tunnels.delete(client);
      local.abort();
      stop();
    };
    tunnels.add(client);
    combined.addEventListener('abort', stop, { once: true });
    client.once('close', cleanup);
    try {
      const selected = await publicAddress(hostname, lookup, combined);
      cancelled(combined);
      if (closing || client.destroyed) return;
      // A literal validated address prevents another resolver lookup. Browser
      // TLS still checks the original hostname; no TLS payload is decrypted.
      upstream = connect({
        host: selected.address,
        family: selected.family,
        port: 443,
      });
      sockets.add(upstream);
      upstream.once('close', () => {
        sockets.delete(upstream);
        // A normal readable end may still have bytes queued in the downstream
        // socket. pipe ends it after draining; destroying it here truncates data.
        if (!upstream.readableEnded) {
          recordSocketFailure();
          cleanup();
        }
      });
      upstream.once('error', () => {
        recordSocketFailure();
        stop();
      });
      await new Promise((connected, reject) => {
        const aborted = () => {
          release();
          reject(failure('CLOUDFLARE_BROWSER_PROXY_CANCELLED'));
        };
        const failed = () => {
          release();
          reject(failure('CLOUDFLARE_BROWSER_PROXY_SOCKET_FAILED'));
        };
        const ready = () => {
          release();
          connected();
        };
        const release = () => {
          combined.removeEventListener('abort', aborted);
          upstream.removeListener('connect', ready);
          upstream.removeListener('error', failed);
          upstream.removeListener('close', failed);
        };
        upstream.once('connect', ready);
        upstream.once('error', failed);
        upstream.once('close', failed);
        combined.addEventListener('abort', aborted, { once: true });
        if (combined.aborted) aborted();
      });
      clearTimeout(connectTimer);
      cancelled(combined);
      stats.pinnedConnections++;
      tick();
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        stats.bytesFromBrowser += head.length;
        upstream.write(head);
      }
      client.on('data', (bytes) => {
        stats.bytesFromBrowser += bytes.length;
        tick();
      });
      upstream.on('data', (bytes) => {
        stats.bytesFromOrigin += bytes.length;
        tick();
      });
      // No collection or synthetic HTTP responses: native GET/Range and 200/206
      // travel unchanged, with stream backpressure in both directions.
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    } catch (error) {
      if (!closing && !combined.aborted && !client.destroyed) {
        const code =
          error instanceof CloudflareError
            ? error.code
            : 'CLOUDFLARE_BROWSER_PROXY_SOCKET_FAILED';
        if (code.includes('DNS') || code.includes('ADDRESS'))
          stats.dnsFailures++;
        else if (code === 'CLOUDFLARE_BROWSER_PROXY_SOCKET_FAILED')
          recordSocketFailure();
        fail(code);
        client.end(
          'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n',
          () => client.destroy(),
        );
      } else stop();
    }
  };
  server.on('connect', (request, client, head) => {
    const task = handleConnect(request, client, head);
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });

  const close = () => {
    if (closingPromise) return closingPromise;
    closing = true;
    stopped.abort();
    signal?.removeEventListener('abort', abort);
    for (const timeout of headers.values()) clearTimeout(timeout);
    headers.clear();
    for (const socket of sockets) socket.destroy();
    closingPromise = new Promise((done) => {
      server.close(() => done());
    }).then(async () => {
      await Promise.allSettled([...tasks]);
    });
    return closingPromise;
  };
  const abort = () => {
    void close();
  };
  server.on('error', () => {
    fail('CLOUDFLARE_BROWSER_PROXY_LISTENER_FAILED');
    void close();
  });
  try {
    await new Promise((listening, reject) => {
      const failed = () =>
        reject(failure('CLOUDFLARE_BROWSER_PROXY_LISTENER_FAILED'));
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', failed);
        listening();
      });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      await close();
      cancelled(signal);
    }
    const address = server.address();
    return {
      server: `http://127.0.0.1:${address.port}`,
      close,
      assertHealthy() {
        cancelled(signal);
        if (stats.firstFailureCode) throw failure(stats.firstFailureCode);
      },
      summary() {
        return Object.freeze({
          ...stats,
          healthy: stats.firstFailureCode === null && !signal?.aborted,
          closed: closing,
          activeClientConnections: clients.size,
          activeTunnels: tunnels.size,
        });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
