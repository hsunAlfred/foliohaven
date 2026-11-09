import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createWorker } from '../../scripts/cloudflare/worker.mjs';
import type {
  WorkerContext,
  WorkerState,
  WranglerRunOptions,
} from '../../scripts/cloudflare/worker.mjs';
import { runControlledProcess } from '../../server/src/runtime/process.js';

const require = createRequire(import.meta.url);
const directories: string[] = [];
const id = '11111111-1111-4111-8111-111111111111';
const oldVersion = '22222222-2222-4222-8222-222222222222';
const newVersion = '33333333-3333-4333-8333-333333333333';
const originalDeployment = '44444444-4444-4444-8444-444444444444';
const newDeployment = '55555555-5555-4555-8555-555555555555';
const restoreDeployment = '66666666-6666-4666-8666-666666666666';
const target = { accountId: 'a'.repeat(32), workerName: 'fixture-blog' };
const token = 'fixture-worker-token';

async function fixture(privateName: '.foliohaven' | '.alfred' = '.foliohaven') {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'alfred-worker-'));
  directories.push(repositoryRoot);
  await mkdir(join(repositoryRoot, 'cloudflare'));
  await copyFile(
    new URL('../../cloudflare/wrangler.template.json', import.meta.url),
    join(repositoryRoot, 'cloudflare/wrangler.template.json'),
  );
  const root = join(repositoryRoot, privateName, 'deployments', id);
  await mkdir(join(root, 'worker/article'), { recursive: true, mode: 0o700 });
  const files = {
    'index.html': '<!doctype html><title>Home</title><h1>Fixture home</h1>',
    'article/index.html':
      '<!doctype html><title>Article</title><h1>Fixture article</h1>',
    '404.html': '<!doctype html><title>Missing</title><h1>Fixture missing</h1>',
    'sitemap-index.xml': '<?xml version="1.0"?><sitemapindex/>',
    'rss.xml': '<?xml version="1.0"?><rss version="2.0"/>',
    'search-index.json': '{"articles":[]}',
    'robots.txt': 'User-agent: *\nAllow: /\n',
  };
  for (const [name, value] of Object.entries(files))
    await writeFile(join(root, 'worker', name), value);
  const snapshots: { worker?: WorkerState }[] = [];
  const context: WorkerContext = {
    root,
    deploymentId: id,
    journal: {},
    save: async () => {
      snapshots.push(structuredClone(context.journal));
    },
  };
  const settings: Record<string, unknown> = {
    bindings: [],
    compatibility_date: '2026-10-26',
    compatibility_flags: [],
  };
  const remote = {
    exists: false,
    versionId: oldVersion,
    deploymentId: originalDeployment,
    message: 'unrelated private operator note',
    versionMessages: {
      [oldVersion]: `alfred-wiki deploy ${oldVersion}`,
      [newVersion]: `alfred-wiki deploy ${id}`,
    } as Record<string, string>,
    versionTags: {
      [oldVersion]: oldVersion,
      [newVersion]: id,
    } as Record<string, string>,
    split: false,
    handlers: [] as string[],
    versions: [newVersion, oldVersion],
    getError: 0,
    putError: 0,
    lostRestoreResponse: false,
  };
  const requests: { url: string; method: string; body: unknown }[] = [];
  const runs: WranglerRunOptions[] = [];
  const response = (result: unknown, status = 200) =>
    new Response(
      JSON.stringify({
        success: status === 200,
        result,
        errors: status === 404 ? [{ code: 10007 }] : [],
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url: url.href, method, body });
    expect(url.hostname).toBe('api.cloudflare.com');
    expect(url.pathname).toContain(
      `/accounts/${target.accountId}/workers/scripts/${target.workerName}/`,
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${token}`,
    );
    if (remote.getError && method === 'GET')
      return response(null, remote.getError);
    if (url.pathname.endsWith('/settings'))
      return remote.exists ? response(settings) : response(null, 404);
    if (url.pathname.endsWith('/deployments') && method === 'POST') {
      if (remote.putError) return response(null, remote.putError);
      remote.versionId = oldVersion;
      remote.deploymentId = restoreDeployment;
      remote.message =
        (body as { annotations: Record<string, string> }).annotations[
          'workers/message'
        ] ?? '';
      if (remote.lostRestoreResponse)
        throw new Error('fixture lost successful response');
      return response({ id: restoreDeployment });
    }
    if (url.pathname.endsWith('/deployments'))
      return response({
        deployments: [
          {
            id: remote.deploymentId,
            versions: remote.split
              ? [
                  { version_id: remote.versionId, percentage: 50 },
                  { version_id: newVersion, percentage: 50 },
                ]
              : [{ version_id: remote.versionId, percentage: 100 }],
            annotations: { 'workers/message': remote.message },
          },
        ],
      });
    if (url.pathname.endsWith('/versions'))
      return response({
        items: remote.versions.map((versionId) => ({ id: versionId })),
      });
    if (url.pathname.includes('/versions/')) {
      const versionId = url.pathname.split('/').at(-1) ?? '';
      return response({
        id: versionId,
        annotations: {
          'workers/tag': remote.versionTags[versionId],
          'workers/message': remote.versionMessages[versionId],
        },
        resources: {
          bindings: {},
          script: { handlers: remote.handlers },
          script_runtime: {},
        },
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const run = async (options: WranglerRunOptions) => {
    runs.push(options);
    if (options.args.includes('--dry-run')) return {};
    remote.exists = true;
    remote.versionId = newVersion;
    remote.deploymentId = newDeployment;
    remote.message = options.args[options.args.indexOf('--message') + 1] ?? '';
    remote.versionMessages[newVersion] = remote.message;
    remote.handlers = ['fetch'];
    return {};
  };
  const worker = createWorker({
    config: target,
    token,
    repositoryRoot,
    fetchImpl,
    run,
    retryDelayMs: 1,
  });
  return {
    repositoryRoot,
    root,
    context,
    snapshots,
    settings,
    remote,
    requests,
    runs,
    fetchImpl,
    run,
    worker,
    files,
  };
}

async function deployedWithChangedSettings() {
  const f = await fixture();
  f.remote.exists = true;
  const worker = createWorker({
    config: target,
    token,
    repositoryRoot: f.repositoryRoot,
    fetchImpl: f.fetchImpl,
    run: async (options) => {
      const result = await f.run(options);
      if (!options.args.includes('--dry-run'))
        f.settings.tags = ['deployment-b'];
      return result;
    },
  });
  await worker.preflight(f.context);
  await worker.stage(f.context);
  await worker.deploy(f.context);
  expect(f.context.journal.worker?.after?.settingsFingerprint).not.toBe(
    f.context.journal.worker?.before?.settingsFingerprint,
  );
  return { ...f, worker };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Cloudflare Worker deployment boundary', () => {
  it.each(['.foliohaven', '.alfred'] as const)(
    'keeps %s deployment evidence readable and writes Foliohaven operation messages',
    async (privateName) => {
      const f = await fixture(privateName);
      f.remote.exists = true;
      f.remote.handlers = ['fetch'];
      f.remote.message = `alfred-wiki deploy ${oldVersion}`;
      await f.worker.preflight(f.context);
      await f.worker.stage(f.context);
      await f.worker.deploy(f.context);
      const run = f.runs[0];
      expect(run?.args[run.args.indexOf('--message') + 1]).toBe(
        `foliohaven deploy ${id}`,
      );
      expect(f.context.journal.worker?.before?.message).toBe(
        `alfred-wiki deploy ${oldVersion}`,
      );
      f.remote.message = `alfred-wiki deploy ${id}`;
      f.remote.versionMessages[newVersion] = `alfred-wiki deploy ${id}`;
      await expect(f.worker.status(f.context)).resolves.toMatchObject({
        status: 'uploaded',
      });
      await f.worker.restore(f.context);
      const restore = f.requests.find((request) => request.method === 'POST');
      expect(restore?.body).toMatchObject({
        annotations: { 'workers/message': `foliohaven restore ${id}` },
      });
      expect(await readdir(f.repositoryRoot)).not.toContain(
        privateName === '.alfred' ? '.foliohaven' : '.alfred',
      );
    },
  );

  it('recognizes a Foliohaven version marker while still requiring the matching version tag', async () => {
    const f = await fixture();
    f.remote.exists = true;
    f.remote.handlers = ['fetch'];
    f.remote.versionMessages[oldVersion] = `foliohaven deploy ${oldVersion}`;
    await expect(f.worker.preflight(f.context)).resolves.toMatchObject({
      versionId: oldVersion,
    });
    f.remote.versionTags[oldVersion] = id;
    await expect(f.worker.preflight()).rejects.toMatchObject({
      code: 'WORKER_SETTINGS_CONFLICT',
    });
  });

  it('stages a fixed assets-only config and dry-runs without credentials or API calls', async () => {
    const f = await fixture();
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'must-not-inherit');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'must-not-inherit');
    const worker = createWorker({
      config: target,
      repositoryRoot: f.repositoryRoot,
      fetchImpl: f.fetchImpl,
      run: f.run,
    });
    await worker.stage(f.context);
    await worker.dryRun(f.context);
    expect(f.requests).toHaveLength(0);
    const run = f.runs[0];
    if (!run) throw new Error('Fixture expected a Wrangler invocation');
    expect(run.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(run.env.R2_SECRET_ACCESS_KEY).toBeUndefined();
    expect(run.env.WRANGLER_WRITE_LOGS).toBe('false');
    expect(run.env.WRANGLER_SEND_METRICS).toBe('false');
    expect(run.args).toContain('--strict');
    expect(run.args).toContain('--autoconfig=false');
    expect(run.args).toContain('--install-skills=false');
    const config: Record<string, unknown> = JSON.parse(
      await readFile(join(f.root, 'wrangler/wrangler.json'), 'utf8'),
    );
    for (const key of ['main', 'route', 'routes', 'r2_buckets'])
      expect(config).not.toHaveProperty(key);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.assets).toEqual({
      directory: '../worker',
      html_handling: 'force-trailing-slash',
      not_found_handling: '404-page',
    });
    expect(JSON.stringify(f.snapshots)).not.toContain(token);
  });

  it('creates an absent Worker only after saving intent, then verifies the active deployment', async () => {
    const f = await fixture();
    expect(await f.worker.preflight(f.context)).toBeNull();
    await f.worker.stage(f.context);
    await expect(f.worker.deploy(f.context)).resolves.toEqual({
      versionId: newVersion,
      deploymentId: newDeployment,
      settingsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      tag: id,
    });
    expect(f.context.journal.worker?.status).toBe('uploaded');
    expect(
      f.snapshots.some(
        (snapshot) => snapshot.worker?.status === 'deploy-intent',
      ),
    ).toBe(true);
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]?.env.CLOUDFLARE_API_TOKEN).toBe(token);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'uploaded',
    });
  });

  it('updates the same dedicated Worker while permitting Wrangler’s verified no-op fetch handler', async () => {
    const f = await fixture();
    f.remote.exists = true;
    f.remote.handlers = ['fetch'];
    f.remote.message = `alfred-wiki deploy ${oldVersion}`;
    await f.worker.preflight(f.context);
    await f.worker.stage(f.context);
    await f.worker.deploy(f.context);
    expect(f.context.journal.worker?.before?.versionId).toBe(oldVersion);
    expect(f.context.journal.worker?.after?.versionId).toBe(newVersion);
    expect(f.runs[0]?.args).not.toContain('--routes');
    expect(f.runs[0]?.args).not.toContain('--domains');
  });

  it.each(['first-deploy', 'unknown-status'])(
    'recognizes version message and tag with a different deployment annotation: %s',
    async (mode) => {
      const f = await fixture();
      const run = async (options: WranglerRunOptions) => {
        await f.run(options);
        f.remote.message = 'deployment generated by Cloudflare API';
        f.remote.handlers = [];
        return {};
      };
      const worker = createWorker({
        config: target,
        token,
        repositoryRoot: f.repositoryRoot,
        fetchImpl: f.fetchImpl,
        run,
      });
      await worker.preflight(f.context);
      await worker.stage(f.context);
      if (mode === 'first-deploy') {
        await expect(worker.deploy(f.context)).resolves.toMatchObject({
          versionId: newVersion,
          deploymentId: newDeployment,
          tag: id,
        });
      } else {
        f.remote.exists = true;
        f.remote.versionId = newVersion;
        f.remote.deploymentId = newDeployment;
        f.remote.message = 'deployment generated by Cloudflare API';
        const state = f.context.journal.worker;
        if (!state) throw new Error('Fixture requires staged Worker state');
        state.status = 'unknown';
      }
      await expect(worker.status(f.context)).resolves.toMatchObject({
        status: 'uploaded',
        remote: { versionId: newVersion, deploymentId: newDeployment },
      });
      expect(f.context.journal.worker?.status).toBe('uploaded');
      expect(f.context.journal.worker?.after).toMatchObject({
        versionId: newVersion,
        deploymentId: newDeployment,
      });
      expect(f.runs).toHaveLength(mode === 'first-deploy' ? 1 : 0);
      expect(f.requests.every((request) => request.method === 'GET')).toBe(
        true,
      );
    },
  );

  it.each(['version-message', 'version-tag'])(
    'does not accept a matching deployment annotation without matching %s',
    async (field) => {
      const f = await fixture();
      await f.worker.preflight(f.context);
      await f.worker.stage(f.context);
      const state = f.context.journal.worker;
      if (!state) throw new Error('Fixture requires staged Worker state');
      state.status = 'unknown';
      f.remote.exists = true;
      f.remote.versionId = newVersion;
      f.remote.deploymentId = newDeployment;
      f.remote.message = `alfred-wiki deploy ${id}`;
      if (field === 'version-message')
        f.remote.versionMessages[newVersion] = 'another version';
      else f.remote.versionTags[newVersion] = oldVersion;
      await expect(f.worker.status(f.context)).resolves.toMatchObject({
        status: 'unknown',
        conflict: true,
      });
      expect(state.after).toBeNull();
      expect(state.status).toBe('unknown');
      expect(f.runs).toHaveLength(0);
    },
  );

  it.each([401, 403, 404, 429, 500])(
    'does not interpret HTTP %i as permission to create',
    async (status) => {
      const f = await fixture();
      f.remote.getError = status;
      if (status === 404) {
        const other404: typeof fetch = async () =>
          new Response(
            JSON.stringify({ success: false, errors: [{ code: 9999 }] }),
            { status: 404 },
          );
        const worker = createWorker({
          config: target,
          token,
          repositoryRoot: f.repositoryRoot,
          fetchImpl: other404,
        });
        await expect(worker.preflight(f.context)).rejects.toMatchObject({
          code: 'WORKER_API_FAILED',
        });
      } else {
        await expect(f.worker.preflight(f.context)).rejects.toHaveProperty(
          'code',
          status === 401 || status === 403
            ? 'WORKER_PERMISSION_DENIED'
            : 'WORKER_API_FAILED',
        );
      }
      expect(f.runs).toHaveLength(0);
    },
  );

  it('rejects split deployments, bindings, arbitrary fetch code, and changed settings before upload', async () => {
    const f = await fixture();
    f.remote.exists = true;
    f.remote.split = true;
    await expect(f.worker.preflight()).rejects.toHaveProperty(
      'code',
      'WORKER_DEPLOYMENT_CONFLICT',
    );
    f.remote.split = false;
    f.settings.bindings = [{ name: 'DATA', type: 'r2_bucket' }];
    await expect(f.worker.preflight()).rejects.toHaveProperty(
      'code',
      'WORKER_SETTINGS_CONFLICT',
    );
    f.settings.bindings = [];
    f.remote.handlers = ['fetch'];
    f.remote.versionMessages[oldVersion] = 'unrelated private operator note';
    await expect(f.worker.preflight()).rejects.toHaveProperty(
      'code',
      'WORKER_SETTINGS_CONFLICT',
    );
    f.remote.handlers = [];
    await f.worker.preflight(f.context);
    expect(JSON.stringify(f.context.journal)).not.toContain(
      'unrelated private operator note',
    );
    await f.worker.stage(f.context);
    f.settings.observability = { enabled: true };
    await expect(f.worker.deploy(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_SETTINGS_CONFLICT',
    );
    expect(f.runs).toHaveLength(0);
  });

  it('refuses remote version or deployment drift and fixed-config mutation', async () => {
    const f = await fixture();
    f.remote.exists = true;
    await f.worker.preflight(f.context);
    await f.worker.stage(f.context);
    f.remote.deploymentId = newDeployment;
    await expect(f.worker.deploy(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_REMOTE_CHANGED',
    );
    f.remote.deploymentId = originalDeployment;
    await writeFile(join(f.root, 'wrangler/wrangler.json'), '{}');
    await expect(f.worker.deploy(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_CONFIG_CHANGED',
    );
    expect(f.runs).toHaveLength(0);
  });

  it('binds the first Worker staging tree to the authoritative deployment file manifest', async () => {
    const f = await fixture();
    f.context.manifest = Object.entries(f.files).map(([path, value]) => ({
      path,
      byteSize: Buffer.byteLength(value),
      sha256: createHash('sha256').update(value).digest('hex'),
      target: 'worker',
    }));
    await writeFile(
      join(f.root, 'worker/index.html'),
      '<h1>changed before staging</h1>',
    );
    await expect(f.worker.stage(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_ASSETS_CHANGED',
    );
    expect(f.context.journal.worker?.stage).toBeNull();
    expect(f.runs).toHaveLength(0);
  });

  it.each(['changed', 'extra', 'missing', 'symlink'])(
    'rejects %s Worker staging after a long R2 upload without invoking Wrangler',
    async (mutation) => {
      const f = await fixture();
      await f.worker.preflight(f.context);
      await f.worker.stage(f.context);
      const originalDigest =
        f.context.journal.worker?.stage?.workerManifest.digest;
      if (mutation === 'changed')
        await writeFile(
          join(f.root, 'worker/index.html'),
          '<h1>not the frozen website</h1>',
        );
      if (mutation === 'extra')
        await writeFile(
          join(f.root, 'worker/extra.txt'),
          'unexpected public file',
        );
      if (mutation === 'missing') await rm(join(f.root, 'worker/rss.xml'));
      if (mutation === 'symlink') {
        const privateFile = join(f.repositoryRoot, 'private-fixture.txt');
        await writeFile(privateFile, 'must remain private');
        await symlink(privateFile, join(f.root, 'worker/unexpected.txt'));
      }
      await expect(f.worker.dryRun(f.context)).rejects.toHaveProperty(
        'code',
        'WORKER_ASSETS_CHANGED',
      );
      await expect(f.worker.deploy(f.context)).rejects.toHaveProperty(
        'code',
        'WORKER_ASSETS_CHANGED',
      );
      await expect(f.worker.stage(f.context)).rejects.toHaveProperty(
        'code',
        'WORKER_ASSETS_CHANGED',
      );
      expect(f.context.journal.worker?.stage?.workerManifest.digest).toBe(
        originalDigest,
      );
      expect(f.context.journal.worker?.status).toBe('prepared');
      expect(f.runs).toHaveLength(0);
    },
  );

  it('checks the full staging tree after a successful dry-run without claiming a remote side effect', async () => {
    const f = await fixture();
    const worker = createWorker({
      config: target,
      repositoryRoot: f.repositoryRoot,
      run: async (options) => {
        await f.run(options);
        await writeFile(
          join(f.root, 'worker/index.html'),
          '<h1>changed during dry-run</h1>',
        );
      },
    });
    await worker.stage(f.context);
    await expect(worker.dryRun(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_ASSETS_CHANGED',
    );
    expect(f.requests).toHaveLength(0);
    expect(f.context.journal.worker?.stageArtifactInvalid).not.toBe(true);
  });

  it('never promotes changed upload staging to uploaded, but can restore by verified versions without reading the damaged tree', async () => {
    const f = await fixture();
    f.remote.exists = true;
    const worker = createWorker({
      config: target,
      token,
      repositoryRoot: f.repositoryRoot,
      fetchImpl: f.fetchImpl,
      run: async (options) => {
        await f.run(options);
        if (!options.args.includes('--dry-run'))
          await writeFile(
            join(f.root, 'worker/index.html'),
            '<h1>changed while publishing</h1>',
          );
      },
    });
    await worker.preflight(f.context);
    await worker.stage(f.context);
    await expect(worker.deploy(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_ASSETS_UNPROVEN',
    );
    expect(f.context.journal.worker?.status).toBe('recovery-required');
    expect(f.context.journal.worker?.stageArtifactInvalid).toBe(true);
    expect(f.context.journal.worker?.after?.versionId).toBe(newVersion);
    await expect(worker.status(f.context)).resolves.toMatchObject({
      status: 'recovery-required',
    });
    await writeFile(join(f.root, 'worker/index.html'), f.files['index.html']);
    await expect(worker.status(f.context)).resolves.toMatchObject({
      status: 'recovery-required',
    });
    await rm(join(f.root, 'worker'), { recursive: true });
    await expect(worker.preflightRestore(f.context)).resolves.toMatchObject({
      canRestoreWorker: true,
    });
    await expect(worker.restore(f.context)).resolves.toEqual({
      restored: true,
      versionId: oldVersion,
    });
    await expect(worker.status(f.context)).resolves.toMatchObject({
      status: 'restored',
    });
    expect(f.context.journal.worker?.stageArtifactInvalid).toBe(true);
    expect(f.runs).toHaveLength(1);
  });

  it('keeps a lost deployment response unknown when later negative reads show the old state', async () => {
    const f = await fixture();
    const run = vi.fn(async () => {
      throw new Error('fixture transport failure');
    });
    const worker = createWorker({
      config: target,
      token,
      repositoryRoot: f.repositoryRoot,
      fetchImpl: f.fetchImpl,
      run,
    });
    await worker.preflight(f.context);
    await worker.stage(f.context);
    await expect(worker.deploy(f.context)).rejects.toMatchObject({
      code: 'WORKER_RESULT_UNKNOWN',
      unknown: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(worker.status(f.context)).resolves.toMatchObject({
      status: 'unknown',
    });
    await expect(worker.preflightRestore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_RECOVERY_REQUIRED',
    );
    f.remote.exists = true;
    f.remote.versionId = newVersion;
    f.remote.deploymentId = newDeployment;
    f.remote.message = `alfred-wiki deploy ${id}`;
    await expect(worker.status(f.context)).resolves.toMatchObject({
      status: 'uploaded',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps an ambiguous deployment unresolved after external drift until its own late commit is visible', async () => {
    const f = await fixture();
    f.remote.exists = true;
    const run = vi.fn(async () => {
      throw new Error('fixture lost deployment response');
    });
    const worker = createWorker({
      config: target,
      token,
      repositoryRoot: f.repositoryRoot,
      fetchImpl: f.fetchImpl,
      run,
    });
    await worker.preflight(f.context);
    await worker.stage(f.context);
    await expect(worker.deploy(f.context)).rejects.toMatchObject({
      unknown: true,
    });
    f.remote.versionId = newVersion;
    f.remote.deploymentId = restoreDeployment;
    f.remote.message = 'external deployment';
    f.remote.versionMessages[newVersion] = 'external version';
    await expect(worker.status(f.context)).resolves.toMatchObject({
      status: 'unknown',
      conflict: true,
      diagnosticCode: 'WORKER_REMOTE_CHANGED',
    });
    expect(f.context.journal.worker?.status).toBe('unknown');
    await expect(worker.deploy(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_RECOVERY_REQUIRED',
    );
    await expect(worker.preflightRestore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_RECOVERY_REQUIRED',
    );
    f.remote.exists = false;
    await expect(worker.status(f.context)).resolves.toMatchObject({
      status: 'unknown',
      conflict: true,
    });
    f.remote.exists = true;
    f.remote.handlers = ['fetch'];
    await expect(worker.status(f.context)).resolves.toMatchObject({
      status: 'unknown',
      conflict: true,
      diagnosticCode: 'WORKER_SETTINGS_CONFLICT',
    });
    f.remote.split = true;
    await expect(worker.status(f.context)).resolves.toMatchObject({
      status: 'unknown',
      conflict: true,
      diagnosticCode: 'WORKER_DEPLOYMENT_CONFLICT',
    });
    f.remote.split = false;
    f.remote.deploymentId = newDeployment;
    f.remote.message = `alfred-wiki deploy ${id}`;
    f.remote.versionMessages[newVersion] = `alfred-wiki deploy ${id}`;
    await expect(worker.status(f.context)).resolves.toMatchObject({
      status: 'uploaded',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps an ambiguous restore unresolved across external deployments and transient inspection errors', async () => {
    const f = await fixture();
    f.remote.exists = true;
    await f.worker.preflight(f.context);
    await f.worker.stage(f.context);
    await f.worker.deploy(f.context);
    f.remote.putError = 500;
    await expect(f.worker.restore(f.context)).rejects.toMatchObject({
      code: 'WORKER_RESTORE_UNKNOWN',
      unknown: true,
    });
    f.remote.deploymentId = originalDeployment;
    f.remote.message = 'external deployment while restore in flight';
    f.remote.handlers = [];
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'unknown',
      conflict: true,
    });
    expect(f.context.journal.worker?.status).toBe('restore-intent');
    f.remote.getError = 403;
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'unknown',
      conflict: false,
      diagnosticCode: 'WORKER_PERMISSION_DENIED',
    });
    f.remote.getError = 0;
    await expect(f.worker.restore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_RECOVERY_REQUIRED',
    );
    expect(
      f.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
    f.remote.versionId = oldVersion;
    f.remote.deploymentId = restoreDeployment;
    f.remote.message = `alfred-wiki restore ${id}`;
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'restored',
    });
    expect(
      f.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
  });

  it('rejects restore if another deployment reused the exact same version', async () => {
    const f = await fixture();
    f.remote.exists = true;
    await f.worker.preflight(f.context);
    await f.worker.stage(f.context);
    await f.worker.deploy(f.context);
    f.remote.deploymentId = restoreDeployment;
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'conflict',
    });
    await expect(f.worker.preflightRestore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_REMOTE_CHANGED',
    );
    expect(
      f.requests.filter((request) => request.method !== 'GET'),
    ).toHaveLength(0);
  });

  it('keeps an unresolved write unknown when an external deployment reuses the already-recorded own version', async () => {
    const f = await fixture();
    await f.worker.preflight(f.context);
    await f.worker.stage(f.context);
    await f.worker.deploy(f.context);
    const state = f.context.journal.worker;
    if (!state) throw new Error('Fixture requires deployed Worker state');
    state.status = 'unknown';
    f.remote.deploymentId = restoreDeployment;
    f.remote.message = 'external deployment using the same version';
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'unknown',
      conflict: true,
      diagnosticCode: 'WORKER_REMOTE_CHANGED',
    });
    expect(state.after?.deploymentId).toBe(newDeployment);
    expect(state.status).toBe('unknown');
    await expect(f.worker.preflightRestore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_RECOVERY_REQUIRED',
    );
    expect(f.runs).toHaveLength(1);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('checks rollback availability before allowing any restore writes', async () => {
    const f = await fixture();
    f.remote.exists = true;
    await f.worker.preflight(f.context);
    await f.worker.stage(f.context);
    await f.worker.deploy(f.context);
    f.remote.versions = [newVersion];
    await expect(f.worker.preflightRestore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_RESTORE_VERSION_UNAVAILABLE',
    );
    expect(
      f.requests.filter((request) => request.method !== 'GET'),
    ).toHaveLength(0);
  });

  it('detects metadata-only remote drift even when the active version stays the same', async () => {
    const f = await fixture();
    f.remote.exists = true;
    await f.worker.preflight(f.context);
    await f.worker.stage(f.context);
    await f.worker.deploy(f.context);
    f.settings.tags = ['externally-changed'];
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'conflict',
    });
    await expect(f.worker.preflightRestore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_REMOTE_CHANGED',
    );
    expect(
      f.requests.filter((request) => request.method !== 'GET'),
    ).toHaveLength(0);
  });

  it('does not reissue an ambiguous restore when the prior version is not visible yet', async () => {
    const f = await fixture();
    f.remote.exists = true;
    await f.worker.preflight(f.context);
    await f.worker.stage(f.context);
    await f.worker.deploy(f.context);
    f.remote.putError = 500;
    await expect(f.worker.restore(f.context)).rejects.toMatchObject({
      code: 'WORKER_RESTORE_UNKNOWN',
      unknown: true,
    });
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'unknown',
    });
    await expect(f.worker.restore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_RECOVERY_REQUIRED',
    );
    expect(
      f.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
    f.remote.versionId = oldVersion;
    f.remote.deploymentId = restoreDeployment;
    f.remote.message = `alfred-wiki restore ${id}`;
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'restored',
    });
  });

  it('rejects an already-cancelled operation before any remote request', async () => {
    const f = await fixture();
    const abort = new AbortController();
    abort.abort();
    f.context.signal = abort.signal;
    await expect(f.worker.preflight(f.context)).rejects.toHaveProperty(
      'code',
      'CLOUDFLARE_CANCELLED',
    );
    await expect(f.worker.stage(f.context)).rejects.toHaveProperty(
      'code',
      'CLOUDFLARE_CANCELLED',
    );
    expect(f.requests).toHaveLength(0);
    expect(f.runs).toHaveLength(0);
  });

  it('restores only the recorded prior version and safely resolves a lost successful response', async () => {
    const f = await fixture();
    f.remote.exists = true;
    await f.worker.preflight(f.context);
    await f.worker.stage(f.context);
    await f.worker.deploy(f.context);
    f.remote.lostRestoreResponse = true;
    await expect(f.worker.preflightRestore(f.context)).resolves.toMatchObject({
      canRestoreWorker: true,
    });
    await expect(f.worker.restore(f.context)).resolves.toEqual({
      restored: true,
      versionId: oldVersion,
    });
    const writes = f.requests.filter((request) => request.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toMatchObject({
      versions: [{ version_id: oldVersion, percentage: 100 }],
    });
    await expect(f.worker.restore(f.context)).resolves.toEqual({
      restored: true,
      versionId: oldVersion,
    });
    expect(
      f.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
    expect(f.context.journal.worker?.status).toBe('restored');
  });

  it('keeps a committed restore unknown after POST cancellation and resolves it through a fresh read-only status', async () => {
    const f = await fixture();
    f.remote.exists = true;
    const abort = new AbortController();
    const fetchImpl: typeof fetch = async (input, init) => {
      const result = await f.fetchImpl(input, init);
      if (init?.method === 'POST') {
        abort.abort();
        throw new DOMException('Fixture cancelled after commit', 'AbortError');
      }
      return result;
    };
    const worker = createWorker({
      config: target,
      token,
      repositoryRoot: f.repositoryRoot,
      signal: abort.signal,
      fetchImpl,
      run: f.run,
    });
    await worker.preflight(f.context);
    await worker.stage(f.context);
    await worker.deploy(f.context);
    await expect(worker.restore(f.context)).rejects.toMatchObject({
      code: 'WORKER_RESTORE_UNKNOWN',
      unknown: true,
    });
    expect(f.context.journal.worker?.status).toBe('restore-intent');
    expect(f.remote.versionId).toBe(oldVersion);
    expect(
      f.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'restored',
      remote: { versionId: oldVersion, deploymentId: restoreDeployment },
    });
    await expect(f.worker.restore(f.context)).resolves.toEqual({
      restored: true,
      versionId: oldVersion,
    });
    expect(
      f.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
  });

  it('keeps cancellation before the restore POST definite and sends no mutation', async () => {
    const f = await fixture();
    f.remote.exists = true;
    const abort = new AbortController();
    const worker = createWorker({
      config: target,
      token,
      repositoryRoot: f.repositoryRoot,
      signal: abort.signal,
      fetchImpl: f.fetchImpl,
      run: f.run,
    });
    await worker.preflight(f.context);
    await worker.stage(f.context);
    await worker.deploy(f.context);
    const save = f.context.save;
    f.context.save = async () => {
      await save();
      if (f.context.journal.worker?.status === 'restore-intent') abort.abort();
    };
    await expect(worker.restore(f.context)).rejects.toMatchObject({
      code: 'CLOUDFLARE_CANCELLED',
      unknown: false,
    });
    expect(f.context.journal.worker?.status).toBe('uploaded');
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.remote.versionId).toBe(newVersion);
  });

  it('keeps the post-deploy settings after rollback and detects later metadata-only drift', async () => {
    const f = await deployedWithChangedSettings();
    await expect(f.worker.restore(f.context)).resolves.toEqual({
      restored: true,
      versionId: oldVersion,
    });
    const state = f.context.journal.worker;
    expect(state?.restored?.settingsFingerprint).toBe(
      state?.after?.settingsFingerprint,
    );
    expect(state?.restored?.settingsFingerprint).not.toBe(
      state?.before?.settingsFingerprint,
    );
    expect(f.settings.tags).toEqual(['deployment-b']);
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'restored',
    });
    f.settings.tags = ['external-metadata-only-change'];
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'conflict',
      diagnosticCode: 'WORKER_REMOTE_CHANGED',
    });
    await expect(f.worker.preflightRestore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_REMOTE_CHANGED',
    );
    expect(
      f.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
  });

  it('does not resolve restore intent with a matching rollback version but changed settings', async () => {
    const f = await deployedWithChangedSettings();
    f.remote.putError = 500;
    await expect(f.worker.restore(f.context)).rejects.toMatchObject({
      code: 'WORKER_RESTORE_UNKNOWN',
      unknown: true,
    });
    f.remote.versionId = oldVersion;
    f.remote.deploymentId = restoreDeployment;
    f.remote.message = `alfred-wiki restore ${id}`;
    f.settings.tags = ['external-metadata-only-change'];
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'unknown',
      conflict: true,
      diagnosticCode: 'WORKER_REMOTE_CHANGED',
    });
    expect(f.context.journal.worker?.status).toBe('restore-intent');
    expect(f.context.journal.worker?.restored).toBeUndefined();
    await expect(f.worker.preflightRestore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_RECOVERY_REQUIRED',
    );
    f.settings.tags = ['deployment-b'];
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'restored',
    });
    expect(f.context.journal.worker?.restored?.settingsFingerprint).toBe(
      f.context.journal.worker?.after?.settingsFingerprint,
    );
    expect(
      f.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
  });

  it('verifies legacy restored records against the saved post-deploy fingerprint before enriching them', async () => {
    const f = await deployedWithChangedSettings();
    await f.worker.restore(f.context);
    const state = f.context.journal.worker;
    if (!state?.restored) throw new Error('Fixture requires restored Worker');
    delete state.restored.settingsFingerprint;
    await expect(f.worker.preflightRestore(f.context)).resolves.toMatchObject({
      alreadyRestored: true,
      remote: { settingsFingerprint: state.after?.settingsFingerprint },
    });
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'restored',
    });
    expect(state.restored.settingsFingerprint).toBe(
      state.after?.settingsFingerprint,
    );
    delete state.restored.settingsFingerprint;
    f.settings.tags = ['external-metadata-only-change'];
    await expect(f.worker.status(f.context)).resolves.toMatchObject({
      status: 'conflict',
      diagnosticCode: 'WORKER_REMOTE_CHANGED',
    });
    await expect(f.worker.preflightRestore(f.context)).rejects.toHaveProperty(
      'code',
      'WORKER_REMOTE_CHANGED',
    );
    expect(state.restored.settingsFingerprint).toBeUndefined();
    expect(
      f.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
  });

  it('saves the verified fingerprint when the original version is already active without sending a restore POST', async () => {
    const f = await fixture();
    f.remote.exists = true;
    await f.worker.preflight(f.context);
    const expectedFingerprint =
      f.context.journal.worker?.before?.settingsFingerprint;
    expect(expectedFingerprint).toEqual(
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    await expect(f.worker.preflightRestore(f.context)).resolves.toMatchObject({
      alreadyRestored: true,
      remote: { settingsFingerprint: expectedFingerprint },
    });
    await expect(f.worker.restore(f.context)).resolves.toEqual({
      restored: true,
      versionId: oldVersion,
    });
    expect(f.context.journal.worker?.restored).toMatchObject({
      versionId: oldVersion,
      deploymentId: originalDeployment,
      settingsFingerprint: expectedFingerprint,
    });
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('does not delete a first-ever Worker during restore', async () => {
    const f = await fixture();
    await f.worker.preflight(f.context);
    await f.worker.stage(f.context);
    await f.worker.deploy(f.context);
    await expect(f.worker.preflightRestore(f.context)).resolves.toMatchObject({
      canRestoreWorker: false,
    });
    await expect(f.worker.restore(f.context)).resolves.toEqual({
      restored: false,
      reason: 'no-before-version',
    });
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.context.journal.worker?.status).toBe('uploaded');
  });

  it('rejects redirected staging paths without changing the target', async () => {
    const f = await fixture();
    const victim = join(f.repositoryRoot, 'victim');
    await mkdir(victim);
    await symlink(victim, join(f.root, 'wrangler'));
    await expect(f.worker.stage(f.context)).rejects.toThrow();
    expect(await readdir(victim)).toEqual([]);
  });
});

describe('real local Workers Static Assets', () => {
  it('runs installed Wrangler dry-run with all network connections prohibited', async () => {
    const f = await fixture();
    const guard = join(f.repositoryRoot, 'deny-network.mjs');
    const attempted = join(f.repositoryRoot, 'network-attempt.txt');
    const temporary = join(f.repositoryRoot, 'temporary');
    await mkdir(temporary, { mode: 0o700 });
    await writeFile(
      guard,
      `
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { appendFileSync(${JSON.stringify(attempted)}, new Error('fixture network attempt').stack + '\\n'); throw new Error('fixture denies network'); };
net.Socket.prototype.connect = denied;
http.request = denied;
https.request = denied;
dgram.Socket.prototype.send = denied;
globalThis.fetch = denied;
syncBuiltinESMExports();
`,
    );
    const run = (options: WranglerRunOptions) =>
      runControlledProcess({
        ...options,
        args: ['--import', guard, ...options.args],
        env: { ...options.env, TMPDIR: temporary },
      });
    const worker = createWorker({
      config: target,
      repositoryRoot: f.repositoryRoot,
      run,
    });
    await worker.stage(f.context);
    await worker.dryRun(f.context);
    const attempts = await readFile(attempted, 'utf8').catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return '';
        throw error;
      },
    );
    expect(attempts).toBe('');
    expect(await readdir(f.repositoryRoot)).not.toContain('.agents');
    expect(await readdir(f.repositoryRoot)).not.toContain('wrangler.json');
  });

  it('serves HTML with trailing slashes and preserves XML/JSON/TXT paths, MIME and real 404', async () => {
    const f = await fixture();
    let environment: NodeJS.ProcessEnv | undefined;
    const worker = createWorker({
      config: target,
      repositoryRoot: f.repositoryRoot,
      run: async (options) => {
        environment = options.env;
      },
    });
    await worker.stage(f.context);
    await worker.dryRun(f.context);
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture port unavailable');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const metadata: { bin: { wrangler: string } } = JSON.parse(
      await readFile(require.resolve('wrangler/package.json'), 'utf8'),
    );
    const cli = join(
      dirname(require.resolve('wrangler/package.json')),
      metadata.bin.wrangler,
    );
    const child = spawn(
      process.execPath,
      [
        cli,
        'dev',
        '--local',
        '--config',
        join(f.root, 'wrangler/wrangler.json'),
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--inspector-port',
        '0',
        '--log-level',
        'error',
        '--install-skills=false',
      ],
      {
        cwd: join(f.root, 'wrangler'),
        env: environment,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    const close = once(child, 'close');
    const base = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (child.exitCode !== null)
          throw new Error(
            `Local Wrangler exited: ${Buffer.concat(chunks).toString()}`,
          );
        try {
          if ((await fetch(base)).status === 200) break;
        } catch {
          /* local startup */
        }
        if (Date.now() >= deadline)
          throw new Error(
            `Local Wrangler startup timed out: ${Buffer.concat(chunks).toString()}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      for (const [path, mime] of [
        ['sitemap-index.xml', /(?:application|text)\/xml/],
        ['rss.xml', /(?:application|text)\/xml/],
        ['search-index.json', /application\/json/],
        ['robots.txt', /text\/plain/],
      ] as const) {
        const response = await fetch(`${base}/${path}`, { redirect: 'manual' });
        expect(response.status, path).toBe(200);
        expect(response.headers.get('content-type'), path).toMatch(mime);
        expect(await response.text(), path).toBe(f.files[path]);
        expect(response.headers.get('location'), path).toBeNull();
      }
      const article = await fetch(`${base}/article`, { redirect: 'manual' });
      expect([301, 307, 308]).toContain(article.status);
      expect(article.headers.get('location')).toBe('/article/');
      expect(await (await fetch(`${base}/article/`)).text()).toContain(
        'Fixture article',
      );
      const missing = await fetch(`${base}/absent-page`, {
        redirect: 'manual',
      });
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain('Fixture missing');
      expect(
        (await fetch(`${base}/absent.xml`, { redirect: 'manual' })).status,
      ).toBe(404);
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* already closed */
        }
      }
      const timer = setTimeout(() => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already closed */
          }
        }
      }, 5000);
      timer.unref();
      await close;
      clearTimeout(timer);
    }
  });
});
