import { FileRepository } from '../../../server/src/files/index.js';
import { OperationStore } from '../../../server/src/operations/index.js';
const root = process.argv[2];
const key = process.argv[3];
const mode = process.argv[4];
if (!root || !key || !mode) throw new Error('fixture arguments missing');
const repository = new FileRepository({ repositoryRoot: root });
await repository.initialize();
const store = new OperationStore({ repositoryRoot: root, repository });
const reserved = await store.reserve({
  key,
  kind: 'article-create',
  payload: { title: 'fixture' },
});
if (reserved.status !== 'reserved')
  throw new Error('fixture requires fresh key');
if (mode === 'hold') {
  process.stdout.write(`READY ${reserved.reservation.id}\n`);
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once('end', resolve));
  await store.close();
} else if (mode === 'commit-crash') {
  const response = {
    httpStatus: 201,
    response: { id: 'created', contentHtml: '<p>fixture</p>' },
    resourceUrl: '/api/v1/articles/created',
    headers: { Location: '/api/v1/articles/created' },
  };
  await repository.commit({
    kind: 'create',
    changes: [
      {
        resourceKey: 'content/articles/created/content.html',
        expectedRevision: null,
        content: Buffer.from('<p>fixture</p>'),
      },
      {
        resourceKey: 'content/articles/created/meta.json',
        expectedRevision: null,
        content: Buffer.from('{"status":"draft"}'),
      },
    ],
    operation: store.receipt(reserved.reservation, response),
  });
  process.exit(77);
} else process.exit(77);
