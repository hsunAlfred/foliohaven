import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// Only Docker/package I/O is simulated. These cases prove orchestration and
// cleanup boundaries, never actual image identity or an actual Docker pass.
const stub = `#!${process.execPath}
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename,dirname} from 'node:path';
const args=process.argv.slice(2), command=basename(process.argv[1]);
appendFileSync(process.env.UID_TEST_COMMANDS,JSON.stringify({command,args})+'\\n');
if(command==='node') {
  if(args[0]?.endsWith('/scripts/package-release.mjs')) {
    const destination=args[args.indexOf('--directory')+1];
    mkdirSync(destination,{recursive:true});
    writeFileSync(destination+'/release-info.json',JSON.stringify({format:1,product:'foliohaven',version:'1.0.0',files:[]}));
    console.log(JSON.stringify({destination,version:'1.0.0',fileCount:1}));
    process.exit(0);
  }
  const result=spawnSync(process.env.UID_TEST_NODE,args,{stdio:'inherit'});
  process.exit(result.status??1);
}
if(command!=='docker')process.exit(90);
const statePath=process.env.UID_TEST_STATE;
const state=JSON.parse(readFileSync(statePath,'utf8'));
const mode=process.env.UID_TEST_MODE;
const save=()=>writeFileSync(statePath,JSON.stringify(state));
const option=name=>args[args.indexOf(name)+1];
const container=id=>state.containers[id];
const target=args.at(-1);
if(args[0]==='image'&&args[1]==='inspect') {
  if(mode==='image-missing')process.exit(1);
  console.log('sha256:'+'f'.repeat(64));
} else if(args[0]==='volume') {
  if(args[1]==='inspect') {
    if(!state.volume)process.exit(1);
    if(args.includes('--format'))console.log(state.label);
    else console.log('{}');
  } else if(args[1]==='create') {
    state.volume=target;state.label=option('--label').split('=').slice(1).join('=');
    if(mode==='volume-owner-conflict')state.label='another-owner';
    save();console.log(target);
  } else if(args[1]==='rm') {
    if(Object.values(state.containers).some(x=>!x.removed))process.exit(19);
    state.volume=null;save();console.log(target);
  } else process.exit(91);
} else if(args[0]==='run') {
  if(args.includes('--detach')) {
    const id=(state.next++===0?'a':'b').repeat(64);
    state.containers[id]={label:option('--label').split('=').slice(1).join('='),running:true,removed:false};
    save();console.log(id);
  } else {
    if(args.includes('--interactive'))for await(const chunk of process.stdin)void chunk;
    if(args.includes('bootstrap')&&mode==='wrong-image-identity')process.exit(23);
  }
} else if(args[0]==='inspect') {
  const c=container(target);if(!c||c.removed)process.exit(1);
  const format=option('--format');
  if(format.includes('Labels'))console.log(mode==='container-owner-conflict'?'another-owner':c.label);
  else if(format.includes('ExitCode'))console.log(mode==='bad-shutdown'?'7':'0');
  else console.log(mode==='not-healthy'?'false starting':'true healthy');
} else if(args[0]==='exec') {
  if(args.includes('prepare')&&mode==='prepare-failed')process.exit(67);
  if(args.includes('verify')&&mode==='verify-failed')process.exit(68);
} else if(args[0]==='stop') {
  const c=container(target);if(!c)process.exit(1);c.running=false;save();console.log(target);
} else if(args[0]==='rm') {
  const c=container(target);if(!c)process.exit(1);c.removed=true;save();console.log(target);
} else if(args[0]==='logs') {
  console.log('isolated fake acceptance container');
} else if(args[0]==='cp') {
  const name=basename(args[1]),destination=args[2];
  mkdirSync(dirname(destination),{recursive:true});
  const uid=Number(process.env.UID_TEST_EXPECTED_UID),gid=Number(process.env.UID_TEST_EXPECTED_GID);
  const common={schemaVersion:1,status:'passed',uid,gid};
  const value=name==='bootstrap.json'?{...common,emptyDependencies:true,emptyDist:true,realFlock:true,warmStoreWritable:true,browsersOwned:true}:name==='identity.json'?{...common,privateStateOwned:true,dependenciesOwned:true,savedArticleAndMedia:true,successfulBuildPreserved:mode!=='bad-evidence'}:{scope:'docker',mode:name==='prepare.json'?'prepare':'verify',environment:{uid,gid},articleSaved:true,mediaSaved:true,artifactUnchanged:true};
  writeFileSync(destination,JSON.stringify(value));
} else process.exit(92);
`;

