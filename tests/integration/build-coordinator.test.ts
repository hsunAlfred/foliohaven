import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { FileRepository } from '../../server/src/files/index.js';
import { atomicJson, safeMkdir } from '../../server/src/files/io.js';
import {
  BuildCoordinator,
  type BuildCoordinatorOptions,
} from '../../server/src/build/coordinator.js';
import { ArtifactStore } from '../../server/src/build/artifacts/index.js';
import { scanBuildInputs } from '../../server/src/build/inputs.js';
import { acquireFileLease } from '../../server/src/runtime/lease.js';
import type { JobContext } from '../../server/src/jobs/types.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-coordinator-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    'content/articles',
    'packages/core/src',
    'packages/ui/src',
    'site/src',
    'studio/src',
    'server/src',
    'scripts',
    'dist',
  ])
    await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  for (const [path, value] of Object.entries({
    '.node-version': '26.12.1\n',
    'package.json': '{}',
    'pnpm-workspace.yaml': 'packages: []\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'content/site.json': '{}',
    'site/src/page.ts': 'INITIAL_PROGRAM',
    'scripts/build-worker.mjs': 'INITIAL_WORKER',
    'dist/index.html': 'OLD_SUCCESS',
  }))
    await writeFile(join(root, path), value);
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  const artifacts = new ArtifactStore({ repositoryRoot: root });
  const controller = new AbortController();
  const id = randomUUID();
  const lease = await acquireFileLease({
    root,
    name: 'build-execution',
    owner: 'build-test',
  });
  if (!lease) throw new Error('Fixture build lease unavailable');
  cleanup.push(() => lease.release());
  const stages: string[] = [];
  const context: JobContext = {
    jobId: id,
    leaseFd: lease.fd,
    signal: controller.signal,
    progress: async ({ stage }) => {
      stages.push(stage);
      await repository.workspace({
        scanInputs: async () => (await scanBuildInputs(root)).revision,
      });
    },
  };
  const render: NonNullable<
    NonNullable<BuildCoordinatorOptions['execution']>['render']
  > = async (options) => {
    await safeMkdir(root, `.foliohaven/builds/${id}/output`);
    await writeFile(
      join(root, `.foliohaven/builds/${id}/output/index.html`),
      'NEW_SUCCESS',
    );
    await safeMkdir(options.snapshotRoot, '.foliohaven');
    await atomicJson(options.snapshotRoot, '.foliohaven/build-result.json', {
      schemaVersion: 1,
      mediaPending: false,
      pendingLinkChecks: 0,
      result: {
        outputDirectory: 'dist',
        snapshotRevision: options.snapshotRevision,
        routeCount: 1,
        fileCount: 1,
        warnings: [],
      },
    });
  };
  const execution = { prepare: async () => {}, render };
  const coordinator = (options: Partial<BuildCoordinatorOptions> = {}) =>
    new BuildCoordinator({
      repositoryRoot: root,
      repository,
      artifacts,
      execution,
      ...options,
    });
  return {
    root,
    repository,
    artifacts,
    controller,
    id,
    context,
    stages,
    execution,
    render,
    coordinator,
  };
}
async function oldDist(root: string) {
  expect(await readFile(join(root, 'dist/index.html'), 'utf8')).toBe(
    'OLD_SUCCESS',
  );
}
async function noSnapshot(root: string, id: string) {
  await expect(
    lstat(join(root, `.foliohaven/builds/${id}/snapshot`)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('complete build coordinator and final source CAS', () => {
  it('reads artifact and workspace state under one ordered gate before the first dist exists', async () => {
    const f = await fixture();
    await rm(join(f.root, 'dist'), { recursive: true });
    const result = await f.artifacts.withStateGate(async (state) => ({
      state,
      workspace: await f.repository.workspace({
        scanInputs: async () => (await scanBuildInputs(f.root)).revision,
      }),
    }));
    expect(result.state).toEqual({
      recoveryState: 'ready',
      currentDigest: null,
    });
    expect(result.workspace.value.recoveryState).toBe('ready');
  });
  it.each(['safe', 'invalid', 'missing'] as const)(
    'accepts only a validated private failure report from a real worker: %s',
    async (kind) => {
      const f = await fixture();
      const issue = {
        path: ['articles', 'broken', 'line', 2],
        code: 'BROKEN_LINK',
        message: '請修正站內連結。',
      };
      const value =
        kind === 'safe'
          ? {
              schemaVersion: 1,
              error: {
                code: 'CONTENT_INVALID',
                message: '請修正來源資料。',
                retryable: false,
                issues: [issue],
              },
            }
          : {
              schemaVersion: 99,
              error: { code: 'INVALID', privatePath: '/private/path' },
            };
      await writeFile(
        join(f.root, 'scripts/build-worker.mjs'),
        `import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('.foliohaven', {recursive:true, mode:0o700});
${kind === 'missing' ? '' : `await writeFile('.foliohaven/build-failure.json', ${JSON.stringify(JSON.stringify(value))});`}
process.stderr.write('PRIVATE_STDERR_MUST_NOT_ESCAPE');
process.exitCode = 1;`,
      );
      const execution = { prepare: async () => {} };
      const error: unknown = await f
        .coordinator({ execution })
        .run(f.context, {})
        .catch((error) => error);
      expect(error).toMatchObject(
        kind === 'safe'
          ? {
              code: 'CONTENT_INVALID',
              message: '請修正來源資料。',
              issues: [issue],
              retryable: false,
            }
          : { code: 'PROCESS_EXITED' },
      );
      expect(String(error)).not.toContain('PRIVATE_STDERR');
      await oldDist(f.root);
      await noSnapshot(f.root, f.id);
    },
  );
  it('validates queued source revision and rejects null or changed inputs', async () => {
    const f = await fixture();
    const revision = (await scanBuildInputs(f.root)).revision;
    expect(await f.coordinator().validateSource({}, revision)).toBe(true);
    expect(await f.coordinator().validateSource({}, null)).toBe(false);
    await writeFile(join(f.root, 'scripts/build-worker.mjs'), 'CHANGED');
    expect(await f.coordinator().validateSource({}, revision)).toBe(false);
  });
  it('promotes one isolated artifact, records real counts, releases locks and removes raw snapshot', async () => {
    const f = await fixture();
    const before = (await scanBuildInputs(f.root)).revision;
    const result = await f.coordinator().run(f.context, {});
    expect(result).toMatchObject({
      outputDirectory: 'dist',
      snapshotRevision: before,
      fileCount: 1,
      routeCount: 1,
    });
    expect(await readFile(join(f.root, 'dist/index.html'), 'utf8')).toBe(
      'NEW_SUCCESS',
    );
    expect((await f.artifacts.committedProof(f.id))?.result).toEqual(result);
    expect((await scanBuildInputs(f.root)).revision).toBe(before);
    expect(f.stages).toEqual([
      'snapshot-inputs',
      'offline-dependencies',
      'rendering',
      'verifying',
      'preparing-promotion',
    ]);
    await noSnapshot(f.root, f.id);
  });
  it.each(['change', 'add', 'delete'] as const)(
    'rejects a live program %s while rendering an immutable snapshot',
    async (mode) => {
      const f = await fixture();
      const render = async (options: Parameters<typeof f.render>[0]) => {
        const path = join(f.root, 'site/src/page.ts');
        if (mode === 'change') await writeFile(path, 'CHANGED_PROGRAM');
        if (mode === 'add')
          await writeFile(join(f.root, 'site/src/new.ts'), 'ADDED_PROGRAM');
        if (mode === 'delete') await rm(path);
        expect(
          await readFile(
            join(options.snapshotRoot, 'site/src/page.ts'),
            'utf8',
          ),
        ).toBe('INITIAL_PROGRAM');
        await f.render(options);
      };
      await expect(
        f
          .coordinator({ execution: { ...f.execution, render } })
          .run(f.context, {}),
      ).rejects.toMatchObject({ code: 'BUILD_INPUT_CHANGED' });
      await oldDist(f.root);
      await noSnapshot(f.root, f.id);
      expect(await f.artifacts.committedProof(f.id)).toBeNull();
      expect((await f.artifacts.recover()).recoveryState).toBe('ready');
    },
  );
  it('rejects a coordinated edit restored to identical bytes through generation', async () => {
    const f = await fixture();
    const original = (await scanBuildInputs(f.root)).revision;
    const render = async (options: Parameters<typeof f.render>[0]) => {
      await writeFile(join(f.root, 'site/src/page.ts'), 'TEMPORARY');
      await f.repository.noteExternalChange();
      await writeFile(join(f.root, 'site/src/page.ts'), 'INITIAL_PROGRAM');
      expect((await scanBuildInputs(f.root)).revision).toBe(original);
      await f.render(options);
    };
    await expect(
      f
        .coordinator({ execution: { ...f.execution, render } })
        .run(f.context, {}),
    ).rejects.toMatchObject({ code: 'BUILD_INPUT_CHANGED' });
    await oldDist(f.root);
  });
  it('keeps the writer available during expensive artifact preparation, then rechecks generation', async () => {
    const f = await fixture();
    let observed = false;
    const artifacts = new ArtifactStore({
      repositoryRoot: f.root,
      fault: async (event) => {
        if (event.phase === 'prepared-copies') {
          await f.repository.noteExternalChange();
          observed = true;
        }
      },
    });
    await expect(
      f.coordinator({ artifacts }).run(f.context, {}),
    ).rejects.toMatchObject({ code: 'BUILD_INPUT_CHANGED' });
    expect(observed).toBe(true);
    await oldDist(f.root);
  });
  it.each([
    'mediaPending',
    'pendingLinkChecks',
    'revision',
    'fileCount',
  ] as const)(
    'refuses incomplete or inconsistent worker report: %s',
    async (problem) => {
      const f = await fixture();
      const render = async (options: Parameters<typeof f.render>[0]) => {
        await f.render(options);
        const path = join(
          options.snapshotRoot,
          '.foliohaven/build-result.json',
        );
        const value: {
          mediaPending: boolean;
          pendingLinkChecks: number;
          result: { snapshotRevision: string; fileCount: number };
        } = JSON.parse(await readFile(path, 'utf8'));
        if (problem === 'mediaPending') value.mediaPending = true;
        if (problem === 'pendingLinkChecks') value.pendingLinkChecks = 1;
        if (problem === 'revision')
          value.result.snapshotRevision = 'f'.repeat(64);
        if (problem === 'fileCount') value.result.fileCount = 2;
        await writeFile(path, JSON.stringify(value));
      };
      await expect(
        f
          .coordinator({ execution: { ...f.execution, render } })
          .run(f.context, {}),
      ).rejects.toMatchObject({
        code:
          problem === 'mediaPending' || problem === 'pendingLinkChecks'
            ? 'BUILD_VALIDATION_INCOMPLETE'
            : 'INVALID_BUILD_REPORT',
      });
      await oldDist(f.root);
      await noSnapshot(f.root, f.id);
    },
  );
  it('waits for cancellation cleanup and leaves prior successful dist available', async () => {
    const f = await fixture();
    let closed = false;
    const render = async (options: Parameters<typeof f.render>[0]) => {
      f.controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(options.signal.aborted).toBe(true);
      closed = true;
      throw new Error('private worker failure must not escape');
    };
    await expect(
      f
        .coordinator({ execution: { ...f.execution, render } })
        .run(f.context, {}),
    ).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
    expect(closed).toBe(true);
    await oldDist(f.root);
    await noSnapshot(f.root, f.id);
  });
  it('enforces the overall deadline and does not misclassify it as user cancellation', async () => {
    const f = await fixture();
    const render = async (options: Parameters<typeof f.render>[0]) => {
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
      throw new Error('terminated');
    };
    await expect(
      f
        .coordinator({
          deadlineMs: 1000,
          execution: { ...f.execution, render },
        })
        .run(f.context, {}),
    ).rejects.toMatchObject({ code: 'BUILD_TIMEOUT' });
    await oldDist(f.root);
    await noSnapshot(f.root, f.id);
  });
  it('keeps durable success if cancellation arrives after artifact commit', async () => {
    const f = await fixture();
    const artifacts = new ArtifactStore({
      repositoryRoot: f.root,
      fault: (event) => {
        if (event.phase === 'artifact-committed') {
          f.controller.abort();
          throw new Error('notification failed');
        }
      },
    });
    const result = await f.coordinator({ artifacts }).run(f.context, {});
    expect((await artifacts.committedProof(f.id))?.result).toEqual(result);
    expect(await readFile(join(f.root, 'dist/index.html'), 'utf8')).toBe(
      'NEW_SUCCESS',
    );
  });
  it('preserves unknown preexisting job data and rejects reuse', async () => {
    const f = await fixture();
    await safeMkdir(f.root, `.foliohaven/builds/${f.id}/snapshot`);
    const path = join(
      f.root,
      `.foliohaven/builds/${f.id}/snapshot/unknown.txt`,
    );
    await writeFile(path, 'UNKNOWN_PRIVATE_VERSION');
    await expect(f.coordinator().run(f.context, {})).rejects.toMatchObject({
      code: 'BUILD_JOB_EXISTS',
    });
    expect(await readFile(path, 'utf8')).toBe('UNKNOWN_PRIVATE_VERSION');
    await oldDist(f.root);
  });
  it('does not expose arbitrary preparation failures and clears owned raw content', async () => {
    const f = await fixture();
    await expect(
      f
        .coordinator({
          execution: {
            ...f.execution,
            prepare: async () => {
              throw new Error('/private/path/token-value');
            },
          },
        })
        .run(f.context, {}),
    ).rejects.toMatchObject({
      code: 'BUILD_FAILED',
      message: '建置未完成，原有公開產物保持可用。',
    });
    await oldDist(f.root);
    await noSnapshot(f.root, f.id);
  });
});
