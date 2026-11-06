import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRepository } from '../../server/src/files/index.js';
import { scanBuildInputs } from '../../server/src/build/inputs.js';

const fixtures: string[] = [];
const revision = 'a'.repeat(64);
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-workspace-cancel-'));
  fixtures.push(root);
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  return { root, repository };
}
afterEach(async () => {
  for (const root of fixtures.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('workspace request cancellation', () => {
  it('does not scan an already cancelled workspace and leaves the writer lock available', async () => {
    const { repository } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const scanInputs = vi.fn(async () => revision);
    await expect(
      repository.workspace({ scanInputs, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(scanInputs).not.toHaveBeenCalled();
    await expect(repository.workspace({ scanInputs })).resolves.toMatchObject({
      value: { revision },
    });
    expect(scanInputs).toHaveBeenCalledOnce();
  });

  it('skips a cancelled request after the preceding reader releases its queue and lock', async () => {
    const { root, repository } = await fixture();
    const entered = deferred();
    const release = deferred();
    const holding = repository.withConsistentRead(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const scanInputs = vi.fn(async () => revision);
    const cancelled = repository.workspace({
      scanInputs,
      signal: controller.signal,
    });
    const rejected = expect(cancelled).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
    });
    try {
      controller.abort();
      expect(scanInputs).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await holding;
    }
    await rejected;
    expect(scanInputs).not.toHaveBeenCalled();
    // A second instance also needs the real cross-process writer lease.
    const following = new FileRepository({ repositoryRoot: root });
    await expect(following.workspace({ scanInputs })).resolves.toMatchObject({
      value: { revision },
    });
    expect(scanInputs).toHaveBeenCalledOnce();
  });

  it('releases the queue and writer lock when an active workspace forwards cancellation to its byte scanner', async () => {
    const { root, repository } = await fixture();
    for (const path of [
      'content',
      'media/source',
      'packages/core',
      'packages/ui',
      'site',
      'studio',
      'server',
      'scripts',
    ])
      await mkdir(join(root, path), { recursive: true });
    for (const path of [
      '.node-version',
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
    ])
      await writeFile(join(root, path), 'isolated workspace fixture\n');
    const controller = new AbortController();
    const entered = deferred();
    const continueScan = deferred();
    const scanInputs = async () => {
      entered.resolve();
      await continueScan.promise;
      return (await scanBuildInputs(root, { signal: controller.signal }))
        .revision;
    };
    const scanning = repository.workspace({
      scanInputs,
      signal: controller.signal,
    });
    const rejected = expect(scanning).rejects.toMatchObject({
      code: 'BUILD_CANCELLED',
    });
    await entered.promise;
    controller.abort();
    continueScan.resolve();
    await rejected;
    const following = new FileRepository({ repositoryRoot: root });
    const result = await following.workspace({
      scanInputs: async () => (await scanBuildInputs(root)).revision,
    });
    expect(result.value.revision).toMatch(/^[a-f0-9]{64}$/u);
  });
});
