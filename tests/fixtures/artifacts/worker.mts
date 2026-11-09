import { ArtifactStore } from '../../../server/src/build/artifacts/index.js';
import type { ArtifactFaultPhase } from '../../../server/src/build/artifacts/index.js';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

const [root, mode, id, phase = ''] = process.argv.slice(2);
if (!root || !mode || !id)
  throw new Error('Isolated artifact fixture arguments missing');
const store = new ArtifactStore({
  repositoryRoot: root,
  fault: async (event) => {
    if (mode === 'rename-failure' && event.phase === 'before-new-rename')
      await rename(
        join(root, `.foliohaven/builds/${id}/output`),
        join(root, `.foliohaven/builds/${id}/unavailable`),
      );
    if (event.phase === (phase as ArtifactFaultPhase)) process.exit(77);
  },
});
if (mode === 'prepare') {
  await store.preparePromotion(id, {
    snapshotRevision: 'a'.repeat(64),
    routeCount: 2,
  });
  process.exit(77);
} else if (mode === 'promote' || mode === 'rename-failure')
  await store.promote(id, { snapshotRevision: 'a'.repeat(64), routeCount: 2 });
else if (mode === 'resolve') {
  const detail = await store.recovery(id);
  await store.resolveRecovery(
    id,
    {
      choice: 'restore-backup',
      revisions: detail.value.resources.map((resource) => ({
        resourceKey: resource.resourceKey,
        revision: resource.current.revision,
      })),
    },
    detail.etag,
  );
} else if (mode === 'preview')
  await store.withPreviewGate(async () => {
    process.stdout.write('READY\n');
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve());
    });
  });
else throw new Error('Unknown isolated artifact fixture mode');
