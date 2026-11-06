import { afterEach, describe, expect, it } from 'vitest';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../server/src/runtime/environment.js';
import { FileRepository } from '../../server/src/files/repository.js';
import { createLocalService } from '../../server/src/http/service.js';
import { RecoveryDetailSchema } from '@foliohaven/core';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(kind: string) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-render-diagnostic-'));
  roots.push(root);
  for (const path of [
    'scripts',
    'content',
    'media/source',
    'site/dist/registry',
    'site/src/pages',
    'packages/core/dist',
    'server/dist/build/render',
    'node_modules/@foliohaven/server',
  ])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module' }),
  );
  await cp(
    join(repository, 'scripts/render-dev.mjs'),
    join(root, 'scripts/render-dev.mjs'),
  );
  const module = join(root, 'node_modules/@foliohaven/server');
  await writeFile(
    join(module, 'package.json'),
    JSON.stringify({ type: 'module', exports: './index.mjs' }),
  );
  await writeFile(join(root, 'kind.txt'), kind);
  await writeFile(
    join(module, 'index.mjs'),
    `
import{readFile,writeFile}from'node:fs/promises';
export{runControlledProcess}from ${JSON.stringify(join(repository, 'server/dist/runtime/process.js'))};
export{buildProcessEnvironment}from ${JSON.stringify(join(repository, 'server/dist/runtime/environment.js'))};
import{RepositoryError}from ${JSON.stringify(join(repository, 'server/dist/files/io.js'))};
export{RepositoryError};
export class RenderError extends RepositoryError{constructor(code,message){super(code,message);this.status=422;}}
let attempts=0;
export async function prepareRenderContext(options){
 const kind=await readFile('kind.txt','utf8');
 if(kind==='busy'||kind==='busy-crash'){if(kind==='busy-crash'&&attempts++>0)process.exit(9);throw new RepositoryError('WORKSPACE_BUSY','PRIVATE_BUSY /private/should-not-appear');}
 if(kind==='cancel')return new Promise((resolve,reject)=>{const stop=()=>reject(new RenderError('BUILD_CANCELLED','PRIVATE_BODY /private/should-not-appear'));if(options.signal.aborted)stop();else options.signal.addEventListener('abort',stop,{once:true});});
 if(kind==='watch')process.stderr.write('PRIVATE_NATIVE_OUTPUT /private/should-not-appear\\n');
 if(kind==='generic')throw new Error('PRIVATE_BODY /private/should-not-appear');
 throw new RenderError('INVALID_JSON','PRIVATE_BODY /private/should-not-appear');
}
export async function invalidateRenderContext(){if((await readFile('kind.txt','utf8'))==='invalidation')throw Object.assign(new Error('PRIVATE_INVALIDATE_PATH'),{code:'EACCES'});await writeFile('invalidated.txt','invalid');}
`,
  );
  return {
    root,
    run: (
      args: readonly string[],
      signal?: AbortSignal,
      onOutput?: (text: string) => void,
    ) =>
      runControlledProcess({
        command: process.execPath,
        args: ['scripts/render-dev.mjs', ...args],
        cwd: root,
        env: buildProcessEnvironment(),
        timeoutMs: 15_000,
        ...(signal ? { signal } : {}),
        onOutput: (_stream, bytes) => onOutput?.(bytes.toString('utf8')),
      }),
  };
}
interface Event {
  event: string;
  code: string;
  phase: string;
  cancelled: boolean;
  at: string;
  waiting?: true;
  retryExhausted?: true;
}
function events(output: string): Event[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);
}
function safe(output: string) {
  expect(output).not.toMatch(/PRIVATE_|\/private\/|should-not-appear|stack/);
  for (const event of events(output)) {
    expect(Object.keys(event)).toEqual([
      'event',
      'code',
      'phase',
      'cancelled',
      'at',
      ...(event.waiting ? ['waiting'] : []),
      ...(event.retryExhausted ? ['retryExhausted'] : []),
    ]);
    expect(event.event).toBe('dev-render-diagnostic');
    expect(Number.isFinite(Date.parse(event.at))).toBe(true);
  }
}

