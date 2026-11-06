import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRepository } from '../../server/src/files/index.js';
import * as io from '../../server/src/files/io.js';
import type { Journal } from '../../server/src/transactions/journal.js';

const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0))
    await rm(root, { recursive: true, force: true });
});

const id = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function journal(
  index: number,
  createdAt = '2026-01-01T00:00:00.000Z',
): Journal {
  return {
    schemaVersion: 1,
    id: id(index),
    createdAt,
    status: 'committed',
    kind: 'save',
    generationAfter: 1,
    entries: [
      {
        resourceKey: 'content/site.json',
        oldRevision: null,
        newRevision: 'a'.repeat(64),
        byteSize: 1,
        installed: true,
        fileId: id(index + 100),
      },
    ],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-journal-reads-'));
  fixtures.push(root);
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  const add = async (value: Journal) => {
    const directory = join(root, '.alfred/transactions', value.id);
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, 'journal.json');
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  return { root, repository, add };
}

describe('parallel transaction journal reads', () => {
  it('keeps both preflight scans and skips directories without a journal', async () => {
    const { root, repository, add } = await fixture();
    const paths = await Promise.all([add(journal(1)), add(journal(2))]);
    const missing = join(root, '.alfred/transactions', id(3));
    await mkdir(missing, { mode: 0o700 });
    const read = vi.spyOn(io, 'readJson');
    await expect(
      repository.withConsistentRead(async () => 'read completed'),
    ).resolves.toBe('read completed');
    for (const path of [...paths, join(missing, 'journal.json')])
      expect(
        read.mock.calls.filter(([, key]) => join(root, key) === path),
      ).toHaveLength(2);
  });

  it('preserves recovery order by creation time and then transaction ID', async () => {
    const { repository, add } = await fixture();
    const values = [
      journal(1, '2026-01-02T00:00:00.000Z'),
      journal(3),
      journal(2),
    ];
    for (const value of values) value.status = 'prepared';
    const paths = await Promise.all(values.map(add));
    const writes: string[] = [];
    const original = io.atomicJson;
    vi.spyOn(io, 'atomicJson').mockImplementation(async (root, key, value) => {
      if (key.endsWith('/journal.json')) writes.push(key.split('/')[2] ?? '');
      return original(root, key, value);
    });
    await repository.withConsistentRead(async () => undefined);
    expect(writes).toEqual([id(2), id(3), id(1)]);
    for (const path of paths)
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        status: 'rolled-back',
      });
  });

  it.each([
    ['malformed JSON', 'RECOVERY_REQUIRED'],
    ['directory ID mismatch', 'RECOVERY_REQUIRED'],
    ['unmanaged resource', 'INVALID_RESOURCE_KEY'],
    ['invalid trash', 'INVALID_TRASH_RESOURCE'],
    ['journal symlink', 'RECOVERY_REQUIRED'],
    ['directory symlink', 'RECOVERY_REQUIRED'],
  ] as const)('still rejects %s', async (target, code) => {
    const { root, repository, add } = await fixture();
    const value = journal(1);
    if (target === 'directory ID mismatch') value.id = id(2);
    if (target === 'unmanaged resource') {
      const entry = value.entries[0];
      if (entry === undefined) throw new Error('Missing fixture journal entry');
      entry.resourceKey = '../outside';
    }
    if (target === 'invalid trash')
      value.trash = { kind: 'media', id: 'invalid' };
    const path = await add(value);
    if (target === 'malformed JSON') await writeFile(path, '{');
    if (target === 'directory ID mismatch') {
      const directory = join(root, '.alfred/transactions', id(1));
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'journal.json'), JSON.stringify(value));
    }
    if (target === 'journal symlink') {
      const preserved = join(root, 'preserved-journal.json');
      await writeFile(preserved, await readFile(path));
      await rm(path);
      await symlink(preserved, path);
    }
    if (target === 'directory symlink')
      await symlink(
        join(root, '.alfred/transactions', value.id),
        join(root, '.alfred/transactions', id(2)),
      );
    await expect(
      repository.withConsistentRead(async () => undefined),
    ).rejects.toMatchObject({ code });
  });
});
