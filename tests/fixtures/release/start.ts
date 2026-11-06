import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runControlledProcess } from '../../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../../server/src/runtime/environment.js';
import { withReservedPorts } from '../ports.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
export interface StartCase {
  readonly artifact?:
    'fresh' | 'ready' | 'unknown' | 'recovery' | 'bad-preview';
  readonly failAt?: 'install' | 'packages' | 'server' | 'build';
  readonly blockInstall?: boolean;
}
/** Real OS processes, locks and sockets; package/SSG work is a bounded fixture. */
export async function releaseStartFixture(initial: StartCase = {}) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-release-start-'));
  try {
    const ports = await withReservedPorts(async (reserve) => ({
      site: await reserve(),
      studio: await reserve(),
      preview: await reserve(),
      api: await reserve(),
    }));
    if (new Set(Object.values(ports)).size !== 4)
      throw new Error('PORTS_REUSED');
    for (const path of [
      'content',
      'media/source',
      'packages/core',
      'packages/ui',
      'site',
      'studio',
      'server/dist/runtime',
      'server/dist/files',
      'scripts',
      '.bin',
    ])
      await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, '.node-version'), '26.12.1\n');
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', version: '0.1.0' }),
    );
    await writeFile(
      join(root, 'content/author.txt'),
      'author bytes must survive\n',
    );
    for (const name of ['runtime/lease.js', 'files/io.js'])
      await cp(
        join(repository, 'server/dist', name),
        join(root, 'server/dist', name),
      );
    const portMap: Readonly<Record<string, number>> = {
      '4321': ports.site,
      '5173': ports.studio,
      '4322': ports.preview,
      '3001': ports.api,
    };
    const start = (
      await readFile(join(repository, 'scripts/start.mjs'), 'utf8')
    ).replace(/4321|5173|4322|3001/gu, (original) => String(portMap[original]));
    await writeFile(join(root, 'scripts/start.mjs'), start);
    await writeFile(
      join(root, 'scripts/healthcheck.mjs'),
      (
        await readFile(join(repository, 'scripts/healthcheck.mjs'), 'utf8')
      ).replace(/4321|5173|4322|3001/gu, (original) =>
        String(portMap[original]),
      ),
    );
    await cp(
      join(repository, 'scripts/managed-process.mjs'),
      join(root, 'scripts/managed-process.mjs'),
    );
    await writeFile(join(root, 'fixture.json'), JSON.stringify(initial));
    await writeFile(
      join(root, '.bin/pnpm'),
      `#!${process.execPath}
import fs from 'node:fs/promises';
import path from 'node:path';
(async () => {
const root = process.cwd();
const {acquireFileLease} = await import('../server/dist/runtime/lease.js');
const probe = await acquireFileLease({root,name:'dev-session',owner:'fixture-probe',nonBlocking:true});
const held = probe === null;
await probe?.release();
const args = process.argv.slice(2);
await fs.appendFile('commands.jsonl', JSON.stringify({args,held})+'\\n');
const options = JSON.parse(await fs.readFile('fixture.json','utf8'));
const step = args[0] === 'install' ? 'install' : args[1] === 'build:packages' ? 'packages' : 'server';
if (options.failAt === step) process.exit(23);
if(step==='install'&&options.blockInstall){process.stdout.write('INSTALL_BLOCKED\\n');setInterval(()=>undefined,1000);return;}
if(step==='install') {
 await fs.mkdir('node_modules/@foliohaven',{recursive:true});
 await fs.symlink(path.join(root,'server'),'node_modules/@foliohaven/server','dir');
 await fs.mkdir('node_modules/tsx',{recursive:true});
 await fs.writeFile('node_modules/tsx/package.json',JSON.stringify({type:'module',exports:'./index.mjs'}));
 await fs.writeFile('node_modules/tsx/index.mjs','');
}
})();
`,
    );
    await chmod(join(root, '.bin/pnpm'), 0o755);
    await writeFile(
      join(root, 'server/package.json'),
      JSON.stringify({
        name: '@foliohaven/server',
        type: 'module',
        exports: './dist/index.js',
      }),
    );
    await writeFile(
      join(root, 'server/dist/index.js'),
      `
import{readFile,appendFile}from'node:fs/promises';
async function state(){return JSON.parse(await readFile('fixture.json','utf8'));}
export class ArtifactStore {
 async current(){const s=await state();await appendFile('artifact-checks.jsonl','current\\n');return {recoveryState:s.artifact==='recovery'?'recovery-required':'ready',current:!s.artifact||s.artifact==='fresh'?null:{digest:'fixture',build:s.artifact==='unknown'?null:{jobId:'proof'}}};}
 async withPreviewGate(fn){await appendFile('artifact-checks.jsonl','preview\\n');if((await state()).artifact==='bad-preview')throw new Error('fixture rejected');return fn({digest:'fixture'});}
}
`,
    );
    await writeFile(
      join(root, 'scripts/build.mjs'),
      `
import{readFile,writeFile,appendFile}from'node:fs/promises';
await appendFile('commands.jsonl',JSON.stringify({args:['formal-build']})+'\\n');
if(JSON.parse(await readFile('fixture.json','utf8')).failAt==='build')process.exit(24);
await writeFile('built.txt','formal artifact');
`,
    );
    await writeFile(
      join(root, 'scripts/dev.mjs'),
      `
import{createServer}from'node:http';import{writeFile}from'node:fs/promises';
import{acquireFileLease}from'../server/dist/runtime/lease.js';
const root=process.cwd();const lease=await acquireFileLease({root,name:'dev-session',owner:'fixture-dev',nonBlocking:true});
if(!lease)process.exit(25);
const repair=process.argv[2]==='studio';const host=process.argv[3]==='--container'?'0.0.0.0':'127.0.0.1';
const servers=[];for(const[port,bind]of[...(!repair?[[${ports.site},host]]:[]),[${ports.studio},host],[${ports.api},'127.0.0.1']]){const server=createServer((_q,r)=>r.end('ready'));await new Promise(resolve=>server.listen(port,bind,resolve));servers.push(server);}
await writeFile('dev-started.json',JSON.stringify({repair,host,api:'127.0.0.1',pid:process.pid}));
const stop=async()=>{await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));await lease.release();await writeFile('dev-stopped.txt','closed');};process.once('SIGTERM',stop);process.once('SIGINT',stop);
`,
    );
    await writeFile(
      join(root, 'scripts/preview.mjs'),
      `
import{createServer}from'node:http';import{writeFile}from'node:fs/promises';
const host=process.argv[2]==='--container'?'0.0.0.0':'127.0.0.1';
const server=createServer((_q,r)=>r.end('artifact'));await new Promise(resolve=>server.listen(${ports.preview},host,resolve));
await writeFile('preview-started.txt',host);
const stop=()=>server.close(()=>void writeFile('preview-stopped.txt','closed'));process.once('SIGTERM',stop);process.once('SIGINT',stop);
`,
    );
    return {
      root,
      ports,
      async set(options: StartCase) {
        await writeFile(join(root, 'fixture.json'), JSON.stringify(options));
      },
      execute(
        args: readonly string[] = [],
        options: {
          signal?: AbortSignal;
          onOutput?: (text: string) => void;
          env?: Readonly<Record<string, string>>;
        } = {},
      ) {
        return runControlledProcess({
          command: process.execPath,
          args: ['scripts/start.mjs', ...args],
          cwd: root,
          env: buildProcessEnvironment({
            PATH: `${join(root, '.bin')}:${process.env.PATH ?? ''}`,
            ...options.env,
          }),
          timeoutMs: 30_000,
          ...(options.signal ? { signal: options.signal } : {}),
          onOutput: (_stream, bytes) =>
            options.onOutput?.(bytes.toString('utf8')),
        });
      },
      health(args: readonly string[]) {
        return runControlledProcess({
          command: process.execPath,
          args: ['scripts/healthcheck.mjs', ...args],
          cwd: root,
          env: buildProcessEnvironment(),
          timeoutMs: 10_000,
        });
      },
      async commands() {
        try {
          return (await readFile(join(root, 'commands.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(
              (line) => JSON.parse(line) as { args: string[]; held?: boolean },
            );
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return [];
          throw error;
        }
      },
      async cleanup() {
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
