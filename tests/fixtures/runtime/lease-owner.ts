import { acquireFileLease } from '../../../server/src/runtime/lease.js';

const root = process.argv[2];
if (!root) throw new Error('Missing isolated repository');
const lease = await acquireFileLease({
  root,
  name: 'crash-test',
  owner: 'lease-test',
});
if (!lease) throw new Error('Lease unavailable');
process.stdout.write('ready\n');
process.stdin.resume();
process.stdin.once('end', () => {
  void lease.release().then(() => process.exit(0));
});
