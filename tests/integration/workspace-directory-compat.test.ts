import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRepository } from '../../server/src/files/index.js';
import { ArtifactStore } from '../../server/src/build/artifacts/index.js';
import { privateDirectoryName } from '../../scripts/workspace-paths.mjs';
import { acquireFileLease } from '../../server/src/runtime/lease.js';
import { createLocalRuntime } from '../../server/src/runtime/services.js';
import { createLocalService } from '../../server/src/http/service.js';
import { JobManager } from '../../server/src/jobs/index.js';

const roots: string[] = [];
const scanInputs = async () => 'a'.repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'foliohaven-directory-compat-'));
  roots.push(root);
  return root;
}
async function seed(root: string, name: string, generation: number) {
  await mkdir(join(root, name), { mode: 0o700 });
  await writeFile(
    join(root, name, 'workspace-state.json'),
    JSON.stringify({
      schemaVersion: 1,
      editMode: 'ide',
      stateVersion: 7,
      generation,
    }),
    { mode: 0o600 },
  );
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('repository and artifacts use one selected private directory', () => {
  it('releases the runtime when starting the HTTP scheduler fails before listening', async () => {
    const root = await fixture();
    await seed(root, '.alfred', 8);
    const failure = new Error('controlled scheduler initialization failure');
    const start = vi
      .spyOn(JobManager.prototype, 'start')
      .mockImplementationOnce(() => {
        throw failure;
      });
    try {
      await expect(
        createLocalService({
          repositoryRoot: root,
          proxyToken: 'a'.repeat(64),
        }),
      ).rejects.toBe(failure);
    } finally {
      start.mockRestore();
    }
    await seed(root, '.foliohaven', 2);
    expect(privateDirectoryName(root)).toBe('.foliohaven');
  });
  it('keeps an idle runtime on its selected root until close, then permits a new session', async () => {
    const root = await fixture();
    await seed(root, '.alfred', 8);
    const runtime = await createLocalRuntime({ repositoryRoot: root });
    try {
      await seed(root, '.foliohaven', 2);
      await expect(
        runtime.repository.noteExternalChange(),
      ).rejects.toMatchObject({ code: 'PRIVATE_DIRECTORY_CHANGED' });
    } finally {
      await Promise.all([runtime.close(), runtime.close()]);
    }
    const reopened = await createLocalRuntime({ repositoryRoot: root });
    try {
      expect(await reopened.repository.initialize()).toMatchObject({
        generation: 2,
      });
    } finally {
      await reopened.close();
    }
  });

  it('releases the selected root when runtime initialization fails', async () => {
    const root = await fixture();
    await seed(root, '.alfred', 8);
    await writeFile(
      join(root, '.alfred/workspace-state.json'),
      'invalid fixture',
    );
    await expect(
      createLocalRuntime({ repositoryRoot: root }),
    ).rejects.toThrow();
    await seed(root, '.foliohaven', 2);
    const runtime = await createLocalRuntime({ repositoryRoot: root });
    await runtime.close();
    expect(privateDirectoryName(root)).toBe('.foliohaven');
  });
  it('stops a running writer when its selected directory changes and permits a later session', async () => {
    const root = await fixture();
    await seed(root, '.alfred', 8);
    const lease = await acquireFileLease({
      root,
      name: 'compat-session',
      owner: 'test',
    });
    expect(lease).not.toBeNull();
    try {
      await seed(root, '.foliohaven', 2);
      const repository = new FileRepository({ repositoryRoot: root });
      await expect(repository.noteExternalChange()).rejects.toMatchObject({
        code: 'PRIVATE_DIRECTORY_CHANGED',
      });
      expect(
        JSON.parse(
          await readFile(join(root, '.alfred/workspace-state.json'), 'utf8'),
        ).generation,
      ).toBe(8);
      expect(
        JSON.parse(
          await readFile(
            join(root, '.foliohaven/workspace-state.json'),
            'utf8',
          ),
        ).generation,
      ).toBe(2);
    } finally {
      await lease?.release();
    }
    expect(
      await new FileRepository({ repositoryRoot: root }).initialize(),
    ).toMatchObject({ generation: 2 });
  });
  it('cold-starts a new workspace under .foliohaven and preserves its state after reopening', async () => {
    const root = await fixture();
    const repository = new FileRepository({ repositoryRoot: root });
    expect(await repository.initialize()).toMatchObject({
      generation: 0,
      recoveryState: 'ready',
    });
    const state = await repository.workspace({ scanInputs });
    await repository.setEditMode('ide', state.etag, { scanInputs });
    await repository.noteExternalChange();
    const reopened = new FileRepository({ repositoryRoot: root });
    expect(await reopened.initialize()).toMatchObject({ generation: 1 });
    expect((await reopened.workspace({ scanInputs })).value.editMode).toBe(
      'ide',
    );
    expect(await readdir(root)).toEqual(['.foliohaven']);
  });

  it.each(['.alfred', '.foliohaven'])(
    'reads and writes the existing %s state without creating another root',
    async (name) => {
      const root = await fixture();
      await seed(root, name, 41);
      const repository = new FileRepository({ repositoryRoot: root });
      expect(await repository.initialize()).toMatchObject({ generation: 41 });
      const state = await repository.workspace({ scanInputs });
      expect(state.value.editMode).toBe('ide');
      await repository.setEditMode('studio', state.etag, { scanInputs });
      const artifacts = new ArtifactStore({ repositoryRoot: root });
      expect((await artifacts.current()).recoveryState).toBe('ready');
      expect(
        JSON.parse(
          await readFile(join(root, name, 'workspace-state.json'), 'utf8'),
        ),
      ).toMatchObject({
        generation: 41,
        editMode: 'studio',
        stateVersion: 8,
      });
      expect(await readdir(root)).toEqual([name]);
    },
  );

  it('uses only the new root when both exist, even if legacy recovery evidence is unreadable', async () => {
    const root = await fixture();
    await seed(root, '.alfred', 99);
    await seed(root, '.foliohaven', 3);
    await mkdir(join(root, '.alfred/transactions'), { mode: 0o700 });
    const legacyProof = Buffer.from(
      'do not parse, merge, fix or delete legacy recovery evidence',
    );
    await writeFile(
      join(root, '.alfred/transactions/unrecognized.json'),
      legacyProof,
      { mode: 0o600 },
    );
    const previousState = await readFile(
      join(root, '.alfred/workspace-state.json'),
    );
    const repository = new FileRepository({ repositoryRoot: root });
    expect(await repository.initialize()).toMatchObject({
      generation: 3,
      recoveryState: 'ready',
    });
    await repository.noteExternalChange();
    expect(privateDirectoryName(root)).toBe('.foliohaven');
    expect(await readFile(join(root, '.alfred/workspace-state.json'))).toEqual(
      previousState,
    );
    expect(
      await readFile(join(root, '.alfred/transactions/unrecognized.json')),
    ).toEqual(legacyProof);
    expect((await readdir(join(root, '.alfred'))).sort()).toEqual([
      'transactions',
      'workspace-state.json',
    ]);
    expect(
      JSON.parse(
        await readFile(join(root, '.foliohaven/workspace-state.json'), 'utf8'),
      ).generation,
    ).toBe(4);
  });
});
