import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  DomainContext,
  DomainReport,
} from '../../scripts/cloudflare/verify-domain.mjs';

const workflow = await import(
  new URL('../../scripts/cloudflare/workflow.mjs', import.meta.url).href
);
const state = await import(
  new URL('../../scripts/cloudflare/state.mjs', import.meta.url).href
);
const io = await import(
  new URL('../../scripts/cloudflare/io.mjs', import.meta.url).href
);
const { CloudflareError } = await import(
  new URL('../../scripts/cloudflare/errors.mjs', import.meta.url).href
);
const execute = promisify(execFile);
const roots: string[] = [];
const domain = 'https://blog.example.com/';
const target = {
  schemaVersion: 1,
  accountId: 'a'.repeat(32),
  workerName: 'fixture-blog',
  bucketName: 'fixture-assets',
  workersPlan: 'free',
};
const stamp = '2026-10-26T07:00:00.000Z';
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function put(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, path), JSON.stringify(value), { mode: 0o600 });
}
async function json(root: string, path: string) {
  return JSON.parse(await readFile(join(root, path), 'utf8')) as Record<
    string,
    unknown
  >;
}
async function fixture() {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), 'alfred-domain-workflow-'),
  );
  roots.push(repositoryRoot);
  const deploymentId = randomUUID();
  const root = join(repositoryRoot, '.alfred/deployments', deploymentId);
  const files = [
    {
      path: 'index.html',
      kind: 'file',
      target: 'worker',
      byteSize: 0,
      sha256: io.digest(''),
      mime: 'text/html',
    },
  ];
  const manifest = {
    schemaVersion: 1,
    artifactDigest: 'b'.repeat(64),
    filesDigest: io.digest(files),
    siteUrl: domain,
    build: { jobId: randomUUID(), snapshotRevision: 'c'.repeat(64) },
    files,
  };
  const journal = {
    schemaVersion: 1,
    deploymentId,
    target,
    phase: 'complete',
    uploadStatus: 'uploaded',
    domainVerification: 'passed',
    domainReport: { status: 'passed', checkedAt: stamp, domain },
    manifestDigest: io.digest(manifest),
    artifactDigest: manifest.artifactDigest,
    r2: { prepared: true, records: [] },
    worker: {
      status: 'uploaded',
      after: { versionId: randomUUID(), deploymentId: randomUUID() },
    },
  };
  state.rememberUploadProof({ deploymentId, journal });
  await put(root, 'manifest.json', manifest);
  await put(root, 'journal.json', journal);
  await put(root, 'receipt.json', journal);
  await put(
    repositoryRoot,
    `.alfred/reports/cloudflare/${deploymentId}/domain-verification.json`,
    { status: 'passed', domain, checkedAt: stamp },
  );
  return { repositoryRoot, root, deploymentId, journal, config: target };
}
function report(
  context: DomainContext,
  status: 'passed' | 'failed' | 'cancelled' = 'passed',
  partial = false,
): DomainReport {
  return {
    schemaVersion: 1,
    deploymentId: context.deploymentId,
    domain,
    scope: 'automatic',
    status,
    partial,
    startedAt: stamp,
    completedAt: stamp,
    platform: 'linux',
    nodeVersion: process.versions.node,
    checks: [
      { code: 'file', path: '/', status: 'passed' },
      ...(status !== 'passed'
        ? [
            {
              code: 'verification-failed',
              path: '/articles/',
              status: 'failed' as const,
              errorCode:
                status === 'cancelled'
                  ? 'CLOUDFLARE_CANCELLED'
                  : 'CLOUDFLARE_DOMAIN_CHECK_FAILED',
            },
          ]
        : []),
    ],
    requiresManualVerification: ['cloud-connector-and-no-script-routes'],
  };
}
async function savedReport(f: Awaited<ReturnType<typeof fixture>>) {
  return json(
    f.repositoryRoot,
    `.alfred/reports/cloudflare/${f.deploymentId}/domain-verification.json`,
  );
}

