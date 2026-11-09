import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compatibleEnvironment,
  isBuildSnapshotResource,
  privateDirectoryName,
  privateResource,
  pinPrivateDirectory,
} from '../../scripts/workspace-paths.mjs';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'foliohaven-private-root-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('private workspace root compatibility', () => {
  it('selects the new name without creating either directory during discovery', async () => {
    const root = await fixture();
    expect(privateDirectoryName(root)).toBe('.foliohaven');
    expect(privateResource(root, 'jobs/example.json')).toBe(
      '.foliohaven/jobs/example.json',
    );
    for (const name of ['.foliohaven', '.alfred'])
      await expect(lstat(join(root, name))).rejects.toMatchObject({
        code: 'ENOENT',
      });
  });

  it.each(['.foliohaven', '.alfred'] as const)(
    'uses the only existing %s directory',
    async (name) => {
      const root = await fixture();
      await mkdir(join(root, name), { mode: 0o700 });
      expect(privateDirectoryName(root)).toBe(name);
      expect(privateResource(root)).toBe(name);
      expect(privateResource(root, 'transactions/id/journal.json')).toBe(
        `${name}/transactions/id/journal.json`,
      );
    },
  );

  it('prefers the new directory and does not read, tighten or change the unused old directory', async () => {
    const root = await fixture();
    await mkdir(join(root, '.foliohaven'), { mode: 0o700 });
    await mkdir(join(root, '.alfred'), { mode: 0o755 });
    await writeFile(
      join(root, '.alfred/proof.bin'),
      Buffer.from([0, 255, 1, 17]),
    );
    await chmod(join(root, '.alfred'), 0o000);
    try {
      expect(privateDirectoryName(root)).toBe('.foliohaven');
      expect(privateResource(root, 'operations')).toBe(
        '.foliohaven/operations',
      );
      expect((await lstat(join(root, '.alfred'))).mode & 0o777).toBe(0);
    } finally {
      await chmod(join(root, '.alfred'), 0o700);
    }
    expect(await readFile(join(root, '.alfred/proof.bin'))).toEqual(
      Buffer.from([0, 255, 1, 17]),
    );
  });

  it.each(['symlink', 'file', 'permissions'] as const)(
    'does not fall back when the selected new root has invalid %s',
    async (kind) => {
      const root = await fixture();
      await mkdir(join(root, '.alfred'), { mode: 0o700 });
      if (kind === 'symlink')
        await symlink('.alfred', join(root, '.foliohaven'));
      else if (kind === 'file')
        await writeFile(join(root, '.foliohaven'), 'invalid');
      else {
        await mkdir(join(root, '.foliohaven'), { mode: 0o700 });
        await chmod(join(root, '.foliohaven'), 0o755);
      }
      expect(() => privateDirectoryName(root)).toThrow();
      expect((await lstat(join(root, '.alfred'))).mode & 0o777).toBe(0o700);
    },
  );

  it.each([
    '../outside',
    '/absolute',
    'jobs//id',
    'jobs/./id',
    'jobs\\id',
    'jobs/\u0000id',
  ])('rejects invalid private suffix %j', async (resource) => {
    expect(() => privateResource('/unused-workspace', resource)).toThrow();
  });

  it('allows snapshot destinations only below the selected root', async () => {
    const root = await fixture();
    const suffix = 'builds/12345678-1234-4123-8123-123456789abc/snapshot';
    expect(isBuildSnapshotResource(root, `.foliohaven/${suffix}`)).toBe(true);
    expect(isBuildSnapshotResource(root, `.alfred/${suffix}`)).toBe(false);
    await mkdir(join(root, '.alfred'), { mode: 0o700 });
    expect(isBuildSnapshotResource(root, `.alfred/${suffix}`)).toBe(true);
    await mkdir(join(root, '.foliohaven'), { mode: 0o700 });
    expect(isBuildSnapshotResource(root, `.alfred/${suffix}`)).toBe(false);
    expect(
      isBuildSnapshotResource(root, `.foliohaven/${suffix}/../snapshot`),
    ).toBe(false);
  });

  it('rejects root switches while nested leases are active and releases the choice afterward', async () => {
    const root = await fixture();
    await mkdir(join(root, '.alfred'), { mode: 0o700 });
    const releaseFirst = pinPrivateDirectory(root);
    const releaseSecond = pinPrivateDirectory(root);
    await mkdir(join(root, '.foliohaven'), { mode: 0o700 });
    try {
      expect(() => privateResource(root, 'jobs')).toThrow();
      releaseFirst();
      releaseFirst();
      expect(() => privateResource(root, 'jobs')).toThrow();
    } finally {
      releaseFirst();
      releaseSecond();
    }
    expect(privateResource(root, 'jobs')).toBe('.foliohaven/jobs');
  });
});

describe('environment aliases', () => {
  it.each([
    'RENDER_CONTEXT',
    'RENDER_OUTPUT',
    'SNAPSHOT_REVISION',
    'RELEASE_VERSION',
  ])(
    'handles new, old and absent %s names without changing the environment',
    (suffix) => {
      const name = `FOLIOHAVEN_${suffix}`;
      const old = `ALFRED_${suffix}`;
      expect(compatibleEnvironment(name, {})).toBeUndefined();
      expect(compatibleEnvironment(name, { [old]: 'old' })).toBe('old');
      const both = Object.freeze({ [name]: 'new', [old]: 'old' });
      expect(compatibleEnvironment(name, both)).toBe('new');
      expect(compatibleEnvironment(name, { [name]: '', [old]: 'old' })).toBe(
        '',
      );
    },
  );
});
