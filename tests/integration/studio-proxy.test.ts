import { it, expect } from 'vitest';
import { createServer as createHttpServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { createStudioViteConfig } from '../../studio/vite.config.js';

function get(
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { headers, method }, (response) => {
      const bytes: Buffer[] = [];
      response.on('data', (value: Buffer) => bytes.push(value));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(bytes).toString('utf8'),
        }),
      );
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}
it('Studio proxy keeps token in Node, overwrites caller headers, protects origins and denies private filesystem reads', async () => {
  const token = randomBytes(32).toString('hex');
  const observations: {
    tokenValid: boolean;
    origin: string | undefined;
    host: string | undefined;
    privateHeadersAbsent: boolean;
  }[] = [];
  const api = createHttpServer((req, res) => {
    const trusted = req.headers['x-alfred-process-token'] === token;
    const observed = req.headers['x-alfred-studio-origin'];
    observations.push({
      tokenValid: trusted,
      origin: typeof observed === 'string' ? observed : undefined,
      host: req.headers.host,
      privateHeadersAbsent:
        req.headers.authorization === undefined &&
        req.headers.cookie === undefined,
    });
    res.statusCode =
      !trusted || (req.method !== 'GET' && req.headers.origin !== observed)
        ? 403
        : 200;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (address === null || typeof address === 'string')
    throw new Error('Proxy fixture API address unavailable');
  const config = createStudioViteConfig({
    proxyToken: token,
    apiOrigin: `http://127.0.0.1:${address.port}`,
  });
  expect(JSON.stringify(config)).not.toContain(token);
  const vite = await createServer({
    ...config,
    configFile: false,
    logLevel: 'silent',
    server: { ...config.server, port: 0, host: '127.0.0.1' },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    await vite.listen();
    const info = vite.httpServer?.address();
    if (!info || typeof info === 'string')
      throw new Error('Proxy fixture Vite address unavailable');
    const url = `http://127.0.0.1:${info.port}`;
    const host = `localhost:${info.port}`;
    const response = await get(
      url + '/api/v1/workspace',
      {
        host,
        origin: `http://${host}`,
        'x-alfred-process-token': 'caller-cannot-supply-token',
        'x-alfred-studio-origin': 'https://attacker.invalid',
        authorization: 'synthetic-private-header',
        cookie: 'synthetic=value',
      },
      'PUT',
    );
    expect(response.status).toBe(200);
    expect(observations.at(-1)).toEqual({
      tokenValid: true,
      origin: `http://${host}`,
      host: `127.0.0.1:${address.port}`,
      privateHeadersAbsent: true,
    });
    expect(
      (
        await get(
          url + '/api/v1/workspace',
          { host, origin: 'https://attacker.invalid' },
          'PUT',
        )
      ).status,
    ).toBe(403);
    const forwarded = await get(
      url + '/api/v1/workspace',
      { host: 'localhost:45555', origin: 'https://localhost:45555' },
      'PUT',
    );
    expect(forwarded.status).toBe(200);
    expect(observations.at(-1)?.origin).toBe('https://localhost:45555');
    const lanHost = '192.168.5.4:5173';
    const lanOrigin = `http://${lanHost}`;
    const lan = await get(
      url + '/api/v1/workspace',
      { host: lanHost, origin: lanOrigin },
      'PUT',
    );
    expect(lan.status).toBe(200);
    expect(observations.at(-1)?.origin).toBe(lanOrigin);
    expect(
      (
        await get(
          url + '/api/v1/workspace',
          { host: lanHost, origin: 'http://attacker.invalid:5173' },
          'PUT',
        )
      ).status,
    ).toBe(403);
    const crossOrigin = await get(url + '/api/v1/workspace', {
      host,
      origin: 'http://localhost:45556',
    });
    expect(crossOrigin.headers['access-control-allow-origin']).toBeUndefined();
    const before = observations.length;
    expect(
      (await get(url + '/api/v1/workspace', { host: 'attacker.invalid' }))
        .status,
    ).toBe(403);
    expect(observations).toHaveLength(before);
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    for (const resource of [
      'content/site.json',
      'server/src/index.ts',
      'node_modules/@foliohaven/server/src/index.ts',
      'packages/core/dist/node/source.js',
    ]) {
      const privateResponse = await get(url + '/@fs/' + repository + resource, {
        host,
      });
      expect(privateResponse.status).toBe(403);
      expect(privateResponse.body).not.toContain(token);
    }
    const client = await get(url + '/@vite/client', { host });
    expect(client.status).toBe(200);
    expect(client.body).not.toContain(token);
    const publicUi = await get(
      url + '/@fs/' + repository + 'packages/ui/dist/index.js',
      { host },
    );
    expect(publicUi.status).toBe(200);
    expect(publicUi.body).not.toContain(token);
  } finally {
    await vite.close();
    await new Promise<void>((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
it('rejects arbitrary proxy targets and malformed secrets without returning their values', () => {
  const token = randomBytes(32).toString('hex');
  for (const apiOrigin of [
    'https://127.0.0.1:3001',
    'http://example.invalid',
    'http://user:secret@127.0.0.1:3001',
    'http://127.0.0.1:3001/private',
    'not-a-url',
  ]) {
    expect(() =>
      createStudioViteConfig({ proxyToken: token, apiOrigin }),
    ).toThrow('Studio代理目的地必須是固定loopback Local Service。');
  }
  expect(() => createStudioViteConfig({ proxyToken: 'malformed' })).toThrow(
    'Studio需要有效的程序內驗證設定。',
  );
});