describe('Cloudflare domain verification attempt persistence', () => {
  it('persists pending before invoking the verifier and replaces the old passed summary for this attempt', async () => {
    const f = await fixture();
    const verifyDomain = vi.fn(
      async (context: DomainContext, normalized: string) => {
        expect(normalized).toBe(domain);
        for (const name of ['journal.json', 'receipt.json']) {
          const current = await json(f.root, name);
          expect(current.domainVerification).toBe('pending');
          expect(current.domainReport).toMatchObject({
            status: 'pending',
            domain,
          });
          expect(current.domainReport).not.toHaveProperty('checkedAt');
        }
        return report(context);
      },
    );
    const result = await workflow.runDomainVerification({
      ...f,
      domain: 'BLOG.example.com',
      dependencies: { verifyDomain },
    });
    expect(verifyDomain).toHaveBeenCalledOnce();
    expect(result.report.status).toBe('passed');
    const current = await json(f.root, 'journal.json');
    expect(current.domainVerification).toBe('passed');
    expect(current.domainReport).toMatchObject({
      status: 'passed',
      domain,
      manualVerification: 'pending',
    });
    expect(await savedReport(f)).toMatchObject({
      status: 'passed',
      domain,
      attemptId: expect.any(String),
    });
  });

  it('persists ordinary partial failure reports without claiming success', async () => {
    const f = await fixture();
    const result = await workflow.runDomainVerification({
      ...f,
      domain,
      dependencies: {
        verifyDomain: async (context: DomainContext) =>
          report(context, 'failed'),
      },
    });
    expect(result.report.status).toBe('failed');
    expect((await json(f.root, 'receipt.json')).domainVerification).toBe(
      'failed',
    );
    expect(await savedReport(f)).toMatchObject({
      status: 'failed',
      checks: expect.arrayContaining([
        expect.objectContaining({ code: 'file', status: 'passed' }),
        expect.objectContaining({ status: 'failed' }),
      ]),
    });
  });

  it('persists completed checks and a cancelled terminal result before rethrowing cancellation', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const operation = workflow.runDomainVerification({
      ...f,
      domain,
      signal: controller.signal,
      dependencies: {
        verifyDomain: async (context: DomainContext) => {
          controller.abort();
          const error = new CloudflareError(
            'CLOUDFLARE_CANCELLED',
            '驗收已取消。',
          );
          error.verificationReport = report(context, 'cancelled', true);
          throw error;
        },
      },
    });
    await expect(operation).rejects.toMatchObject({
      code: 'CLOUDFLARE_CANCELLED',
    });
    expect(controller.signal.aborted).toBe(true);
    const saved = await savedReport(f);
    expect(saved).toMatchObject({
      status: 'cancelled',
      partial: true,
      domain,
      checks: expect.arrayContaining([
        expect.objectContaining({ code: 'file', status: 'passed' }),
      ]),
    });
    for (const name of ['journal.json', 'receipt.json']) {
      const current = await json(f.root, name);
      expect(current.domainVerification).toBe('failed');
      expect(current.domainReport).toMatchObject({
        status: 'cancelled',
        partial: true,
        domain,
      });
      expect(current.uploadProof).toEqual(
        (f.journal as Record<string, unknown>).uploadProof,
      );
    }
  });

  it('persists a safe failed result and still rejects unexpected top-level errors', async () => {
    const f = await fixture();
    await expect(
      workflow.runDomainVerification({
        ...f,
        domain,
        dependencies: {
          verifyDomain: async () => {
            throw new Error('fixture-secret-stack-path');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_DOMAIN_CHECK_FAILED' });
    const saved = await savedReport(f);
    expect(saved).toMatchObject({ status: 'failed', partial: true, domain });
    expect(JSON.stringify(saved)).not.toContain('fixture-secret-stack-path');
    expect((await json(f.root, 'journal.json')).domainVerification).toBe(
      'failed',
    );
  });

  it('rejects an invalid raw domain before changing the old record or invoking any verifier', async () => {
    const f = await fixture();
    const before = await readFile(join(f.root, 'journal.json'), 'utf8');
    const oldReport = await savedReport(f);
    const verifyDomain = vi.fn();
    await expect(
      workflow.runDomainVerification({
        ...f,
        domain: 'https://user:fixture-secret@blog.example.com/?token=secret',
        dependencies: { verifyDomain },
      }),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_DOMAIN_INVALID' });
    expect(verifyDomain).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, 'journal.json'), 'utf8')).toBe(before);
    expect(await savedReport(f)).toEqual(oldReport);
    expect(await readFile(join(f.root, 'receipt.json'), 'utf8')).not.toContain(
      'fixture-secret',
    );
  });

  it('leaves the new attempt pending after abrupt process termination instead of retaining old passed', async () => {
    const f = await fixture();
    const source = `const {runDomainVerification}=await import(process.argv[1]);const options=JSON.parse(process.argv[2]);await runDomainVerification({...options,dependencies:{verifyDomain:async()=>{process.exit(77);}}});`;
    await expect(
      execute(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          source,
          new URL('../../scripts/cloudflare/workflow.mjs', import.meta.url)
            .href,
          JSON.stringify({
            repositoryRoot: f.repositoryRoot,
            config: target,
            deploymentId: f.deploymentId,
            domain,
          }),
        ],
        { timeout: 15_000 },
      ),
    ).rejects.toMatchObject({ code: 77 });
    for (const name of ['journal.json', 'receipt.json']) {
      const current = await json(f.root, name);
      expect(current.domainVerification).toBe('pending');
      expect(current.domainReport).toMatchObject({
        status: 'pending',
        domain,
        startedAt: expect.any(String),
        attemptId: expect.any(String),
      });
    }
  });
});
