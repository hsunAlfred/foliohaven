import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { astroDevMedia } from '../scripts/astro-dev-media.mjs';
import { astroDevStyles } from '../scripts/astro-dev-styles.mjs';
import { loadAstroConfigContext } from './src/lib/server/context.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const workspace = resolve(root, '..');
const context = await loadAstroConfigContext();
const contextRoot = process.env['ALFRED_RENDER_CONTEXT'];
if (contextRoot === undefined) throw new Error('RENDER_CONTEXT_REQUIRED');
const output = process.env['ALFRED_RENDER_OUTPUT'];
if (output === undefined)
  throw new Error('RENDER_OUTPUT_REQUIRED：請使用專案的建置或開發入口。');
const indexed = new Set(
  context.routeManifest.routes
    .filter((route) => route.index)
    .map((route) => new URL(route.path, context.site.siteUrl).href),
);
export default defineConfig({
  root,
  site: context.site.siteUrl,
  output: 'static',
  trailingSlash: 'always',
  outDir: resolve(output),
  cacheDir: resolve(dirname(contextRoot), 'astro-cache'),
  publicDir: resolve(root, 'public'),
  build: { format: 'directory', assets: 'assets' },
  integrations: [
    react(),
    sitemap({ filter: (page) => indexed.has(page) }),
    {
      name: 'alfred-empty-sitemap',
      hooks: {
        'astro:build:done': async ({ dir }) => {
          if (indexed.size === 0) {
            await writeFile(
              new URL('sitemap-0.xml', dir),
              '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
            );
            await writeFile(
              new URL('sitemap-index.xml', dir),
              '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>' +
                new URL('/sitemap-0.xml', context.site.siteUrl).href +
                '</loc></sitemap></sitemapindex>',
            );
          }
        },
      },
    },
  ],
  vite: {
    resolve: {
      preserveSymlinks: false,
      alias: [
        {
          // Astro keeps this non-relative identity in the island hash; Vite
          // resolves the actual module inside the current workspace/snapshot.
          find: /^virtual:alfred\/articles-search$/u,
          replacement: resolve(root, 'src/components/ArticlesSearch.tsx'),
        },
      ],
    },
    cacheDir: resolve(root, 'node_modules/.vite-cache'),
    build: { sourcemap: false },
    server: {
      strictPort: true,
      fs: {
        strict: true,
        allow: [
          root,
          resolve(root, '../packages/core/dist'),
          resolve(root, '../packages/ui/dist'),
          resolve(root, '../node_modules'),
        ],
        deny: [
          ...[
            'content',
            'media/source',
            '.alfred',
            '.git',
            'server',
            'studio',
            'packages/core/dist/node',
          ].flatMap((directory) => [
            resolve(workspace, directory),
            `${resolve(workspace, directory)}/**`,
          ]),
          `${resolve(root, 'src/lib/server')}/**`,
          '**/.env*',
          '**/*.map',
        ],
      },
    },
    plugins: [
      astroDevStyles({ repositoryRoot: workspace }),
      astroDevMedia({
        repositoryRoot: workspace,
        contextModulePath: resolve(root, 'src/lib/server/context.ts'),
      }),
      {
        name: 'alfred-public-import-graph',
        applyToEnvironment(environment) {
          return environment.config.consumer === 'client';
        },
        generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk') continue;
            for (const id of Object.keys(chunk.modules))
              if (
                id.startsWith('node:') ||
                id.includes('__vite-browser-external') ||
                ['content', 'media/source', '.alfred', '.git'].some(
                  (directory) =>
                    id.startsWith(`${resolve(workspace, directory)}/`),
                ) ||
                id.startsWith(`${resolve(root, 'src/lib/server')}/`) ||
                id.startsWith(`${resolve(workspace, 'server')}/`) ||
                id.startsWith(`${resolve(workspace, 'studio')}/`) ||
                id.startsWith(
                  `${resolve(workspace, 'packages/core/dist/node')}/`,
                ) ||
                /\/(?:sharp|@img\/sharp-[^/]+)\//u.test(id) ||
                id.endsWith('.node')
              )
                throw new Error(
                  'PRIVATE_BROWSER_IMPORT_REJECTED：瀏覽器產物不可依賴本機服務或原生模組。',
                );
            for (const imported of [...chunk.imports, ...chunk.dynamicImports])
              if (bundle[imported] === undefined)
                throw new Error(
                  'EXTERNAL_BROWSER_IMPORT_REJECTED：公開程式必須包含完整相依產物。',
                );
          }
        },
      },
      {
        name: 'alfred-private-context-refresh',
        configureServer(server) {
          const index = resolve(contextRoot, 'index.json');
          server.watcher.add(index);
          server.watcher.on('all', (_event, file) => {
            if (resolve(file) === index) {
              // 交由標準TS HMR傳播，讓SSR runner與getStaticPaths一同失效。
              server.watcher.emit(
                'change',
                resolve(root, 'src/lib/server/context.ts'),
              );
              server.ws.send({ type: 'full-reload' });
            }
          });
        },
      },
    ],
  },
});
