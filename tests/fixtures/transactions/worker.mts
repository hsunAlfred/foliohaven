import { FileRepository } from '../../../server/src/files/index.js';

const root = process.argv[2];
const mode = process.argv[3];
const phase = process.argv[4];
if (!root) throw new Error('fixture root required');
const keys = [
  'content/articles/example/content.html',
  'content/articles/example/meta.json',
];
const repository = new FileRepository({
  repositoryRoot: root,
  lockTimeoutMs: 5_000,
  fault: (event) => {
    if (event.phase === phase) process.exit(77);
  },
});
await repository.initialize();
if (mode === 'hold') {
  await repository.withConsistentRead(async () => {
    process.stdout.write('READY\n');
    process.stdin.resume();
    await new Promise<void>((resolve) => process.stdin.once('end', resolve));
  });
} else if (mode === 'commit') {
  const base = await repository.withConsistentRead(async (session) => ({
    etag: await session.etag(keys),
    revisions: await Promise.all(
      keys.map(async (key) => (await session.read(key))?.revision ?? null),
    ),
  }));
  await repository.commit({
    kind: 'save',
    precondition: { ifMatch: base.etag, resourceKeys: keys },
    changes: keys.map((resourceKey, index) => ({
      resourceKey,
      expectedRevision: base.revisions[index] ?? null,
      content: Buffer.from(
        index === 0 ? '<p>new</p>\n' : '{"status":"draft","title":"new"}\n',
      ),
    })),
  });
  process.stdout.write('COMMITTED\n');
} else if (mode === 'resolve') {
  const id = process.argv[5];
  const choice = process.argv[6];
  if (
    !id ||
    ![
      'keep-current',
      'restore-backup',
      'apply-prepared',
      'restore-trash',
      'purge-trash',
    ].includes(choice ?? '')
  )
    throw new Error('fixture resolution required');
  const detail = await repository.recovery(id);
  await repository.resolveRecovery(
    id,
    {
      choice: choice as 'restore-trash',
      revisions: detail.value.resources.map((item) => ({
        resourceKey: item.resourceKey,
        revision: item.current.revision,
      })),
    },
    detail.etag,
  );
  process.stdout.write('RESOLVED\n');
}
