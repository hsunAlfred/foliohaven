import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

const io = vi.hoisted(() => ({
  watch: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock('node:fs', () => ({ watch: io.watch }));
vi.mock('node:fs/promises', () => ({
  readFile: io.readFile,
  readdir: io.readdir,
}));

interface StylesPlugin {
  apply: string;
  configureServer(server: {
    config: {
      logger: {
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
      };
    };
    watcher: EventEmitter;
    httpServer: EventEmitter;
    ws: { send: ReturnType<typeof vi.fn> };
  }): void;
  closeBundle(): void;
}

const root = resolve('/trusted-project');
const source = resolve(root, 'packages/ui/src/styles');
const output = resolve(root, 'packages/ui/dist/styles');
const entry = resolve(output, 'index.css');
let changed: (_event: string, name: string | null) => void;
let files: Map<string, string>;
let sourceWatcher: EventEmitter & { close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  files = new Map([
    [resolve(source, 'index.css'), '@import "./article.css";'],
    [resolve(output, 'index.css'), '@import "./article.css";'],
    [resolve(source, 'article.css'), '.article { color: blue; }'],
    [resolve(output, 'article.css'), '.article { color: blue; }'],
  ]);
  sourceWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  io.watch.mockImplementation((_path, _options, listener: typeof changed) => {
    changed = listener;
    return sourceWatcher;
  });
  io.readdir.mockImplementation(async (directory: string) =>
    [...files.keys()]
      .filter((path) => path.startsWith(directory + '/'))
      .map((path) => ({
        name: path.slice(directory.length + 1),
        isFile: () => true,
      })),
  );
  io.readFile.mockImplementation(async (path: string) => {
    const value = files.get(path);
    if (value === undefined)
      throw Object.assign(new Error(), { code: 'ENOENT' });
    return Buffer.from(value);
  });
});
afterEach(() => {
  vi.useRealTimers();
});

async function fixture() {
  const { astroDevStyles } = (await import(
    new URL('../../scripts/astro-dev-styles.mjs', import.meta.url).href
  )) as { astroDevStyles(options: { repositoryRoot: string }): StylesPlugin };
  const plugin = astroDevStyles({ repositoryRoot: root });
  const server = {
    config: { logger: { warn: vi.fn(), error: vi.fn() } },
    watcher: new EventEmitter(),
    httpServer: new EventEmitter(),
    ws: { send: vi.fn() },
  };
  const notifications: string[] = [];
  server.watcher.on('change', (path: string) => notifications.push(path));
  plugin.configureServer(server);
  return { plugin, server, notifications };
}

describe('Astro development CSS synchronization', () => {
  it('waits for every imported CSS copy, debounces source events and emits the public entry', async () => {
    const { plugin, server, notifications } = await fixture();
    expect(plugin.apply).toBe('serve');
    expect(io.watch).toHaveBeenCalledWith(
      source,
      { persistent: false },
      expect.any(Function),
    );
    files.set(resolve(source, 'article.css'), '.article { color: red; }');
    changed('change', 'article.css');
    changed('rename', 'article.css');
    await vi.advanceTimersByTimeAsync(150);
    expect(notifications).toEqual([]);
    expect(server.ws.send).not.toHaveBeenCalled();
    files.delete(entry);
    files.set(resolve(output, 'article.css'), '.article { color: red; }');
    await vi.advanceTimersByTimeAsync(150);
    expect(notifications).toEqual([]);
    files.set(entry, '@import "./article.css";');
    await vi.advanceTimersByTimeAsync(150);
    expect(notifications).toEqual([entry]);
    expect(server.ws.send).toHaveBeenCalledExactlyOnceWith({
      type: 'full-reload',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notifications).toEqual([entry]);
    plugin.closeBundle();
  });

  it('ignores non-CSS and escaped paths, and never watches generated output', async () => {
    const { plugin, notifications } = await fixture();
    for (const name of [
      'notes.md',
      '../index.css',
      'nested/index.css',
      '/etc/private.css',
    ])
      changed('change', name);
    await vi.advanceTimersByTimeAsync(500);
    expect(io.readdir).not.toHaveBeenCalled();
    expect(notifications).toEqual([]);
    expect(io.watch).toHaveBeenCalledTimes(1);
    changed('change', null);
    await vi.advanceTimersByTimeAsync(150);
    expect(notifications).toEqual([entry]);
    plugin.closeBundle();
  });

  it('bounds retries and releases its timer and native watcher when Vite closes', async () => {
    const { plugin, server, notifications } = await fixture();
    files.set(resolve(source, 'article.css'), 'pending sync');
    changed('change', 'article.css');
    await vi.advanceTimersByTimeAsync(5_100);
    expect(server.config.logger.warn).toHaveBeenCalledOnce();
    expect(notifications).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    changed('change', 'article.css');
    server.httpServer.emit('close');
    plugin.closeBundle();
    expect(sourceWatcher.close).toHaveBeenCalledOnce();
    expect(sourceWatcher.listenerCount('error')).toBe(0);
    expect(server.httpServer.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(notifications).toEqual([]);
  });

  it('cleans up when the native source watcher fails', async () => {
    const { plugin, server } = await fixture();
    changed('change', 'article.css');
    sourceWatcher.emit('error', new Error('watch failed'));
    expect(server.config.logger.error).toHaveBeenCalledOnce();
    expect(sourceWatcher.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    plugin.closeBundle();
  });
});
