// Runs without workspace dependencies to validate the real image bootstrap.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [mode, uidText, gidText, ...extra] = process.argv.slice(2);
assert.ok(['bootstrap', 'verify'].includes(mode) && extra.length === 0);
for (const value of [uidText, gidText])
  assert.ok(
    /^[1-9][0-9]{0,9}$/u.test(value ?? '') && Number(value) <= 2147483647,
  );
const uid = Number(uidText);
const gid = Number(gidText);
assert.equal(
  process.getuid?.(),
  uid,
  'The image node UID differs from the requested UID.',
);
assert.equal(
  process.getgid?.(),
  gid,
  'The image node GID differs from the requested GID.',
);
assert.notEqual(uid, 0);
const root = process.cwd();
assert.equal(root, '/workspaces/foliohaven');
const privateRoot = resolve(root, '.foliohaven');
const reportRoot = resolve(privateRoot, 'reports/release-uid-check');
const absent = (path) => assert.rejects(lstat(path), { code: 'ENOENT' });
const owned = async (path, permissions) => {
  const info = await lstat(path);
  assert.equal(
    info.isSymbolicLink(),
    false,
    'Acceptance paths cannot be symlinks.',
  );
  assert.equal(info.uid, uid, 'Wrong file owner.');
  assert.equal(info.gid, gid, 'Wrong file group.');
  if (permissions !== undefined) assert.equal(info.mode & 0o777, permissions);
  return info;
};
const json = async (name, value) => {
  await writeFile(resolve(reportRoot, name), JSON.stringify(value) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
};
await absent(resolve(root, '.git'));
await absent(resolve(root, '.alfred'));
await owned('/home/node/.local/share/pnpm/store');
await access(
  '/home/node/.local/share/pnpm/store',
  constants.R_OK | constants.W_OK,
);
await owned('/opt/playwright');

if (mode === 'bootstrap') {
  await absent(resolve(root, 'node_modules'));
  await absent(resolve(root, 'dist'));
  await absent(resolve(root, 'server/dist'));
  await absent(privateRoot);
  await mkdir(privateRoot, { mode: 0o700 });
  await mkdir(resolve(privateRoot, 'reports'), { mode: 0o700 });
  await mkdir(reportRoot, { mode: 0o700 });
  await writeFile(
    resolve(privateRoot, 'release-check-workspace.json'),
    JSON.stringify({ schemaVersion: 1, purpose: 'release-validation' }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  const { acquireFileLease } =
    await import('/opt/foliohaven-bootstrap/server/dist/runtime/lease.js');
  const options = {
    root,
    name: 'uid-bootstrap-check',
    owner: 'uid-check',
    nonBlocking: true,
  };
  const first = await acquireFileLease(options);
  assert.ok(first, 'Empty-dependency bootstrap must acquire a real flock.');
  try {
    const competing = await acquireFileLease(options);
    await competing?.release();
    assert.equal(
      competing,
      null,
      'The OS lease must reject a competing descriptor.',
    );
  } finally {
    await first.release();
  }
  const reopened = await acquireFileLease(options);
  assert.ok(reopened, 'The released bootstrap flock must be available again.');
  await reopened.release();
  await owned(privateRoot, 0o700);
  await owned(resolve(privateRoot, 'release-check-workspace.json'), 0o600);
  await json('bootstrap.json', {
    schemaVersion: 1,
    status: 'passed',
    uid,
    gid,
    emptyDependencies: true,
    emptyDist: true,
    realFlock: true,
    warmStoreWritable: true,
    browsersOwned: true,
  });
} else {
  await owned(privateRoot, 0o700);
  await owned(resolve(privateRoot, 'workspace-state.json'), 0o600);
  await owned(resolve(root, 'node_modules'));
  await owned(resolve(root, 'dist/index.html'));
  for (const name of ['prepare.json', 'verify.json']) {
    const report = JSON.parse(
      await readFile(
        resolve(privateRoot, 'reports/release-docker-check', name),
        'utf8',
      ),
    );
    assert.equal(report.environment.uid, uid);
    assert.equal(report.environment.gid, gid);
    assert.equal(report.articleSaved, true);
    assert.equal(report.mediaSaved, true);
    assert.equal(report.artifactUnchanged, true);
  }
  await json('identity.json', {
    schemaVersion: 1,
    status: 'passed',
    uid,
    gid,
    privateStateOwned: true,
    dependenciesOwned: true,
    savedArticleAndMedia: true,
    successfulBuildPreserved: true,
  });
}
console.log(
  JSON.stringify({ scope: 'docker-uid', mode, status: 'passed', uid, gid }),
);
