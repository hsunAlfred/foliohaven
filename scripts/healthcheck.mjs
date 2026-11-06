const probes = [
  ['Astro', 'http://127.0.0.1:4321/'],
  ['Studio', 'http://127.0.0.1:5173/'],
  ['Local Service', 'http://127.0.0.1:3001/api/v1/health'],
];
const release = process.argv[2] === '--release';
const studio = process.argv[2] === '--studio';
if (process.argv.length !== (release || studio ? 3 : 2)) {
  process.stderr.write(
    'HEALTH_ARGUMENT_INVALID：只接受--release或--studio。\n',
  );
  process.exit(1);
}
if (release) probes.push(['dist 預覽', 'http://127.0.0.1:4322/']);
if (studio) probes.splice(0, 1);
const results = await Promise.allSettled(
  probes.map(async ([name, url]) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(name);
  }),
);
for (const [index, result] of results.entries()) {
  if (result.status === 'rejected') {
    process.stderr.write(`${probes[index][0]}尚未就緒。\n`);
    process.exitCode = 1;
  }
}
