import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';

const studioRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(studioRoot, '..');
function baseConfiguration(mode = 'development'): UserConfig {
  const environment = loadEnv(mode, repositoryRoot, [
    'SITE_PORT',
    'PREVIEW_PORT',
  ]);
  const previewPort = (
    key: 'SITE_PORT' | 'PREVIEW_PORT',
    fallback: number,
  ): number => {
    const value = Number(environment[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error('預覽連接埠必須介於1與65535之間。');
    return value;
  };
  return {
    root: studioRoot,
    plugins: [react()],
    define: {
      __ALFRED_SOURCE_PREVIEW_PORT__: previewPort('SITE_PORT', 4321),
      __ALFRED_BUILT_PREVIEW_PORT__: previewPort('PREVIEW_PORT', 4322),
    },
    cacheDir: resolve(studioRoot, 'node_modules/.vite'),
    build: {
      outDir: resolve(studioRoot, 'dist'),
      emptyOutDir: true,
      sourcemap: false,
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      cors: false,
      headers: { 'X-Content-Type-Options': 'nosniff' },
      fs: {
        strict: true,
        allow: [
          studioRoot,
          resolve(repositoryRoot, 'packages/core/dist'),
          resolve(repositoryRoot, 'packages/ui/dist'),
          resolve(repositoryRoot, 'node_modules'),
        ],
        deny: [
          '**/.env',
          '**/.env.*',
          '**/*.pem',
          '**/*.key',
          '**/.git/**',
          '**/.codex/**',
          ...[
            'content',
            'media/source',
            'server',
            '.alfred',
            'node_modules/@foliohaven/server',
            'packages/core/dist/node',
          ].map((path) => `${resolve(repositoryRoot, path)}/**`),
        ],
      },
    },
  };
}
/** Node程序內建立代理；token只存在configure closure，不寫env／檔案或Vite define。 */
export function createStudioViteConfig(options: {
  readonly proxyToken: string;
  readonly apiOrigin?: string;
  readonly host?: '127.0.0.1' | '0.0.0.0';
}): UserConfig {
  if (!/^[a-f0-9]{64}$/u.test(options.proxyToken))
    throw new Error('Studio需要有效的程序內驗證設定。');
  if (
    options.host !== undefined &&
    !['127.0.0.1', '0.0.0.0'].includes(options.host)
  )
    throw new Error('Studio監聽位址必須為明確的本機或容器模式。');
  let target: URL;
  try {
    target = new URL(options.apiOrigin ?? 'http://127.0.0.1:3001');
  } catch {
    throw new Error('Studio代理目的地必須是固定loopback Local Service。');
  }
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash
  )
    throw new Error('Studio代理目的地必須是固定loopback Local Service。');
  const base = baseConfiguration();
  return {
    ...base,
    server: {
      ...base.server,
      host: options.host ?? '127.0.0.1',
      proxy: {
        '/api/v1': {
          target: target.origin,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (outgoing, request) => {
              const host = request.headers.host ?? '';
              // Host由瀏覽器連線決定；同Host Origin可保留forwarding的https scheme與動態port。
              let origin = `http://${host}`;
              if (typeof request.headers.origin === 'string') {
                try {
                  const supplied = new URL(request.headers.origin);
                  if (
                    ['http:', 'https:'].includes(supplied.protocol) &&
                    supplied.host === host
                  )
                    origin = supplied.origin;
                } catch {
                  /* malformed Origin仍由Local Service拒絕mutation。 */
                }
              }
              outgoing.setHeader('x-alfred-process-token', options.proxyToken);
              outgoing.setHeader('x-alfred-studio-origin', origin);
              outgoing.removeHeader('authorization');
              outgoing.removeHeader('cookie');
            });
          },
        },
      },
    },
  };
}

export default defineConfig(({ command, mode }) => {
  if (command === 'serve')
    throw new Error(
      '請使用pnpm dev或pnpm dev:studio，讓協調器建立配對Local Service與記憶體驗證。',
    );
  return baseConfiguration(mode);
});