interface Command {
  command: string;
  args: string[];
}
interface Result {
  status: string;
  exitCode: number;
  uid: number;
  gid: number;
  imageId: string;
  publicSourceDigest: string;
  network: string;
  hostPortsPublished: boolean;
  firstContainer: string;
  restartedContainer: string;
  checks?: Record<string, boolean>;
  errorCode?: string;
  steps: { phase: string; status: string }[];
}

async function run(mode = 'success', uid = '2000', gid = '2001') {
  const root = await mkdtemp(join(tmpdir(), 'foliohaven-uid-script-'));
  roots.push(root);
  const source = join(root, 'source');
  const bin = join(root, 'bin');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await mkdir(bin);
  await mkdir(join(root, 'tmp'));
  for (const name of ['check-release-uids.sh', 'workspace-paths.mjs'])
    await copyFile(
      new URL(`../../scripts/${name}`, import.meta.url),
      join(source, 'scripts', name),
    );
  const stubPath = join(root, 'stub.mjs');
  await writeFile(stubPath, stub, { mode: 0o700 });
  for (const command of ['docker', 'node'])
    await symlink(stubPath, join(bin, command));
  const statePath = join(root, 'docker-state.json');
  const commandsPath = join(root, 'commands.jsonl');
  await writeFile(statePath, JSON.stringify({ containers: {}, next: 0 }));
  let code = 0;
  let output: string;
  try {
    const result = await execute(
      'bash',
      [
        join(source, 'scripts/check-release-uids.sh'),
        '--uid',
        uid,
        '--gid',
        gid,
        '--image',
        'foliohaven-uid:test',
      ],
      {
        cwd: source,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          TMPDIR: join(root, 'tmp'),
          UID_TEST_COMMANDS: commandsPath,
          UID_TEST_STATE: statePath,
          UID_TEST_MODE: mode,
          UID_TEST_NODE: process.execPath,
          UID_TEST_EXPECTED_UID: uid,
          UID_TEST_EXPECTED_GID: gid,
        },
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    output = result.stdout + result.stderr;
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    code = failure.code;
    output = failure.stdout + failure.stderr;
  }
  const commands = await readFile(commandsPath, 'utf8').then(
    (text) =>
      text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Command),
    () => [],
  );
  const pointer = join(
    source,
    '.foliohaven/reports/release-uid-check',
    `latest-${uid}-${gid}.json`,
  );
  const selected = await readFile(pointer, 'utf8').then(
    (text) => JSON.parse(text) as { reportPath: string },
    () => null,
  );
  const result = selected
    ? (JSON.parse(await readFile(selected.reportPath, 'utf8')) as Result)
    : null;
  return {
    root,
    source,
    code,
    output,
    commands,
    result,
    pointer,
    reportPath: selected?.reportPath,
    state: JSON.parse(await readFile(statePath, 'utf8')) as {
      volume?: string | null;
      containers: Record<string, { removed: boolean }>;
    },
  };
}

