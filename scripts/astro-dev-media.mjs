import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Astro disposes its config module runner before configureServer executes.
// Resolve while evaluating the config, then use Node's loader for the factory.
const load = createRequire(import.meta.url);
const serverEntry = fileURLToPath(import.meta.resolve('@foliohaven/server'));

/**
 * Root tooling owns the Server dependency; the Site package only consumes this
 * development adapter. Static builds never load the management/runtime module.
 * @param {{ repositoryRoot: string; contextModulePath: string }} options
 * @returns {import('vite').Plugin}
 */
export function astroDevMedia(options) {
  return {
    name: 'alfred-development-media',
    apply: 'serve',
    configureServer(server) {
      /** @type {typeof import('@foliohaven/server')} */
      const { createDevMediaMiddleware } = load(serverEntry);
      server.middlewares.use(
        createDevMediaMiddleware({
          repositoryRoot: options.repositoryRoot,
          loadContext: async () => {
            // Resolve through the live SSR graph on every request so HMR also
            // updates schemas; the disposed config runner must not own it.
            const context = await server.ssrLoadModule(
              options.contextModulePath,
            );
            return context.loadRenderContext();
          },
        }),
      );
    },
  };
}
