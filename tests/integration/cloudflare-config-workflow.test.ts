import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const config = await import(
  new URL('../../scripts/cloudflare/config.mjs', import.meta.url).href
);
const artifact = await import(
  new URL('../../scripts/cloudflare/artifact.mjs', import.meta.url).href
);
const state = await import(
  new URL('../../scripts/cloudflare/state.mjs', import.meta.url).href
);
const io = await import(
  new URL('../../scripts/cloudflare/io.mjs', import.meta.url).href
);
const workflow = await import(
  new URL('../../scripts/cloudflare/workflow.mjs', import.meta.url).href
);
const execute = promisify(execFile);
const roots: string[] = [];
const target = {
  schemaVersion: 1,
  accountId: 'a'.repeat(32),
  workerName: 'fixture-blog',
  bucketName: 'fixture-assets',
  workersPlan: 'free',
};
const credentials = {
  CLOUDFLARE_API_TOKEN: 'fixture-worker-credential',
  R2_ACCESS_KEY_ID: 'fixture-access-key-id',
  R2_SECRET_ACCESS_KEY: 'fixture-secret-key-value',
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const privateWrite = async (root: string, path: string, value: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, path), value, { mode: 0o600 });
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-cloudflare-flow-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('Cloudflare 設定與命令邊界', () => {
  it('接受既有四欄與選填付費方案，嚴格拒絕未知欄位', () => {
    const { workersPlan, ...four } = target;
    void workersPlan;
    expect(config.parseConfig(JSON.stringify(four)).workersPlan).toBe('free');
    expect(
      config.parseConfig(JSON.stringify({ ...four, workersPlan: 'paid' }))
        .workersPlan,
    ).toBe('paid');
    expect(() =>
      config.parseConfig(
        JSON.stringify({ ...target, endpoint: 'https://example.invalid' }),
      ),
    ).toThrow();
  });
  it.each([
    { accountId: 'invalid' },
    { schemaVersion: 2 },
    { workerName: 'x.example' },
    { workerName: '-bad' },
    { bucketName: 'a' },
    { bucketName: 'xn--bucket' },
    { workersPlan: 'enterprise' },
  ])('拒絕不合法設定 %j', (changes) => {
    expect(() =>
      config.parseConfig(JSON.stringify({ ...target, ...changes })),
    ).toThrow();
  });
  it('拒絕重複、插值、缺漏與placeholder憑證，錯誤不帶值', () => {
    const valid = Object.entries(credentials)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    expect(config.parseCredentials(valid)).toEqual(credentials);
    for (const text of [
      valid + '\nCLOUDFLARE_API_TOKEN=second-fixture-value',
      valid + '\nUNKNOWN=unrelated',
      valid.replace(credentials.CLOUDFLARE_API_TOKEN, '$(do-not-run)'),
      valid.replace(
        credentials.R2_SECRET_ACCESS_KEY,
        'YOUR_R2_SECRET_ACCESS_KEY',
      ),
      valid.split('\n').slice(0, 2).join('\n'),
    ]) {
      try {
        config.parseCredentials(text);
        throw new Error('should reject');
      } catch (error) {
        expect((error as Error).message).not.toContain(
          credentials.CLOUDFLARE_API_TOKEN,
        );
        expect((error as Error).message).not.toContain(
          credentials.R2_SECRET_ACCESS_KEY,
        );
        expect((error as { code: string }).code).toBe(
          'CLOUDFLARE_CREDENTIAL_INVALID',
        );
      }
    }
  });
  it('設定權限與symlink守門，不放寬既有權限', async () => {
    const root = await fixture();
    await privateWrite(root, 'cloudflare.config.json', JSON.stringify(target));
    expect(await config.loadConfig(root)).toEqual(target);
    await chmod(join(root, 'cloudflare.config.json'), 0o644);
    await expect(config.loadConfig(root)).rejects.toMatchObject({
      code: 'CLOUDFLARE_PERMISSIONS',
    });
    await rm(join(root, 'cloudflare.config.json'));
    await privateWrite(root, 'other.json', JSON.stringify(target));
    await symlink('other.json', join(root, 'cloudflare.config.json'));
    await expect(config.loadConfig(root)).rejects.toMatchObject({
      code: 'CLOUDFLARE_PATH_INVALID',
    });
    expect((await lstat(join(root, 'other.json'))).mode & 0o777).toBe(0o600);
  });
  it('命令拒絕重複參數、任意路徑與不適用旗標', () => {
    expect(config.parseArguments(['deploy', '--dry-run'])).toMatchObject({
      command: 'deploy',
      dryRun: true,
    });
    for (const args of [
      ['deploy', '--dry-run', '--dry-run'],
      ['status', '--deployment', '../../outside'],
      ['verify', '--deployment', randomUUID()],
      ['restore', '--dry-run'],
      ['deploy', '--endpoint', 'http://127.0.0.1'],
    ])
      expect(() => config.parseArguments(args)).toThrow();
  });
  it('CLI help不讀設定，錯誤無stack或認證', async () => {
    const cli = new URL('../../scripts/deploy-cloudflare.mjs', import.meta.url);
    expect(
      (await execute(process.execPath, [cli.pathname, '--help'])).stdout,
    ).toContain('dry-run');
    await expect(
      execute(process.execPath, [cli.pathname, 'deploy', '--unknown']),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('CLOUDFLARE_ARGUMENT_INVALID'),
    });
  });
});

