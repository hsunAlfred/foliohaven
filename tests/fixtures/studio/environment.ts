import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createServer } from 'vite';
import { createLocalService } from '../../../server/src/http/index.js';
import { RepositoryError } from '../../../server/src/files/io.js';
import { createStudioViteConfig } from '../../../studio/vite.config.js';
import { sandbox, smallBuild } from '../http/environment.mjs';

export async function studioEnvironment(
  options: { commandHarness?: boolean } = {},
) {
  const root = await sandbox();
  const render = smallBuild.render;
  if (!render) throw new Error('Studio fixture requires render');
  const token = randomBytes(32).toString('hex');
  let mode: 'success' | 'failure' | 'wait' = 'success';
  const service = await createLocalService({
    repositoryRoot: root,
    proxyToken: token,
    buildExecution: {
      ...smallBuild,
      render: async (context) => {
        if (mode === 'failure')
          throw new RepositoryError(
            'STUDIO_FIXTURE_BUILD_FAILED',
            '隔離測試的建置階段失敗。',
            503,
          );
        if (mode === 'wait')
          await new Promise<never>((_resolve, reject) => {
            const abort = () =>
              reject(
                new RepositoryError(
                  'BUILD_CANCELLED',
                  '隔離測試工作已取消。',
                  409,
                ),
              );
            context.signal.addEventListener('abort', abort, { once: true });
            if (context.signal.aborted) abort();
          });
        await render(context);
      },
    },
  });
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const address = await service.listen({ port: 0 });
    const configuration = createStudioViteConfig({
      proxyToken: token,
      apiOrigin: address.url,
    });
    const cacheDir = join(root, 'studio/node_modules/.vite-cache-studio');
    const harnessFile = fileURLToPath(
      new URL('./command-harness.tsx', import.meta.url),
    );
    vite = await createServer({
      configFile: false,
      ...configuration,
      logLevel: 'silent',
      cacheDir,
      plugins: [
        ...(configuration.plugins ?? []),
        ...(options.commandHarness
          ? [
              {
                name: 'studio-command-test-only',
                configureServer(
                  server: Awaited<ReturnType<typeof createServer>>,
                ) {
                  server.middlewares.use(
                    '/__command-harness',
                    (_request, response, next) => {
                      void server
                        .transformIndexHtml(
                          '/__command-harness',
                          `<html><head></head><body><div id="command-root"></div><script type="module" src="/@fs/${harnessFile}"></script></body></html>`,
                        )
                        .then((value) => {
                          response.setHeader(
                            'Content-Type',
                            'text/html; charset=utf-8',
                          );
                          response.end(value);
                        })
                        .catch(next);
                    },
                  );
                },
              },
            ]
          : []),
      ],
      server: {
        ...configuration.server,
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        fs: {
          ...configuration.server?.fs,
          allow: [
            ...(configuration.server?.fs?.allow ?? []),
            cacheDir,
            ...(options.commandHarness ? [harnessFile] : []),
          ],
        },
      },
    });
    await vite.listen();
    const socket = vite.httpServer?.address() as AddressInfo | null;
    if (!socket) throw new Error('Studio fixture failed to bind');
    return {
      root,
      url: `http://127.0.0.1:${socket.port}`,
      setBuildMode: (value: typeof mode) => {
        mode = value;
      },
      stopService: () => service.close(),
      close: async () => {
        await vite?.close();
        await service.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await vite?.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
