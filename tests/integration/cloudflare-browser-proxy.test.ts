import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { connect, createServer, Socket } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserProxy } from '../../scripts/cloudflare/browser-proxy.mjs';
import type {
  BrowserProxy,
  BrowserProxyOptions,
} from '../../scripts/cloudflare/browser-proxy.mjs';

const domain = 'https://blog.example.com/';
const authority = 'blog.example.com:443';
const publicLookup: NonNullable<BrowserProxyOptions['lookup']> = async () => [
  { address: '8.8.8.8', family: 4 },
];
const ownedProxies: BrowserProxy[] = [];
const ownedServers: Server[] = [];
const ownedSockets = new Set<Socket>();
afterEach(async () => {
  for (const socket of ownedSockets) socket.destroy();
  await Promise.all(ownedProxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(
    ownedServers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  ownedSockets.clear();
  vi.useRealTimers();
});
function own(socket: Socket): Socket {
  ownedSockets.add(socket);
  socket.once('error', () => undefined);
  socket.once('close', () => ownedSockets.delete(socket));
  return socket;
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await delay(1);
  }
  throw new Error('fixture condition not reached');
}
async function listen(server: Server): Promise<number> {
  ownedServers.push(server);
  server.on('connection', own);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return (server.address() as AddressInfo).port;
}
async function proxy(
  options: Partial<BrowserProxyOptions> = {},
): Promise<BrowserProxy> {
  const value = await createBrowserProxy({
    domain,
    lookup: publicLookup,
    ...options,
  });
  ownedProxies.push(value);
  return value;
}
async function client(value: BrowserProxy): Promise<Socket> {
  const socket = own(
    connect({ host: '127.0.0.1', port: Number(new URL(value.server).port) }),
  );
  await new Promise<void>((ready, reject) => {
    socket.once('connect', ready);
    socket.once('error', reject);
  });
  return socket;
}
function readHeaders(socket: Socket): Promise<string> {
  return new Promise((resolveHeaders, reject) => {
    let bytes = Buffer.alloc(0);
    const clear = () => {
      socket.removeListener('data', data);
      socket.removeListener('close', closed);
      socket.removeListener('error', failed);
    };
    const closed = () => {
      clear();
      resolveHeaders(bytes.toString('latin1'));
    };
    const failed = (error: Error) => {
      clear();
      reject(error);
    };
    const data = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 64 * 1024) {
        failed(new Error('fixture header limit'));
        return;
      }
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.pause();
      clear();
      if (bytes.length > end + 4) socket.unshift(bytes.subarray(end + 4));
      resolveHeaders(bytes.subarray(0, end + 4).toString('latin1'));
    };
    socket.on('data', data);
    socket.once('close', closed);
    socket.once('error', failed);
    socket.resume();
  });
}
async function raw(
  value: BrowserProxy,
  text: string,
): Promise<{ socket: Socket; headers: string }> {
  const socket = await client(value);
  const pending = readHeaders(socket);
  socket.write(text);
  return { socket, headers: await pending };
}
async function tunnel(value: BrowserProxy, extra = ''): Promise<Socket> {
  const result = await raw(
    value,
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n${extra}`,
  );
  expect(result.headers).toBe('HTTP/1.1 200 Connection Established\r\n\r\n');
  return result.socket;
}
function fixtureConnect(port: number) {
  return vi.fn<NonNullable<BrowserProxyOptions['connect']>>(() =>
    own(connect({ host: '127.0.0.1', port })),
  );
}
function fakeTimers() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

describe('Cloudflare browser CONNECT proxy', () => {
  it.each([
    'http://blog.example.com/',
    'https://127.0.0.1/',
    'https://localhost/',
    'https://user:password@blog.example.com/',
    'https://blog.example.com:443/',
    'https://blog.example.com/path',
    'https://blog.example.com/?q=1',
  ])(
    'rejects invalid origin %s before listening or resolving',
    async (value) => {
      const lookup = vi.fn(publicLookup);
      await expect(
        createBrowserProxy({ domain: value, lookup }),
      ).rejects.toThrow();
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it('binds an ephemeral loopback port and closes idempotently with safe counters', async () => {
    const value = await proxy();
    expect(value.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    value.assertHealthy();
    expect(value.summary()).toMatchObject({
      healthy: true,
      closed: false,
      activeTunnels: 0,
    });
    await value.close();
    await value.close();
    expect(value.summary()).toMatchObject({
      healthy: true,
      closed: true,
      activeClientConnections: 0,
      activeTunnels: 0,
    });
    expect(JSON.stringify(value.summary())).not.toMatch(
      /example|8\.8\.8\.8|127\.0\.0\.1/,
    );
  });

  it.each([
    'elsewhere.invalid:443',
    'blog.example.com:80',
    'blog.example.com:8443',
    'blog.example.com',
    'user@blog.example.com:443',
    '127.0.0.1:443',
    '[::1]:443',
    'blog.example.com:443/',
  ])('rejects CONNECT authority %s without DNS or connect', async (target) => {
    const lookup = vi.fn(publicLookup),
      connect = vi.fn<NonNullable<BrowserProxyOptions['connect']>>();
    const value = await proxy({ lookup, connect });
    const response = await raw(
      value,
      `CONNECT ${target} HTTP/1.1\r\nHost: fixture\r\n\r\n`,
    );
    expect(response.headers).toContain('403 Forbidden');
    expect(lookup).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(() => value.assertHealthy()).toThrowError(
      expect.objectContaining({
        code: 'CLOUDFLARE_BROWSER_PROXY_AUTHORITY_BLOCKED',
      }),
    );
  });

  it('rejects HTTP forwarding and Upgrade without reading the origin', async () => {
    const lookup = vi.fn(publicLookup);
    const value = await proxy({ lookup });
    const forwarded = await raw(
      value,
      'GET https://blog.example.com/media/a.mp4 HTTP/1.1\r\nHost: blog.example.com\r\n\r\n',
    );
    expect(forwarded.headers).toContain('405 Method Not Allowed');
    const upgraded = await raw(
      value,
      'GET / HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    expect(upgraded.headers).toBe('');
    expect(lookup).not.toHaveBeenCalled();
    expect(value.summary().rejectedRequests).toBe(2);
    expect(() => value.assertHealthy()).toThrow();
  });

  it.each([
    { addresses: [{ address: '127.0.0.1', family: 4 }] },
    {
      addresses: [
        { address: '8.8.8.8', family: 4 },
        { address: '192.168.1.2', family: 4 },
      ],
    },
    { addresses: [{ address: '2001:4860:4860::8888', family: 4 }] },
    { addresses: [] },
  ])(
    'rejects private, mixed, malformed or empty DNS results before connect',
    async ({ addresses }) => {
      const connect = vi.fn<NonNullable<BrowserProxyOptions['connect']>>();
      const value = await proxy({ lookup: async () => addresses, connect });
      expect(
        (
          await raw(
            value,
            `CONNECT ${authority} HTTP/1.1\r\nHost: fixture\r\n\r\n`,
          )
        ).headers,
      ).toContain('502 Bad Gateway');
      expect(connect).not.toHaveBeenCalled();
      expect(value.summary()).toMatchObject({
        dnsFailures: 1,
        pinnedConnections: 0,
        healthy: false,
      });
    },
  );

  it('pins the exact validated public literal and preserves already-read tunnel bytes', async () => {
    const port = await listen(createServer((socket) => socket.pipe(socket)));
    const connect = fixtureConnect(port),
      lookup = vi.fn(publicLookup);
    const value = await proxy({ connect, lookup });
    const socket = await tunnel(value, 'early-tls-shaped-bytes');
    const received = await new Promise<Buffer>((done) => {
      socket.once('data', done);
      socket.resume();
    });
    expect(received.toString()).toBe('early-tls-shaped-bytes');
    expect(lookup).toHaveBeenCalledWith('blog.example.com', {
      all: true,
      verbatim: true,
    });
    expect(connect).toHaveBeenCalledExactlyOnceWith({
      host: '8.8.8.8',
      family: 4,
      port: 443,
    });
    value.assertHealthy();
    expect(value.summary()).toMatchObject({
      pinnedConnections: 1,
      bytesFromBrowser: received.length,
      bytesFromOrigin: received.length,
    });
  });

  it('checks all DNS records again on each new tunnel and stops a rebinding result', async () => {
    const port = await listen(createServer((socket) => socket.pipe(socket)));
    const connect = fixtureConnect(port);
    let lookupCount = 0;
    const value = await proxy({
      connect,
      lookup: async () =>
        ++lookupCount === 1
          ? [{ address: '8.8.8.8', family: 4 }]
          : [
              { address: '8.8.8.8', family: 4 },
              { address: '10.0.0.1', family: 4 },
            ],
    });
    (await tunnel(value)).destroy();
    expect(
      (
        await raw(
          value,
          `CONNECT ${authority} HTTP/1.1\r\nHost: fixture\r\n\r\n`,
        )
      ).headers,
    ).toContain('502');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(value.summary().firstFailureCode).toBe(
      'CLOUDFLARE_BROWSER_PROXY_ADDRESS_BLOCKED',
    );
  });

  it('pins a validated IPv6 literal without resolving it again', async () => {
    const port = await listen(createServer((socket) => socket.pipe(socket)));
    const connect = fixtureConnect(port);
    const value = await proxy({
      connect,
      lookup: async () => [{ address: '2001:4860:4860::8888', family: 6 }],
    });
    (await tunnel(value)).destroy();
    expect(connect).toHaveBeenCalledExactlyOnceWith({
      host: '2001:4860:4860::8888',
      family: 6,
      port: 443,
    });
    value.assertHealthy();
  });

  it('records an upstream socket that closes before CONNECT is established', async () => {
    const value = await proxy({
      connect: () => {
        const socket = own(new Socket());
        queueMicrotask(() => socket.destroy());
        return socket;
      },
    });
    const response = await raw(value, `CONNECT ${authority} HTTP/1.1\r\n\r\n`);
    expect(response.headers).not.toContain('200 Connection Established');
    expect(value.summary()).toMatchObject({
      healthy: false,
      socketFailures: 1,
      pinnedConnections: 0,
      firstFailureCode: 'CLOUDFLARE_BROWSER_PROXY_SOCKET_FAILED',
    });
  });

  it('streams a full 16 MiB response and original Range semantics without truncation', async () => {
    const blockSize = 64 * 1024,
      count = 256,
      total = blockSize * count;
    const expected = createHash('sha256');
    for (let i = 0; i < count; i++) expected.update(Buffer.alloc(blockSize, i));
    const ranges: (string | undefined)[] = [];
    const backend = httpServer((request, response) => {
      ranges.push(request.headers.range);
      if (request.headers.range) {
        response.writeHead(206, {
          'content-length': 32,
          'content-range': `bytes 8388608-8388639/${total}`,
          'content-type': 'video/mp4',
          connection: 'close',
        });
        response.end(Buffer.alloc(32, 128));
        return;
      }
      response.writeHead(200, {
        'content-length': total,
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        connection: 'close',
      });
      Readable.from(
        (function* () {
          for (let i = 0; i < count; i++) yield Buffer.alloc(blockSize, i);
        })(),
      ).pipe(response);
    });
    const port = await listen(backend),
      connect = fixtureConnect(port);
    const value = await proxy({ connect });
    const socket = await tunnel(value);
    const response = readHeaders(socket);
    socket.write(
      'GET /video.mp4 HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n',
    );
    expect(await response).toContain('200 OK');
    let byteSize = 0;
    const hash = createHash('sha256');
    socket.resume();
    for await (const bytes of socket) {
      byteSize += bytes.length;
      hash.update(bytes);
      await delay(1);
    }
    expect(byteSize).toBe(total);
    expect(hash.digest('hex')).toBe(expected.digest('hex'));
    const ranged = await tunnel(value);
    const rangeHeaders = readHeaders(ranged);
    ranged.write(
      'GET /video.mp4 HTTP/1.1\r\nHost: fixture\r\nRange: bytes=8388608-8388639\r\nConnection: close\r\n\r\n',
    );
    expect(await rangeHeaders).toContain(
      `206 Partial Content\r\ncontent-length: 32\r\ncontent-range: bytes 8388608-8388639/${total}`,
    );
    ranged.resume();
    const chunks: Buffer[] = [];
    for await (const bytes of ranged) chunks.push(bytes);
    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(32, 128));
    expect(ranges).toEqual([undefined, 'bytes=8388608-8388639']);
    expect(value.summary().bytesFromOrigin).toBeGreaterThan(total);
    value.assertHealthy();
  });

  it('sanitizes DNS exceptions and origin socket failures', async () => {
    const dns = await proxy({
      lookup: async () => {
        throw new Error('secret-auth-response');
      },
    });
    await raw(dns, `CONNECT ${authority} HTTP/1.1\r\nHost: fixture\r\n\r\n`);
    expect(dns.summary().firstFailureCode).toBe(
      'CLOUDFLARE_BROWSER_PROXY_DNS_FAILED',
    );
    expect(JSON.stringify(dns.summary())).not.toContain('secret-auth-response');
    const socket = await proxy({
      connect: () => {
        throw new Error('secret-socket-detail');
      },
    });
    await raw(socket, `CONNECT ${authority} HTTP/1.1\r\nHost: fixture\r\n\r\n`);
    expect(() => socket.assertHealthy()).toThrowError(
      expect.objectContaining({
        code: 'CLOUDFLARE_BROWSER_PROXY_SOCKET_FAILED',
      }),
    );
    expect(JSON.stringify(socket.summary())).not.toContain(
      'secret-socket-detail',
    );
  });

  it('rejects an oversized header and expires incomplete headers', async () => {
    const value = await proxy();
    const response = await raw(
      value,
      `CONNECT ${authority} HTTP/1.1\r\nX-Large: ${'x'.repeat(20 * 1024)}\r\n\r\n`,
    );
    expect(response.headers).toBe('');
    expect(value.summary().firstFailureCode).toBe(
      'CLOUDFLARE_BROWSER_PROXY_HEADER_LIMIT',
    );
    fakeTimers();
    const incomplete = await proxy();
    const socket = await client(incomplete);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\n`);
    await vi.advanceTimersByTimeAsync(15_001);
    await waitFor(() => socket.destroyed);
    expect(incomplete.summary()).toMatchObject({
      timeouts: 1,
      firstFailureCode: 'CLOUDFLARE_BROWSER_PROXY_HEADER_TIMEOUT',
    });
  });

  it('bounds DNS/connect waiting and idle tunnel time', async () => {
    fakeTimers();
    const lookup = vi.fn<NonNullable<BrowserProxyOptions['lookup']>>(
      () => new Promise(() => undefined),
    );
    const pending = await proxy({ lookup });
    const waiting = await client(pending);
    waiting.write(`CONNECT ${authority} HTTP/1.1\r\n\r\n`);
    await waitFor(() => lookup.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(30_001);
    await waitFor(() => waiting.destroyed);
    expect(pending.summary()).toMatchObject({
      timeouts: 1,
      firstFailureCode: 'CLOUDFLARE_BROWSER_PROXY_CONNECT_TIMEOUT',
    });
    const port = await listen(createServer((socket) => socket.pipe(socket)));
    const idle = await proxy({ connect: fixtureConnect(port) });
    const socket = await tunnel(idle);
    socket.resume();
    await vi.advanceTimersByTimeAsync(120_001);
    await waitFor(() => socket.destroyed);
    expect(idle.summary()).toMatchObject({
      timeouts: 1,
      firstFailureCode: 'CLOUDFLARE_BROWSER_PROXY_IDLE_TIMEOUT',
    });
  });

  it('enforces a total tunnel deadline despite ongoing traffic', async () => {
    fakeTimers();
    const port = await listen(createServer((socket) => socket.pipe(socket)));
    const value = await proxy({ connect: fixtureConnect(port) });
    const socket = await tunnel(value);
    socket.resume();
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(60_000);
      socket.write('still-active');
      const expected = (index + 1) * 'still-active'.length;
      await waitFor(() => value.summary().bytesFromOrigin >= expected);
    }
    await vi.advanceTimersByTimeAsync(60_001);
    await waitFor(() => socket.destroyed);
    expect(value.summary()).toMatchObject({
      timeouts: 1,
      firstFailureCode: 'CLOUDFLARE_BROWSER_PROXY_TUNNEL_TIMEOUT',
    });
  });

  it('rejects too many pending tunnels without opening upstream sockets', async () => {
    const connect = vi.fn<NonNullable<BrowserProxyOptions['connect']>>();
    const lookup = vi.fn<NonNullable<BrowserProxyOptions['lookup']>>(
      () => new Promise(() => undefined),
    );
    const value = await proxy({ lookup, connect });
    for (let i = 0; i < 8; i++)
      (await client(value)).write(`CONNECT ${authority} HTTP/1.1\r\n\r\n`);
    await waitFor(() => lookup.mock.calls.length === 8);
    const ninth = await raw(value, `CONNECT ${authority} HTTP/1.1\r\n\r\n`);
    expect(ninth.headers).toContain('403');
    expect(connect).not.toHaveBeenCalled();
    expect(value.summary().firstFailureCode).toBe(
      'CLOUDFLARE_BROWSER_PROXY_LIMIT',
    );
  });

  it('bounds TCP clients and the total count of sequential CONNECTs', async () => {
    const lookup = vi.fn(publicLookup);
    const crowded = await proxy({ lookup });
    for (let index = 0; index < 16; index++) await client(crowded);
    await waitFor(() => crowded.summary().activeClientConnections === 16);
    await client(crowded);
    await waitFor(() => crowded.summary().rejectedConnections === 1);
    expect(lookup).not.toHaveBeenCalled();
    await crowded.close();
    const port = await listen(createServer((socket) => socket.pipe(socket)));
    const value = await proxy({ connect: fixtureConnect(port) });
    for (let index = 0; index < 128; index++) {
      (await tunnel(value)).destroy();
      await waitFor(() => value.summary().activeTunnels === 0);
    }
    expect(
      (await raw(value, `CONNECT ${authority} HTTP/1.1\r\n\r\n`)).headers,
    ).toContain('403');
    expect(value.summary()).toMatchObject({
      pinnedConnections: 128,
      connectRequests: 129,
      firstFailureCode: 'CLOUDFLARE_BROWSER_PROXY_LIMIT',
    });
  });

  it('expires a socket that never finishes connecting', async () => {
    fakeTimers();
    const connect = vi.fn<NonNullable<BrowserProxyOptions['connect']>>(() =>
      own(new Socket()),
    );
    const value = await proxy({ connect });
    const socket = await client(value);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\n\r\n`);
    await waitFor(() => connect.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(30_001);
    await waitFor(() => socket.destroyed);
    expect(value.summary()).toMatchObject({
      pinnedConnections: 0,
      timeouts: 1,
      firstFailureCode: 'CLOUDFLARE_BROWSER_PROXY_CONNECT_TIMEOUT',
    });
  });

  it('never opens a late origin connection after explicit close during DNS', async () => {
    let resolveLookup:
      ((value: { address: string; family: number }[]) => void) | undefined;
    const lookup = vi.fn<NonNullable<BrowserProxyOptions['lookup']>>(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const connect = vi.fn<NonNullable<BrowserProxyOptions['connect']>>();
    const value = await proxy({ lookup, connect });
    const socket = await client(value);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\n\r\n`);
    await waitFor(() => lookup.mock.calls.length === 1);
    await value.close();
    resolveLookup?.([{ address: '8.8.8.8', family: 4 }]);
    await delay(1);
    expect(connect).not.toHaveBeenCalled();
    expect(value.summary()).toMatchObject({
      closed: true,
      activeTunnels: 0,
      healthy: true,
    });
  });

  it('cancels pending DNS and active tunnels, closes the port, and leaves no owned connections', async () => {
    const before = new AbortController();
    before.abort();
    await expect(proxy({ signal: before.signal })).rejects.toMatchObject({
      code: 'CLOUDFLARE_CANCELLED',
    });
    const controller = new AbortController();
    const lookup = vi.fn<NonNullable<BrowserProxyOptions['lookup']>>(
      () => new Promise(() => undefined),
    );
    const pending = await proxy({ lookup, signal: controller.signal });
    const socket = await client(pending);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\n\r\n`);
    await waitFor(() => lookup.mock.calls.length === 1);
    controller.abort();
    await pending.close();
    await waitFor(() => socket.destroyed);
    expect(pending.summary()).toMatchObject({
      closed: true,
      activeTunnels: 0,
      activeClientConnections: 0,
    });
    expect(() => pending.assertHealthy()).toThrowError(
      expect.objectContaining({ code: 'CLOUDFLARE_CANCELLED' }),
    );
    const activeController = new AbortController();
    const port = await listen(createServer((socket) => socket.pipe(socket)));
    const active = await proxy({
      signal: activeController.signal,
      connect: fixtureConnect(port),
    });
    const activeSocket = await tunnel(active);
    activeSocket.resume();
    activeController.abort();
    await active.close();
    await waitFor(() => activeSocket.destroyed);
    expect(active.summary()).toMatchObject({
      closed: true,
      activeTunnels: 0,
      activeClientConnections: 0,
    });
    await expect(client(active)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });
});