describe('isolated release UID acceptance orchestration', () => {
  it.each([
    ['1000', '1000'],
    ['1001', '1001'],
    ['2000', '2001'],
  ])(
    'checks %s:%s with no host bind or published ports and removes only its own resources',
    async (uid, gid) => {
      const f = await run('success', uid, gid);
      expect(f.code, f.output).toBe(0);
      expect(f.result).toMatchObject({
        status: 'passed',
        exitCode: 0,
        uid: Number(uid),
        gid: Number(gid),
        network: 'none',
        hostPortsPublished: false,
      });
      expect(
        f.result?.checks && Object.values(f.result.checks).every(Boolean),
      ).toBe(true);
      expect(f.result?.steps.map((x) => x.phase)).toEqual([
        'image',
        'source',
        'volume',
        'seed',
        'bootstrap',
        'first-start',
        'author-save-build',
        'first-stop',
        'restart',
        'preserved',
        'cleanup',
      ]);
      expect(f.result?.publicSourceDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(f.result?.firstContainer).not.toBe(f.result?.restartedContainer);
      const runs = f.commands.filter(
        (x) => x.command === 'docker' && x.args[0] === 'run',
      );
      expect(runs).toHaveLength(5);
      for (const { args } of runs) {
        expect(args).toContain('--pull=never');
        expect(args[args.indexOf('--network') + 1]).toBe('none');
        expect(args).not.toContain('--publish');
        expect(args).not.toContain('-p');
        const mount = args[args.indexOf('--mount') + 1];
        expect(mount).toMatch(/^type=volume,source=foliohaven-release-uid\./u);
        expect(mount).toContain('volume-nocopy');
        expect(mount).not.toContain('type=bind');
      }
      const rootRun = runs.filter(
        (x) => x.args[x.args.indexOf('--user') + 1] === '0:0',
      );
      expect(rootRun).toHaveLength(1);
      expect(rootRun[0]?.args.join(' ')).toContain('chownSync(p,');
      expect(rootRun[0]?.args.join(' ')).not.toContain('recursive');
      expect(
        f.commands.some((x) => x.command === 'docker' && x.args[0] === 'build'),
      ).toBe(false);
      expect(
        f.commands.some(
          (x) => x.command === 'docker' && x.args.includes('--force'),
        ),
      ).toBe(false);
      expect(f.state.volume).toBeNull();
      expect(Object.values(f.state.containers).every((x) => x.removed)).toBe(
        true,
      );
      expect((await lstat(f.pointer)).mode & 0o777).toBe(0o600);
      if (!f.reportPath) throw new Error('The UID result report is missing.');
      expect((await lstat(f.reportPath)).mode & 0o777).toBe(0o600);
      expect(f.output).toContain('"reportPath":');
    },
  );
  it.each([
    'image-missing',
    'wrong-image-identity',
    'not-healthy',
    'prepare-failed',
    'verify-failed',
    'bad-shutdown',
    'bad-evidence',
  ])(
    'records %s as a failure instead of reporting a UID pass',
    async (mode) => {
      const f = await run(mode);
      expect(f.code, f.output).not.toBe(0);
      expect(f.result?.status).toBe('failed');
      if (mode === 'bad-evidence')
        expect(f.result?.errorCode).toBe('UID_ACCEPTANCE_EVIDENCE_INVALID');
    },
  );
  it.each(['volume-owner-conflict', 'container-owner-conflict'])(
    'does not remove unproven %s resources',
    async (mode) => {
      const f = await run(mode);
      expect(f.code, f.output).not.toBe(0);
      expect(f.result?.status).toBe('failed');
      if (mode === 'volume-owner-conflict')
        expect(
          f.commands.some(
            (x) =>
              x.command === 'docker' &&
              x.args[0] === 'volume' &&
              x.args[1] === 'rm',
          ),
        ).toBe(false);
      else
        expect(
          f.commands.some(
            (x) =>
              x.command === 'docker' &&
              ['stop', 'rm'].includes(x.args[0] ?? ''),
          ),
        ).toBe(false);
    },
  );
  it.each([
    ['0', '1000'],
    ['1000', '0'],
    ['2147483648', '1000'],
    ['-1', '1000'],
    ['1000', 'bad'],
  ])(
    'rejects invalid IDs %s:%s before any Docker command',
    async (uid, gid) => {
      const f = await run('success', uid, gid);
      expect(f.code).not.toBe(0);
      expect(f.commands).toEqual([]);
      expect(f.result).toBeNull();
    },
  );
});

it('keeps OS layers UID-neutral, creates heavy state after final identity and preserves matching Compose build args', async () => {
  const dockerfile = await readFile(
    new URL('../../Dockerfile', import.meta.url),
    'utf8',
  );
  const os = dockerfile.split('FROM os-toolchain AS toolchain')[0] ?? '';
  const identity =
    dockerfile
      .split('FROM os-toolchain AS toolchain')[1]
      ?.split('FROM toolchain AS dependencies')[0] ?? '';
  expect(os).toContain('apt-get install');
  expect(os).not.toMatch(
    /LOCAL_UID|LOCAL_GID|pnpm install --frozen|playwright install/u,
  );
  expect(identity).toContain('ARG LOCAL_UID=1000');
  expect(identity).toContain('ARG LOCAL_GID=1000');
  expect(identity.indexOf('usermod')).toBeLessThan(
    identity.indexOf('install -d'),
  );
  expect(dockerfile).not.toMatch(/chown\s+-[^\n]*R/u);
  expect(dockerfile).toContain(
    'RUN pnpm install --frozen-lockfile --prod=false',
  );
  expect(dockerfile).toContain(
    'RUN pnpm exec playwright install chromium firefox webkit',
  );
  const site = createRequire(
    new URL('../../site/package.json', import.meta.url),
  );
  const yaml = createRequire(site.resolve('astro/package.json'))('yaml') as {
    parse(input: string, options: { merge: boolean }): unknown;
  };
  const compose = yaml.parse(
    await readFile(
      new URL('../../docker-compose.yml', import.meta.url),
      'utf8',
    ),
    { merge: true },
  );
  for (const service of ['app', 'repair', 'dev'])
    expect(compose).toMatchObject({
      services: {
        [service]: {
          build: {
            args: {
              LOCAL_UID: '${LOCAL_UID:-1000}',
              LOCAL_GID: '${LOCAL_GID:-1000}',
            },
          },
        },
      },
    });
});

it('reconstructs canonical Dev Container files only from the public template with matching bytes and modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foliohaven-devcontainer-image-'));
  roots.push(root);
  const personal = join(root, 'producer', '.devcontainer');
  const context = join(root, 'context');
  const template = join(context, 'release', 'templates', 'devcontainer');
  await mkdir(personal, { recursive: true });
  await writeFile(
    join(personal, 'private-editor-marker.json'),
    JSON.stringify({ purpose: 'isolated-test-only', personalMount: true }),
    { mode: 0o600 },
  );
  await mkdir(join(context, 'release', 'templates'), { recursive: true });
  await cp(
    new URL('../../release/templates/devcontainer', import.meta.url),
    template,
    { recursive: true },
  );

  const dockerfile = await readFile(
    new URL('../../Dockerfile', import.meta.url),
    'utf8',
  );
  const dev =
    dockerfile
      .split('FROM browser-toolchain AS dev')[1]
      ?.split('FROM dev AS verify')[0] ?? '';
  const hydration = 'cp -a release/templates/devcontainer/. .devcontainer/';
  expect(dev).toContain(hydration);
  expect(dev.indexOf(hydration)).toBeLessThan(
    dev.indexOf('pnpm run check:compiler'),
  );
  expect(
    (
      await readFile(new URL('../../.dockerignore', import.meta.url), 'utf8')
    ).split('\n'),
  ).toContain('.devcontainer');

  await execute('bash', ['-euc', `mkdir -p .devcontainer\n${hydration}`], {
    cwd: context,
  });
  const expected = (await readdir(template)).sort();
  expect(expected).toEqual([
    'check-environment.sh',
    'devcontainer.json',
    'docker-compose.yml',
  ]);
  const destination = join(context, '.devcontainer');
  expect((await readdir(destination)).sort()).toEqual(expected);
  for (const name of expected) {
    expect(await readFile(join(destination, name))).toEqual(
      await readFile(join(template, name)),
    );
    expect((await lstat(join(destination, name))).mode & 0o777).toBe(
      (await lstat(join(template, name))).mode & 0o777,
    );
  }
  expect(await readdir(personal)).toEqual(['private-editor-marker.json']);
  expect(
    JSON.parse(
      await readFile(join(personal, 'private-editor-marker.json'), 'utf8'),
    ),
  ).toEqual({
    purpose: 'isolated-test-only',
    personalMount: true,
  });
});
