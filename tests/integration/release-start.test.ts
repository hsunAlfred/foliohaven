import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { acquireFileLease } from '../../server/src/runtime/lease.js';
import { releaseStartFixture } from '../fixtures/release/start.js';
import type { StartCase } from '../fixtures/release/start.js';
const cleanup: (() => Promise<void>)[] = [];
async function fixture(options: StartCase = {}) {
  const value = await releaseStartFixture(options);
  cleanup.push(value.cleanup);
  return value;
}
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function exists(root: string, path: string) {
  try {
    await readFile(join(root, path));
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

describe('release startup gates and process lifecycle', () => {
  it.each(['FOLIOHAVEN_RELEASE_VERSION', 'ALFRED_RELEASE_VERSION'])(
    'rejects arbitrary arguments and %s mismatches before dependency or source writes',
    async (versionName) => {
      const f = await fixture();
      const output: string[] = [];
      await expect(
        f.execute(['--unknown'], { onOutput: (text) => output.push(text) }),
      ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
      expect(output.join('')).toContain('START_ARGUMENT_INVALID');
      await expect(
        f.execute([], {
          env: { [versionName]: '999.0.0' },
          onOutput: (text) => output.push(text),
        }),
      ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
      expect(output.join('')).toContain('START_IMAGE_MISMATCH');
      expect(await f.commands()).toEqual([]);
      expect(await readFile(join(f.root, 'content/author.txt'), 'utf8')).toBe(
        'author bytes must survive\n',
      );
    },
  );
  it.each(['999.0.0', ''])(
    'does not fall back to a valid legacy version when the new version is %j',
    async (newVersion) => {
      const f = await fixture();
      const output: string[] = [];
      await expect(
        f.execute([], {
          env: {
            FOLIOHAVEN_RELEASE_VERSION: newVersion,
            ALFRED_RELEASE_VERSION: '0.1.0',
          },
          onOutput: (text) => output.push(text),
        }),
      ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
      expect(output.join('')).toContain('START_IMAGE_MISMATCH');
      expect(await f.commands()).toEqual([]);
    },
  );
  it('uses the new image version instead of a conflicting legacy variable', async () => {
    const f = await fixture({ failAt: 'install' });
    const output: string[] = [];
    await expect(
      f.execute([], {
        env: {
          FOLIOHAVEN_RELEASE_VERSION: '0.1.0',
          ALFRED_RELEASE_VERSION: '999.0.0',
        },
        onOutput: (text) => output.push(text),
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
    expect(output.join('')).not.toContain('START_IMAGE_MISMATCH');
    expect(output.join('')).toContain('START_DEPENDENCIES_FAILED');
    expect(await f.commands()).not.toEqual([]);
  });
  it('a held dev-session or occupied port prevents offline installation entirely', async () => {
    const f = await fixture();
    const output: string[] = [];
    const lease = await acquireFileLease({
      root: f.root,
      name: 'dev-session',
      owner: 'release-test',
      nonBlocking: true,
    });
    expect(lease).not.toBeNull();
    try {
      await expect(
        f.execute([], { onOutput: (text) => output.push(text) }),
      ).rejects.toMatchObject({
        code: 'PROCESS_EXITED',
      });
      expect(output.join('')).toContain('START_ALREADY_RUNNING');
      expect(await f.commands()).toEqual([]);
    } finally {
      await lease?.release();
    }
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(f.ports.preview, '127.0.0.1', resolve),
    );
    try {
      await expect(
        f.execute([], { onOutput: (text) => output.push(text) }),
      ).rejects.toMatchObject({
        code: 'PROCESS_EXITED',
      });
      expect(output.join('')).toContain('START_PORT_IN_USE');
      expect(await f.commands()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
  it.each(['install', 'packages', 'server', 'build'] as const)(
    'releases the genuine OS lease after %s fails without reporting readiness',
    async (failAt) => {
      const f = await fixture({ failAt });
      const output: string[] = [];
      await expect(
        f.execute([], { onOutput: (text) => output.push(text) }),
      ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
      const commands = await f.commands();
      expect(commands.length, output.join('')).toBeGreaterThan(0);
      expect(output.join('')).toContain(
        failAt === 'install'
          ? 'START_DEPENDENCIES_FAILED'
          : failAt === 'build'
            ? 'START_FIRST_BUILD_FAILED'
            : 'START_COMPILE_FAILED',
      );
      expect(
        commands
          .filter((c) => c.args[0] !== 'formal-build')
          .every((c) => c.held),
      ).toBe(true);
      expect(output.join('')).not.toContain('START_READY');
      expect(await exists(f.root, 'dev-started.json')).toBe(false);
      const lease = await acquireFileLease({
        root: f.root,
        name: 'dev-session',
        owner: 'after-failure',
        nonBlocking: true,
      });
      expect(lease).not.toBeNull();
      await lease?.release();
      expect(await readFile(join(f.root, 'content/author.txt'), 'utf8')).toBe(
        'author bytes must survive\n',
      );
    },
  );
  it.each(['unknown', 'recovery', 'bad-preview'] as const)(
    'preserves %s artifacts and refuses implicit rebuild or service startup',
    async (artifact) => {
      const f = await fixture({ artifact });
      await expect(f.execute()).rejects.toMatchObject({
        code: 'PROCESS_EXITED',
      });
      expect(
        (await f.commands()).some((c) => c.args[0] === 'formal-build'),
      ).toBe(false);
      expect(await exists(f.root, 'dev-started.json')).toBe(false);
      expect(await readFile(join(f.root, 'content/author.txt'), 'utf8')).toBe(
        'author bytes must survive\n',
      );
    },
  );
  it.each([
    { artifact: 'fresh', args: [], repair: false },
    { artifact: 'ready', args: ['--container'], repair: false },
    { artifact: 'recovery', args: ['--container', '--repair'], repair: true },
  ] as const)(
    'starts $artifact with explicit bind mode, preserves data and closes every owned service',
    async ({ artifact, args, repair }) => {
      const f = await fixture({ artifact });
      const controller = new AbortController();
      let ready: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const running = f.execute(args, {
        signal: controller.signal,
        onOutput: (text) => {
          if (text.includes(repair ? 'REPAIR_READY' : 'START_READY')) ready();
        },
      });
      try {
        await Promise.race([
          started,
          running.then(() => {
            throw new Error('EXITED_BEFORE_READY');
          }),
        ]);
        const info = JSON.parse(
          await readFile(join(f.root, 'dev-started.json'), 'utf8'),
        ) as { repair: boolean; host: string; api: string; pid: number };
        expect(info).toMatchObject({
          repair,
          host: args.some((arg) => arg === '--container')
            ? '0.0.0.0'
            : '127.0.0.1',
          api: '127.0.0.1',
        });
        expect(Number.isSafeInteger(info.pid)).toBe(true);
        const commands = await f.commands();
        expect(
          commands.filter((c) => c.args[0] === 'formal-build'),
        ).toHaveLength(artifact === 'fresh' ? 1 : 0);
        expect(
          commands
            .filter((c) => c.args[0] !== 'formal-build')
            .every((c) => c.held),
        ).toBe(true);
        expect(commands[0]?.args).toEqual([
          'install',
          '--offline',
          '--frozen-lockfile',
          '--prod=false',
          '--ignore-scripts',
        ]);
        if (repair) {
          expect(await exists(f.root, 'artifact-checks.jsonl')).toBe(false);
          expect(await exists(f.root, 'preview-started.txt')).toBe(false);
          await expect(f.health(['--studio'])).resolves.toBeDefined();
          await expect(f.health(['--release'])).rejects.toMatchObject({
            code: 'PROCESS_EXITED',
          });
        } else {
          expect(
            (await fetch(`http://127.0.0.1:${f.ports.preview}/`)).status,
          ).toBe(200);
          await expect(f.health(['--release'])).resolves.toBeDefined();
        }
        expect(await readFile(join(f.root, 'content/author.txt'), 'utf8')).toBe(
          'author bytes must survive\n',
        );
      } finally {
        controller.abort();
        await running.catch((error) => {
          expect(error).toMatchObject({ code: 'PROCESS_CANCELLED' });
        });
      }
      expect(await readFile(join(f.root, 'dev-stopped.txt'), 'utf8')).toBe(
        'closed',
      );
      if (!repair)
        expect(
          await readFile(join(f.root, 'preview-stopped.txt'), 'utf8'),
        ).toBe('closed');
      const lease = await acquireFileLease({
        root: f.root,
        name: 'dev-session',
        owner: 'after-stop',
        nonBlocking: true,
      });
      expect(lease).not.toBeNull();
      await lease?.release();
      for (const port of Object.values(f.ports)) {
        const probe = createServer();
        await new Promise<void>((resolve, reject) => {
          probe.once('error', reject);
          probe.listen(port, '127.0.0.1', resolve);
        });
        await new Promise<void>((resolve) => probe.close(() => resolve()));
      }
    },
  );
  it('cancels dependency bootstrap and releases the session without starting any service', async () => {
    const f = await fixture({ blockInstall: true });
    const controller = new AbortController();
    let blocked: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const running = f.execute([], {
      signal: controller.signal,
      onOutput: (text) => {
        if (text.includes('INSTALL_BLOCKED')) blocked();
      },
    });
    try {
      await Promise.race([
        barrier,
        running.then(() => {
          throw new Error('EXITED_BEFORE_BLOCK');
        }),
      ]);
    } finally {
      controller.abort();
      await expect(running).rejects.toMatchObject({
        code: 'PROCESS_CANCELLED',
      });
    }
    expect((await f.commands())[0]?.held).toBe(true);
    expect(await exists(f.root, 'dev-started.json')).toBe(false);
    const lease = await acquireFileLease({
      root: f.root,
      name: 'dev-session',
      owner: 'after-cancel',
      nonBlocking: true,
    });
    expect(lease).not.toBeNull();
    await lease?.release();
  });
  it('an unexpected dev exit stops the sibling preview and reports a safe nonzero result', async () => {
    const f = await fixture({ artifact: 'ready' });
    const controller = new AbortController();
    const output: string[] = [];
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const running = f.execute([], {
      signal: controller.signal,
      onOutput: (text) => {
        output.push(text);
        if (text.includes('START_READY')) ready();
      },
    });
    try {
      await Promise.race([
        started,
        running.then(() => {
          throw new Error('EXITED_BEFORE_READY');
        }),
      ]);
      const info = JSON.parse(
        await readFile(join(f.root, 'dev-started.json'), 'utf8'),
      ) as { pid: number };
      process.kill(info.pid, 'SIGKILL');
      await expect(running).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
      expect(output.join('')).toContain('START_SERVICE_EXITED');
      expect(output.join('')).not.toContain(f.root);
      expect(await readFile(join(f.root, 'preview-stopped.txt'), 'utf8')).toBe(
        'closed',
      );
    } finally {
      controller.abort();
      await running.catch(() => undefined);
    }
    const lease = await acquireFileLease({
      root: f.root,
      name: 'dev-session',
      owner: 'after-failure',
      nonBlocking: true,
    });
    expect(lease).not.toBeNull();
    await lease?.release();
  });
});