function initialJournal(deploymentId: string) {
  return {
    schemaVersion: 1,
    deploymentId,
    target: { ...target },
    startedAt: '2026-10-26T00:00:00.000Z',
    endedAt: null,
    uploadStatus: 'running',
    domainVerification: 'pending',
    phase: 'preflight',
    manifestDigest: null,
    r2: null,
    worker: null,
    diagnostics: [],
  };
}

describe('Cloudflare 部署紀錄原子初始化', () => {
  it('先備妥私有journal及receipt再啟用正式目錄，內容與權限一致', async () => {
    const root = await fixture(),
      id = randomUUID(),
      journal = initialJournal(id);
    const directory = await state.deploymentRoot(root, id, journal);
    expect(directory).toBe(join(root, '.alfred/deployments', id));
    expect((await readdir(directory)).sort()).toEqual([
      'journal.json',
      'receipt.json',
    ]);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    for (const name of ['journal.json', 'receipt.json']) {
      expect(JSON.parse(await readFile(join(directory, name), 'utf8'))).toEqual(
        journal,
      );
      expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
    await expect(
      lstat(join(root, '.alfred/deployment-initialization', id)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await state.loadDeployment(root, id, target)).manifestDocument,
    ).toBeNull();
    await expect(state.rejectUnresolved(root, target)).rejects.toMatchObject({
      code: 'CLOUDFLARE_RECOVERY_REQUIRED',
    });
  });

  it.each(['before-journal', 'after-journal', 'before-activate'])(
    '初始化%s中斷保留孤件，後續新部署不被誤擋且不重用孤件',
    async (interruption) => {
      const root = await fixture(),
        id = randomUUID(),
        failure = new Error('fixture-initialization-interrupted');
      await expect(
        state.deploymentRoot(root, id, initialJournal(id), {
          fault: async (phase: string, directory: string) => {
            if (phase !== interruption) return;
            if (phase === 'before-journal')
              await writeFile(
                join(directory, 'journal.json.fixture.tmp'),
                '{"partial":',
                { mode: 0o600 },
              );
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      await expect(
        lstat(join(root, '.alfred/deployments', id)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const initialized = join(root, '.alfred/deployment-initialization', id);
      const evidence = (await readdir(initialized)).sort();
      expect(evidence.length).toBeGreaterThan(0);
      await expect(
        state.rejectUnresolved(root, target),
      ).resolves.toBeUndefined();
      await expect(
        state.deploymentRoot(root, id, initialJournal(id)),
      ).rejects.toMatchObject({ code: 'CLOUDFLARE_INITIALIZATION_EXISTS' });
      const next = randomUUID();
      const active = await state.deploymentRoot(
        root,
        next,
        initialJournal(next),
      );
      expect(
        JSON.parse(await readFile(join(active, 'journal.json'), 'utf8'))
          .deploymentId,
      ).toBe(next);
      expect((await readdir(initialized)).sort()).toEqual(evidence);
    },
  );

  it.each([false, true])(
    '既有正式目錄empty=%s不會被覆寫或當成可忽略初始化孤件',
    async (empty) => {
      const root = await fixture(),
        id = randomUUID();
      const directory = await io.privateDirectory(
        root,
        `.alfred/deployments/${id}`,
      );
      if (!empty)
        await writeFile(
          join(directory, 'unknown.txt'),
          'preserve existing data',
          { mode: 0o600 },
        );
      await expect(
        state.deploymentRoot(root, id, initialJournal(id)),
      ).rejects.toMatchObject({ code: 'CLOUDFLARE_DEPLOYMENT_EXISTS' });
      expect((await readdir(directory)).sort()).toEqual(
        empty ? [] : ['unknown.txt'],
      );
      if (!empty)
        expect(await readFile(join(directory, 'unknown.txt'), 'utf8')).toBe(
          'preserve existing data',
        );
      await expect(state.rejectUnresolved(root, target)).rejects.toMatchObject({
        code: 'CLOUDFLARE_RECOVERY_REQUIRED',
      });
    },
  );

  it('啟用前目的地被建立時保留雙方證據，不覆寫既有資料', async () => {
    const root = await fixture(),
      id = randomUUID();
    const directory = join(root, '.alfred/deployments', id);
    await expect(
      state.deploymentRoot(root, id, initialJournal(id), {
        fault: async (phase: string) => {
          if (phase !== 'before-activate') return;
          await mkdir(directory, { mode: 0o700 });
          await writeFile(
            join(directory, 'unknown.txt'),
            'concurrent fixture',
            { mode: 0o600 },
          );
        },
      }),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_DEPLOYMENT_EXISTS' });
    expect(await readFile(join(directory, 'unknown.txt'), 'utf8')).toBe(
      'concurrent fixture',
    );
    expect(
      (
        await readdir(join(root, '.alfred/deployment-initialization', id))
      ).sort(),
    ).toEqual(['journal.json', 'receipt.json']);
  });

  it('取消發生於建立前或啟用前都不留下正式空紀錄', async () => {
    const root = await fixture(),
      id = randomUUID(),
      cancelled = new AbortController();
    cancelled.abort();
    await expect(
      state.deploymentRoot(root, id, initialJournal(id), {
        signal: cancelled.signal,
      }),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_CANCELLED' });
    await expect(lstat(join(root, '.alfred'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const during = new AbortController();
    await expect(
      state.deploymentRoot(root, id, initialJournal(id), {
        signal: during.signal,
        fault: (phase: string) => {
          if (phase === 'before-activate') during.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_CANCELLED' });
    await expect(
      lstat(join(root, '.alfred/deployments', id)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await readdir(join(root, '.alfred/deployment-initialization', id))
      ).sort(),
    ).toEqual(['journal.json', 'receipt.json']);
    await expect(state.rejectUnresolved(root, target)).resolves.toBeUndefined();
  });

  it('初始紀錄不符或啟用前內容遭改寫時拒絕，不假造正式來源', async () => {
    const root = await fixture(),
      id = randomUUID();
    await expect(
      state.deploymentRoot(root, id, {
        ...initialJournal(id),
        deploymentId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_JOURNAL_INVALID' });
    await expect(lstat(join(root, '.alfred'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      state.deploymentRoot(root, id, initialJournal(id), {
        fault: async (phase: string, directory: string) => {
          if (phase === 'before-activate')
            await writeFile(
              join(directory, 'journal.json'),
              JSON.stringify({
                ...initialJournal(id),
                uploadStatus: 'uploaded',
              }),
              { mode: 0o600 },
            );
        },
      }),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_INITIALIZATION_CHANGED' });
    await expect(
      lstat(join(root, '.alfred/deployments', id)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function artifactFixture() {
  const content = new Map([
    [
      'index.html',
      '<!doctype html><html><head><link rel="canonical" href="https://example.invalid/"></head><body>fixture</body></html>',
    ],
    ['rss.xml', '<?xml version="1.0"?><rss/>'],
    ['sitemap-index.xml', '<?xml version="1.0"?><sitemapindex/>'],
    ['search-index.json', '[]'],
    ['assets/test.css', 'body{color:green}'],
    ['media/example/image.webp', 'fixture-image-bytes'],
  ]);
  const entries = [...content]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([path, text]) => ({
      kind: 'file',
      path,
      byteSize: Buffer.byteLength(text),
      sha256: hash(text),
    }));
  const manifest = {
    schemaVersion: 1,
    entries,
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.byteSize, 0),
    digest: hash(JSON.stringify(entries)),
  };
  return { content, manifest };
}

describe('Cloudflare 正式產物分流與流程整合', () => {
  it('部分還原與未解Worker寫入不可被status誤報uploaded或已確定failed', () => {
    const r2 = { complete: true, unknown: false, conflicts: [] };
    const journal = {
      uploadStatus: 'recovery-required',
      r2: {
        restoreComplete: false,
        records: [
          { status: 'uploaded', restore: { status: 'restored' } },
          { status: 'uploaded', restore: null },
        ],
      },
      worker: { status: 'uploaded', stageArtifactInvalid: false },
    };
    expect(state.aggregateStatus(journal, r2, { status: 'uploaded' })).toBe(
      'recovery-required',
    );
    journal.r2.restoreComplete = true;
    journal.worker.status = 'restored';
    expect(state.aggregateStatus(journal, r2, { status: 'restored' })).toBe(
      'restored',
    );
    journal.worker.status = 'unknown';
    expect(state.aggregateStatus(journal, r2, { status: 'conflict' })).toBe(
      'unknown',
    );
    journal.worker.status = 'uploaded';
    journal.worker.stageArtifactInvalid = true;
    expect(state.aggregateStatus(journal, r2, { status: 'uploaded' })).toBe(
      'recovery-required',
    );
    journal.worker.status = 'restored';
    expect(state.aggregateStatus(journal, r2, { status: 'restored' })).toBe(
      'restored',
    );
  });
  it('完整互斥分流，保留XML/JSON且不改根產物', () => {
    const { manifest } = artifactFixture();
    const files = artifact.splitManifest(manifest, target);
    expect(
      files
        .filter((file: { target: string }) => file.target === 'r2')
        .map((file: { path: string }) => file.path),
    ).toEqual(['assets/test.css', 'media/example/image.webp']);
    expect(
      files.find((file: { path: string }) => file.path === 'rss.xml').target,
    ).toBe('worker');
    expect(manifest.entries.every((entry) => !('target' in entry))).toBe(true);
    expect(() =>
      artifact.splitManifest(
        {
          ...manifest,
          entries: [
            ...manifest.entries,
            {
              kind: 'file',
              path: '.env.private',
              byteSize: 1,
              sha256: hash('x'),
            },
          ],
          fileCount: 7,
          totalBytes: manifest.totalBytes + 1,
        },
        target,
      ),
    ).toThrow();
  });
  it('容量檢查依明示方案，單檔25MiB不可繞過', () => {
    const { manifest } = artifactFixture();
    const entry = {
      kind: 'file',
      path: 'extra.bin',
      byteSize: 25 * 1024 * 1024 + 1,
      sha256: hash('x'),
    };
    expect(() =>
      artifact.splitManifest(
        {
          ...manifest,
          entries: [...manifest.entries, entry],
          fileCount: 7,
          totalBytes: manifest.totalBytes + entry.byteSize,
        },
        target,
      ),
    ).toThrow();
    const entries = Array.from({ length: 20001 }, (_, index) => ({
      kind: 'file',
      path: index === 0 ? 'index.html' : `p${index}.html`,
      byteSize: 0,
      sha256: hash(''),
    }));
    const big = {
      ...manifest,
      entries,
      fileCount: entries.length,
      totalBytes: 0,
    };
    expect(() => artifact.splitManifest(big, target)).toThrow();
    expect(
      artifact.splitManifest(big, { ...target, workersPlan: 'paid' }),
    ).toHaveLength(20001);
  });

  async function setupFlow(
    dryRun: boolean,
    failure?: 'preflight' | 'backup' | 'worker',
  ) {
    const repositoryRoot = await fixture();
    const { content, manifest } = artifactFixture();
    const jobId = randomUUID(),
      snapshotRevision = hash('fixture-revision');
    const events: string[] = [];
    const proof = {
      jobId,
      result: { snapshotRevision },
      manifest,
      digest: manifest.digest,
    };
    const dependencies = {
      build: async () => {
        events.push('build');
        return { jobId, snapshotRevision };
      },
      artifacts: {
        current: async () => ({ current: { build: { jobId } } }),
        committedProof: async () => proof,
        captureCurrent: async ({ deploymentId }: { deploymentId: string }) => {
          events.push('capture');
          const root = join(
            repositoryRoot,
            '.alfred/deployments',
            deploymentId,
          );
          for (const [path, text] of content)
            await privateWrite(root, `source/${path}`, text);
          return {
            proof,
            manifest,
            resource: `.alfred/deployments/${deploymentId}/source`,
          };
        },
      },
      createWorker: () => ({
        preflight: async (ctx: {
          journal: Record<string, unknown>;
          save: () => Promise<void>;
        }) => {
          events.push('worker-preflight');
          if (failure === 'preflight') throw new Error('fixture-conflict');
          ctx.journal.worker = {
            before: null,
            after: null,
            status: 'prepared',
          };
          await ctx.save();
        },
        stage: async () => {
          events.push('worker-stage');
        },
        dryRun: async () => {
          events.push('wrangler-local');
        },
        deploy: async (ctx: {
          journal: Record<string, unknown>;
          save: () => Promise<void>;
        }) => {
          events.push('worker-deploy');
          if (failure === 'worker') throw new Error('fixture-fail');
          ctx.journal.worker = {
            before: null,
            after: { versionId: randomUUID(), deploymentId: randomUUID() },
            status: 'uploaded',
          };
          await ctx.save();
        },
      }),
      createR2: () => {
        events.push('r2-factory');
        return {
          checkBucket: async () => {
            events.push('r2-check');
          },
          prepare: async () => {
            events.push('all-backups');
            if (failure === 'backup') throw new Error('fixture-backup');
          },
          upload: async () => {
            events.push('r2-upload');
          },
          status: async () => ({
            complete: true,
            unknown: false,
            conflicts: [],
          }),
          destroy: () => {
            events.push('destroy');
          },
        };
      },
    };
    const operation = workflow.runDeployment({
      repositoryRoot,
      config: target,
      credentials: dryRun ? undefined : credentials,
      dryRun,
      dependencies,
    });
    return { operation, repositoryRoot, events };
  }

  it('dry-run完整Build/固定/分流但不建立R2 client或進行Worker遠端查詢', async () => {
    const f = await setupFlow(true);
    const result = await f.operation;
    expect(f.events).toEqual([
      'build',
      'capture',
      'worker-stage',
      'wrangler-local',
    ]);
    expect(result.journal.uploadStatus).toBe('dry-run');
    expect(result.journal.domainVerification).toBe('pending');
    const loaded = await state.loadDeployment(
      f.repositoryRoot,
      result.deploymentId,
      target,
    );
    expect(loaded.manifest).toHaveLength(6);
    const receipt = await readFile(join(result.root, 'receipt.json'), 'utf8');
    expect(receipt).not.toContain(credentials.R2_SECRET_ACCESS_KEY);
    await privateWrite(
      result.root,
      'manifest.json',
      JSON.stringify({
        ...result.manifestDocument,
        siteUrl: 'https://changed.example/',
      }),
    );
    await expect(
      state.loadDeployment(f.repositoryRoot, result.deploymentId, target),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_JOURNAL_INVALID' });
  });
  it('真部署先核Worker衝突，再全量備份、R2核對，最後更新Worker', async () => {
    const f = await setupFlow(false);
    const result = await f.operation;
    expect(f.events).toEqual([
      'r2-factory',
      'r2-check',
      'worker-preflight',
      'build',
      'capture',
      'worker-stage',
      'wrangler-local',
      'all-backups',
      'r2-upload',
      'worker-deploy',
      'destroy',
    ]);
    expect(result.journal.uploadStatus).toBe('uploaded');
    expect(result.journal.domainVerification).toBe('pending');
    expect(state.hasUploadProof(result.journal)).toBe(true);
    const confirmed = JSON.parse(JSON.stringify(result.journal));
    confirmed.uploadStatus = 'failed';
    expect(state.hasUploadProof(confirmed)).toBe(true);
    confirmed.uploadProof.manifestDigest = hash('unrelated-artifact');
    expect(state.hasUploadProof(confirmed)).toBe(false);
  });
  it('網域驗收共用部署鎖，且dry-run不會被當成可驗收的已發布網站', async () => {
    const f = await setupFlow(true),
      result = await f.operation;
    const { acquireFileLease } = await import('@foliohaven/server');
    const held = await acquireFileLease({
      root: f.repositoryRoot,
      name: `cloudflare-${io.digest([target.accountId, target.bucketName])}`,
      owner: 'fixture-test',
      nonBlocking: true,
    });
    expect(held).not.toBeNull();
    try {
      await expect(
        workflow.runDomainVerification({
          repositoryRoot: f.repositoryRoot,
          config: target,
          deploymentId: result.deploymentId,
          domain: 'https://example.invalid',
        }),
      ).rejects.toMatchObject({ code: 'CLOUDFLARE_BUSY' });
    } finally {
      await held?.release();
    }
    await expect(
      workflow.runDomainVerification({
        repositoryRoot: f.repositoryRoot,
        config: target,
        deploymentId: result.deploymentId,
        domain: 'https://example.invalid',
      }),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_DOMAIN_NOT_READY' });
  });
  it('部分還原中斷→status保留待復原→重跑完成，且不依賴新版來源仍存在', async () => {
    const f = await setupFlow(false),
      result = await f.operation;
    const seed = await state.loadDeployment(
      f.repositoryRoot,
      result.deploymentId,
      target,
    );
    seed.journal.r2 = {
      prepared: true,
      restoreComplete: false,
      records: [
        { path: 'assets/test.css', status: 'uploaded', restore: null },
        { path: 'media/example/image.webp', status: 'uploaded', restore: null },
      ],
    };
    await seed.save();
    await rm(join(result.root, 'source'), { recursive: true });
    type Context = {
      journal: {
        r2: {
          restoreComplete: boolean;
          records: { restore: { status: string } | null }[];
        };
        worker: { status: string };
      };
      save: () => Promise<void>;
    };
    let interrupt = true;
    const events: string[] = [];
    const dependencies = {
      createR2: () => ({
        destroy: () => {},
        status: async () => ({ complete: true, unknown: false, conflicts: [] }),
        preflightRestore: async () => {
          events.push('r2-preflight');
        },
        restore: async (ctx: Context) => {
          events.push('r2-restore');
          const first = ctx.journal.r2.records[0];
          if (!first) throw new Error('fixture-missing-record');
          first.restore = { status: 'restored' };
          await ctx.save();
          if (interrupt) throw new Error('fixture-interrupted');
          for (const record of ctx.journal.r2.records)
            record.restore = { status: 'restored' };
          ctx.journal.r2.restoreComplete = true;
          await ctx.save();
        },
      }),
      createWorker: () => ({
        status: async (ctx: Context) => ({ status: ctx.journal.worker.status }),
        preflightRestore: async () => {
          events.push('worker-preflight');
        },
        restore: async (ctx: Context) => {
          events.push('worker-restore');
          ctx.journal.worker.status = 'restored';
          await ctx.save();
          return { restored: true };
        },
      }),
    };
    const run = (command: string) =>
      workflow.runRecorded({
        repositoryRoot: f.repositoryRoot,
        config: target,
        credentials,
        command,
        deploymentId: result.deploymentId,
        dependencies,
      });
    await expect(run('restore')).rejects.toThrow('fixture-interrupted');
    expect(events).toEqual(['worker-preflight', 'r2-preflight', 'r2-restore']);
    expect((await run('status')).journal.uploadStatus).toBe(
      'recovery-required',
    );
    interrupt = false;
    expect((await run('restore')).journal.uploadStatus).toBe('restored');
    expect(events.slice(-4)).toEqual([
      'worker-preflight',
      'r2-preflight',
      'r2-restore',
      'worker-restore',
    ]);
    expect((await run('status')).journal.uploadStatus).toBe('restored');
  });
  it.each(['preflight', 'backup', 'worker'] as const)(
    '失敗階段%s不越過後續副作用並保留安全紀錄',
    async (failure) => {
      const f = await setupFlow(false, failure);
      await expect(f.operation).rejects.toThrow();
      if (failure === 'preflight') expect(f.events).not.toContain('build');
      if (failure === 'backup') expect(f.events).not.toContain('r2-upload');
      expect(f.events.at(-1)).toBe('destroy');
    },
  );
  it('未知或未完成部署阻擋後續發布，不能因重跑就覆蓋', async () => {
    const root = await fixture(),
      id = randomUUID();
    await io.privateDirectory(root, `.alfred/deployments/${id}`);
    await io.atomicJson(root, `.alfred/deployments/${id}/journal.json`, {
      schemaVersion: 1,
      deploymentId: id,
      target,
      uploadStatus: 'unknown',
    });
    await expect(state.rejectUnresolved(root, target)).rejects.toMatchObject({
      code: 'CLOUDFLARE_RECOVERY_REQUIRED',
    });
    await expect(
      state.rejectUnresolved(root, { ...target, workerName: 'other-worker' }),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_RECOVERY_REQUIRED' });
  });
});