describe('safe render child diagnostics and cancellation', () => {
  it.each([
    { kind: 'source', code: 'INVALID_JSON', count: 1 },
    { kind: 'generic', code: 'RENDER_PREPARE_FAILED', count: 1 },
    { kind: 'invalidation', code: 'INVALID_JSON', count: 2 },
  ])(
    'one-shot $kind failure reports only safe code and phase',
    async ({ kind, code, count }) => {
      const f = await fixture(kind);
      const output: string[] = [];
      await expect(
        f.run(['--once'], undefined, (text) => output.push(text)),
      ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
      const text = output.join('');
      safe(text);
      expect(events(text)).toHaveLength(count);
      expect(events(text)[0]).toMatchObject({
        code,
        phase: 'prepare',
        cancelled: false,
      });
      if (kind === 'invalidation')
        expect(events(text)[1]).toMatchObject({
          code: 'EACCES',
          phase: 'invalidate',
          cancelled: false,
        });
      else
        expect(await readFile(join(f.root, 'invalidated.txt'), 'utf8')).toBe(
          'invalid',
        );
    },
  );
  it('an explicit parent-pipe cancellation does not publish an invalid marker', async () => {
    const f = await fixture('cancel');
    const output: string[] = [];
    await expect(
      f.run(['--once', '--parent-pipe'], undefined, (text) =>
        output.push(text),
      ),
    ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
    const text = output.join('');
    safe(text);
    expect(events(text)).toHaveLength(1);
    expect(events(text)[0]).toMatchObject({
      code: 'BUILD_CANCELLED',
      phase: 'prepare',
      cancelled: true,
    });
    await expect(
      readFile(join(f.root, 'invalidated.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('watcher forwards structured child and process codes while discarding native stderr', async () => {
    const f = await fixture('watch');
    const controller = new AbortController();
    const output: string[] = [];
    let reported: () => void = () => undefined;
    const observed = new Promise<void>((resolve) => {
      reported = resolve;
    });
    const running = f.run([], controller.signal, (text) => {
      output.push(text);
      if (text.includes('"phase":"process"')) reported();
    });
    try {
      await Promise.race([
        observed,
        running.then(() => {
          throw new Error('WATCH_EXITED');
        }),
      ]);
      const text = output.join('');
      safe(text);
      expect(events(text)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'INVALID_JSON',
            phase: 'prepare',
            cancelled: false,
          }),
          expect.objectContaining({
            code: 'PROCESS_EXITED',
            phase: 'process',
            cancelled: false,
          }),
        ]),
      );
    } finally {
      controller.abort();
      await expect(running).rejects.toMatchObject({
        code: 'PROCESS_CANCELLED',
      });
    }
  });
  it('cancels the backoff without invalidating the previous complete context', async () => {
    const f = await fixture('busy');
    const original = '{"status":"valid","generation":"previous"}';
    await mkdir(join(f.root, '.alfred/dev/render'), { recursive: true });
    await writeFile(join(f.root, '.alfred/dev/render/index.json'), original);
    const controller = new AbortController();
    let output = '';
    const running = f.run(['--once'], controller.signal, (text) => {
      output += text;
      if (output.includes('"waiting":true')) controller.abort();
    });
    await expect(running).rejects.toMatchObject({ code: 'PROCESS_CANCELLED' });
    safe(output);
    expect(events(output)).toContainEqual(
      expect.objectContaining({
        code: 'WORKSPACE_BUSY',
        waiting: true,
        cancelled: false,
      }),
    );
    expect(events(output)).toContainEqual(
      expect.objectContaining({ code: 'OPERATION_CANCELLED', cancelled: true }),
    );
    expect(
      await readFile(join(f.root, '.alfred/dev/render/index.json'), 'utf8'),
    ).toBe(original);
    await expect(
      readFile(join(f.root, 'invalidated.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports exhausted contention as waiting and schedules a bounded new round without source failure', async () => {
    const f = await fixture('busy');
    const script = join(f.root, 'scripts/render-dev.mjs');
    const source = await readFile(script, 'utf8');
    expect(source.match(/const waitBudgetMs = 3 \* 60_000;/gu)).toHaveLength(1);
    // Keep the production budget unchanged; shorten only this private protocol fixture.
    await writeFile(
      script,
      source.replace(
        'const waitBudgetMs = 3 * 60_000;',
        'const waitBudgetMs = 10_001;',
      ),
    );
    const controller = new AbortController();
    let output = '';
    const running = f.run([], controller.signal, (text) => {
      output += text;
      if ((output.match(/"retryExhausted":true/gu) ?? []).length >= 2)
        controller.abort();
    });
    await expect(running).rejects.toMatchObject({ code: 'PROCESS_CANCELLED' });
    safe(output);
    expect(events(output).filter((event) => event.retryExhausted)).toHaveLength(
      2,
    );
    expect(
      events(output).every(
        (event) => event.code === 'WORKSPACE_BUSY' && event.waiting,
      ),
    ).toBe(true);
    await expect(
      readFile(join(f.root, 'invalidated.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not mistake an unexpected child exit after waiting for exhausted contention', async () => {
    const f = await fixture('busy-crash');
    const controller = new AbortController();
    let output = '';
    const running = f.run([], controller.signal, (text) => {
      output += text;
      if (output.includes('"phase":"process"')) controller.abort();
    });
    await expect(running).rejects.toMatchObject({ code: 'PROCESS_CANCELLED' });
    safe(output);
    expect(events(output)).toContainEqual(
      expect.objectContaining({ code: 'WORKSPACE_BUSY', waiting: true }),
    );
    expect(events(output)).toContainEqual(
      expect.objectContaining({ code: 'PROCESS_EXITED', phase: 'process' }),
    );
    expect(events(output).some((event) => event.retryExhausted)).toBe(false);
  });
  it('real source recovery blocks public render but allows authoring and the existing recovery API', async () => {
    const f = await fixture('real-recovery');
    const packagePath = join(f.root, 'node_modules/@foliohaven/server');
    await rm(packagePath, { recursive: true, force: true });
    await symlink(join(repository, 'server'), packagePath, 'dir');
    await mkdir(join(f.root, 'content/articles/entry'), { recursive: true });
    await writeFile(
      join(f.root, 'content/site.json'),
      JSON.stringify({
        siteName: 'Recovery fixture',
        siteDescription: 'Source recovery',
        siteUrl: 'https://example.invalid/',
        author: { name: 'Fixture' },
      }),
    );
    await writeFile(
      join(f.root, 'content/categories.json'),
      JSON.stringify([{ path: 'notes', name: '筆記' }]),
    );
    await writeFile(join(f.root, 'content/tags.json'), '[]');
    const key = 'content/articles/entry/meta.json';
    const path = join(f.root, key);
    const original = JSON.stringify({
      status: 'draft',
      title: '原始完整版本',
      slug: 'entry',
      category: 'notes',
    });
    await writeFile(path, original);
    await writeFile(
      join(f.root, 'content/articles/entry/content.html'),
      '<h2 id="body">原始正文</h2>',
    );
    const writer = new FileRepository({
      repositoryRoot: f.root,
      fault: async (event) => {
        if (event.phase === 'after-displace' && event.resourceKey === key) {
          await writeFile(path, '{"external":"unresolved"}');
          throw Object.assign(new Error('fixture conflict'), { code: 'EIO' });
        }
      },
    });
    const precondition = await writer.withConsistentRead(async (session) => ({
      ifMatch: await session.etag([key]),
      resourceKeys: [key],
    }));
    await expect(
      writer.commit({
        kind: 'save',
        precondition,
        changes: [
          {
            resourceKey: key,
            expectedRevision: createHash('sha256')
              .update(original)
              .digest('hex'),
            content: Buffer.from(
              JSON.stringify({
                status: 'draft',
                title: '候選版本',
                slug: 'entry',
                category: 'notes',
              }),
            ),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'EIO' });
    expect((await writer.initialize()).recoveryState).toBe('recovery-required');
    const raw = async (args: readonly string[]) => {
      const child = spawn(
        process.execPath,
        ['scripts/render-dev.mjs', ...args],
        {
          cwd: f.root,
          env: buildProcessEnvironment(),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (bytes: Buffer) => {
        output += bytes.toString('utf8');
      });
      child.stderr.on('data', (bytes: Buffer) => {
        output += bytes.toString('utf8');
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      return { code, output };
    };
    const publicResult = await raw(['--once']);
    expect(publicResult.code).toBe(1);
    expect(events(publicResult.output)[0]).toMatchObject({
      code: 'RECOVERY_REQUIRED',
      cancelled: false,
    });
    const authoring = await raw(['--authoring']);
    expect(authoring.code).toBe(2);
    expect(events(authoring.output)[0]).toMatchObject({
      code: 'RECOVERY_REQUIRED',
      cancelled: false,
    });
    safe(authoring.output);
    const token = randomBytes(32).toString('hex');
    const service = await createLocalService({
      repositoryRoot: f.root,
      proxyToken: token,
    });
    try {
      const address = await service.listen({ port: 0 });
      const headers = { 'x-alfred-process-token': token };
      const listing = await fetch(`${address.url}/api/v1/recoveries`, {
        headers,
      });
      expect(listing.status).toBe(200);
      const rows = (await listing.json()) as { items: { id: string }[] };
      const id = rows.items[0]?.id;
      expect(id).toBeDefined();
      const detail = await fetch(`${address.url}/api/v1/recoveries/${id}`, {
        headers,
      });
      expect(detail.status).toBe(200);
      const value = RecoveryDetailSchema.parse(await detail.json());
      const origin = 'http://127.0.0.1:5173';
      const resolved = await fetch(
        `${address.url}/api/v1/recoveries/${id}/resolution`,
        {
          method: 'PUT',
          headers: {
            ...headers,
            Origin: origin,
            'x-alfred-studio-origin': origin,
            'Content-Type': 'application/json',
            'If-Match': detail.headers.get('etag') ?? '',
          },
          body: JSON.stringify({
            choice: 'restore-backup',
            revisions: value.resources.map((item) => ({
              resourceKey: item.resourceKey,
              revision: item.current.revision,
            })),
          }),
        },
      );
      expect(resolved.status).toBe(200);
      await resolved.arrayBuffer();
      expect((await writer.initialize()).recoveryState).toBe('ready');
      expect(await readFile(path, 'utf8')).toBe(original);
    } finally {
      await service.close();
    }
  });
});
