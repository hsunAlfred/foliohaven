import { watch } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** @param {string} directory */
async function readStyles(directory) {
  const files = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && /^[a-z0-9-]+\.css$/u.test(entry.name),
  );
  /** @type {Map<string, Buffer>} */
  const contents = new Map();
  await Promise.all(
    files.map(async ({ name }) => {
      contents.set(name, await readFile(resolve(directory, name)));
    }),
  );
  return contents;
}

/**
 * The package sync replaces dist/styles, which Vite ignores by default. Watch
 * the trusted source directory and bridge only completed CSS syncs into HMR.
 * @param {{ repositoryRoot: string }} options
 * @returns {import('vite').Plugin}
 */
export function astroDevStyles({ repositoryRoot }) {
  let dispose = () => {};
  return {
    name: 'alfred-development-styles',
    apply: 'serve',
    configureServer(server) {
      dispose();
      const source = resolve(repositoryRoot, 'packages/ui/src/styles');
      const output = resolve(repositoryRoot, 'packages/ui/dist/styles');
      const entry = resolve(output, 'index.css');
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      let generation = 0;
      let deadline = 0;
      let closed = false;

      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 150);
      };
      const refresh = async () => {
        timer = undefined;
        const current = generation;
        let synced = false;
        try {
          const [before, after] = await Promise.all([
            readStyles(source),
            readStyles(output),
          ]);
          synced =
            before.has('index.css') &&
            before.size === after.size &&
            [...before].every(([name, bytes]) =>
              after.get(name)?.equals(bytes),
            );
        } catch {
          // The official sync removes and copies the output directory. A
          // temporarily missing file must never trigger a premature reload.
        }
        if (closed || current !== generation) return;
        if (!synced) {
          if (Date.now() < deadline) schedule();
          else
            server.config.logger.warn(
              '共用 CSS 尚未同步，請檢查 package watch 或執行 pnpm build:packages。',
            );
          return;
        }
        // Standard Vite change handling invalidates every environment's graph
        // and lets Astro clear its SSR inline-CSS cache through its HMR hook.
        server.watcher.emit('change', entry);
        server.ws.send({ type: 'full-reload' });
      };
      const watcher = watch(source, { persistent: false }, (_event, name) => {
        if (
          closed ||
          (name !== null && !/^[a-z0-9-]+\.css$/u.test(String(name)))
        )
          return;
        generation += 1;
        deadline = Date.now() + 5_000;
        schedule();
      });
      const onError = () => {
        server.config.logger.error(
          '共用 CSS 來源監看失敗，請重新開啟作者服務。',
        );
        dispose();
      };
      dispose = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        watcher.removeListener('error', onError);
        watcher.close();
        server.httpServer?.removeListener('close', dispose);
      };
      watcher.on('error', onError);
      server.httpServer?.once('close', dispose);
    },
    closeBundle() {
      dispose();
    },
  };
}
