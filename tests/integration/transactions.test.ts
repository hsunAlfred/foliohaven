import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RecoveryDetailSchema } from '@foliohaven/core';
import {
  FileRepository,
  RepositoryError,
  etagForResources,
} from '../../server/src/files/index.js';
import type {
  CommitRequest,
  FaultPhase,
  ReadSession,
  RepositoryOptions,
} from '../../server/src/files/index.js';
const roots: string[] = [];
const children = new Set<ChildProcess>();
const keys = [
  'content/articles/example/content.html',
  'content/articles/example/meta.json',
];
const old = ['<p>old</p>\n', '{"status":"draft","title":"old"}\n'];
const next = ['<p>new</p>\n', '{"status":"draft","title":"new"}\n'];
const digest = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex');
const sourceRevision = async () => digest('fixed-build-inputs');
let productionDigest = '';
async function formalDigest(): Promise<string> {
  const hash = createHash('sha256');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const visit = async (resource: string): Promise<void> => {
    const path = join(root, resource);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        hash.update(`${resource}:missing\n`);
        return;
      }
      throw error;
    }
    hash.update(
      `${resource}:${stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'}\n`,
    );
    if (stat.isDirectory())
      for (const name of (await readdir(path)).sort())
        await visit(`${resource}/${name}`);
    else if (stat.isFile())
      for await (const chunk of createReadStream(path))
        hash.update(chunk as Buffer);
  };
  for (const key of ['content', 'media/source', 'dist']) await visit(key);
  return hash.digest('hex');
}
beforeAll(async () => {
  productionDigest = await formalDigest();
});
afterAll(async () => {
  expect(await formalDigest(), '交易測試不得變更正式來源與dist').toBe(
    productionDigest,
  );
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      child.kill('SIGKILL');
      await done;
    }
  }
  children.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  options: Omit<RepositoryOptions, 'repositoryRoot'> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'alfred-transactions-'));
  roots.push(root);
  await mkdir(join(root, 'content/articles/example'), { recursive: true });
  await mkdir(join(root, 'media/source'), { recursive: true });
  for (const [index, key] of keys.entries())
    await writeFile(join(root, key), required(old[index]));
  await writeFile(
    join(root, 'content/site.json'),
    JSON.stringify({
      siteName: '測試站',
      siteDescription: '測試說明',
      siteUrl: 'https://example.invalid/',
      author: { name: '測試作者' },
    }),
  );
  await writeFile(join(root, 'content/categories.json'), '[]\n');
  await writeFile(join(root, 'content/tags.json'), '[]\n');
  const repository = new FileRepository({ repositoryRoot: root, ...options });
  await repository.initialize();
  return { root, repository };
}
async function request(
  repository: FileRepository,
  values = next,
): Promise<CommitRequest> {
  return repository.withConsistentRead(async (session) => ({
    kind: 'save',
    precondition: { ifMatch: await session.etag(keys), resourceKeys: keys },
    changes: await Promise.all(
      keys.map(async (resourceKey, index) => ({
        resourceKey,
        expectedRevision: (await session.read(resourceKey))?.revision ?? null,
        content: Buffer.from(required(values[index])),
      })),
    ),
  }));
}
async function actual(root: string) {
  return Promise.all(keys.map((key) => readFile(join(root, key), 'utf8')));
}
function worker(root: string, mode: string, phase = '', ...args: string[]) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(
        new URL('../fixtures/transactions/worker.mts', import.meta.url),
      ),
      root,
      mode,
      phase,
      ...args,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.add(child);
  let output = '';
  let error = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    error += chunk.toString();
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    child,
    done,
    output: () => output,
    error: () => error,
    ready: async () => {
      await new Promise<void>((resolve, reject) => {
        if (output.includes('READY')) {
          resolve();
          return;
        }
        const timer = setTimeout(
          () => reject(new Error('fixture lease timeout')),
          10000,
        );
        child.stdout.on('data', () => {
          if (output.includes('READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('close', () => {
          clearTimeout(timer);
          reject(new Error(`fixture exited: ${error}`));
        });
      });
    },
  };
}
async function resolution(
  repository: FileRepository,
  id: string,
  choice:
    | 'keep-current'
    | 'restore-backup'
    | 'apply-prepared'
    | 'restore-trash'
    | 'purge-trash',
) {
  const detail = await repository.recovery(id);
  return repository.resolveRecovery(
    id,
    {
      choice,
      revisions: detail.value.resources.map((item) => ({
        resourceKey: item.resourceKey,
        revision: item.current.revision,
      })),
    },
    detail.etag,
  );
}
describe('SAVE-01：raw revision、精確 precondition、編輯模式與一致讀取', () => {
  it('兩檔 bytes 與明確長度界線決定ETag，語意相同的格式改變仍使舊版412', async () => {
    const { root, repository } = await fixture();
    const save = await request(repository);
    await writeFile(
      join(root, required(keys[1])),
      ' {"status":"draft","title":"old"}\n',
    );
    await expect(repository.commit(save)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      status: 412,
    });
    expect(await readFile(join(root, required(keys[0])), 'utf8')).toBe(old[0]);
    expect(
      await repository.withConsistentRead((session) => session.etag(keys)),
    ).not.toBe(required(save.precondition).ifMatch);
  });
  it('缺If-Match428，萬用與弱ETag400；預期bytes獨立核對', async () => {
    const { repository } = await fixture();
    const save = await request(repository);
    await expect(
      repository.commit({
        ...save,
        precondition: { ifMatch: undefined, resourceKeys: keys },
      }),
    ).rejects.toMatchObject({ status: 428 });
    for (const ifMatch of [
      '*',
      `W/${required(save.precondition).ifMatch}`,
      '"invalid"',
    ])
      await expect(
        repository.commit({
          ...save,
          precondition: { ifMatch, resourceKeys: keys },
        }),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      repository.commit({
        ...save,
        changes: save.changes.map((change) => ({
          ...change,
          expectedRevision: digest('stale'),
        })),
      }),
    ).rejects.toMatchObject({ status: 412 });
  });
  it('同時保存只有一個成功，後者412；generation持久且改回原值仍累加', async () => {
    const { root, repository } = await fixture();
    const save = await request(repository);
    const second = new FileRepository({ repositoryRoot: root });
    const results = await Promise.allSettled([
      repository.commit(save),
      second.commit(save),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = results.find((item) => item.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      status: 412,
    });
    const firstGeneration = (await repository.initialize()).generation;
    await repository.commit(await request(repository, old));
    expect(await actual(root)).toEqual(old);
    expect((await second.initialize()).generation).toBe(firstGeneration + 1);
    expect(await repository.noteExternalChange()).toBe(firstGeneration + 2);
  });
  it('一致讀者等待整筆交易，不能觀察到只更新HTML的半套狀態', async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { root, repository } = await fixture({
      fault: async (event) => {
        if (event.phase === 'after-install' && event.resourceKey === keys[0]) {
          entered?.();
          await gate;
        }
      },
    });
    const saving = repository.commit(await request(repository));
    await paused;
    const reader = new FileRepository({ repositoryRoot: root });
    let observed = false;
    const reading = reader.withConsistentRead(async (session) => {
      observed = true;
      return Promise.all(
        keys.map(async (key) => (await session.read(key))?.bytes.toString()),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(observed).toBe(false);
    release?.();
    await saving;
    expect(await reading).toEqual(next);
  });
  it('workspace ETag包含模式／狀態版本，IDE阻擋mutation但允許build讀取與模式切換', async () => {
    const { repository } = await fixture();
    const save = await request(repository);
    const before = await repository.workspace({ scanInputs: sourceRevision });
    const ide = await repository.setEditMode('ide', before.etag, {
      scanInputs: sourceRevision,
    });
    expect(ide.value.revision).toBe(before.value.revision);
    expect(ide.etag).not.toBe(before.etag);
    await expect(
      repository.setEditMode('studio', before.etag, {
        scanInputs: sourceRevision,
      }),
    ).rejects.toMatchObject({ status: 412 });
    await expect(repository.commit(save)).rejects.toMatchObject({
      code: 'IDE_EDIT_MODE',
    });
    expect(
      await repository.withBuildInputLock((session) => session.etag(keys)),
    ).toBe(required(save.precondition).ifMatch);
    const studio = await repository.setEditMode('studio', ide.etag, {
      scanInputs: sourceRevision,
    });
    expect(studio.value.editMode).toBe('studio');
    await repository.commit(save);
  });
  it('validation在同一鎖下檢查真實來源；拒絕候選完全不寫；過期workspace revision拒絕', async () => {
    const { root, repository } = await fixture();
    const save = await request(repository);
    await expect(
      repository.commit({
        ...save,
        validate: async (session) => {
          expect((await session.read(required(keys[0])))?.revision).toBe(
            digest(required(old[0])),
          );
          throw new RepositoryError('VALIDATION_FAILED', '候選不合法。', 422);
        },
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      repository.commit({
        ...save,
        workspacePrecondition: {
          revision: digest('stale'),
          scanInputs: sourceRevision,
        },
      }),
    ).rejects.toMatchObject({ status: 412 });
    expect(await actual(root)).toEqual(old);
  });
  it('ReadSession不可在解鎖後使用，既有Core loader與pageSchemas可在鎖內沿用', async () => {
    const { root, repository } = await fixture({
      pageSchemas: { about: z.strictObject({ title: z.string() }) },
    });
    await mkdir(join(root, 'content/pages'));
    await writeFile(join(root, 'content/pages/about.json'), '{"title":"關於"}');
    let expired: ReadSession | undefined;
    const content = await repository.withConsistentRead(async (session) => {
      expired = session;
      expect(await session.listArticleIds()).toEqual(['example']);
      return session.loadContent({ mode: 'preview' });
    });
    expect(content.pages.about).toEqual({ title: '關於' });
    await expect(
      required(expired).read(required(keys[0])),
    ).rejects.toMatchObject({
      code: 'READ_SESSION_CLOSED',
    });
  });
  it('受控key拒絕任意路徑、未登錄頁、encoded traversal和symlink，錯誤不洩漏絕對路徑', async () => {
    const { root, repository } = await fixture();
    for (const key of [
      '../secret',
      '/etc/passwd',
      'content/pages/unknown.json',
      'content/articles/%2e%2e/meta.json',
      'content/articles/example/../../site.json',
      'content\\site.json',
    ])
      await expect(
        repository.withConsistentRead((session) => session.read(key)),
      ).rejects.toMatchObject({ code: 'INVALID_RESOURCE_KEY' });
    await rm(join(root, required(keys[0])));
    await symlink('/etc/passwd', join(root, required(keys[0])));
    try {
      await repository.withConsistentRead((session) =>
        session.read(required(keys[0])),
      );
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryError);
      expect((error as Error).message).not.toContain(root);
      expect((error as RepositoryError).code).toBe('RESOURCE_SYMLINK');
    }
  });
  it('媒體stream暫存有上限、hash與不可任意指定的handle，成功寫入真實binary', async () => {
    const { root, repository } = await fixture();
    const bytes = Buffer.from([0, 255, 1, 2]);
    const id = randomUUID();
    const key = `media/source/${id}/original.png`;
    const binary = await repository.stageBinary(
      (async function* () {
        yield bytes.subarray(0, 2);
        yield bytes.subarray(2);
      })(),
      4,
    );
    expect(binary.revision).toBe(digest(bytes));
    await repository.commit({
      kind: 'create',
      changes: [{ resourceKey: key, expectedRevision: null, content: binary }],
    });
    expect(await readFile(join(root, key))).toEqual(bytes);
    await repository.discardBinary(binary);
    await expect(
      repository.stageBinary(
        (async function* () {
          yield bytes;
        })(),
        3,
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      repository.stageBinary(
        (async function* () {
          yield Buffer.alloc(0);
        })(),
        3,
      ),
    ).rejects.toMatchObject({ code: 'EMPTY_SOURCE' });
    expect(await readdir(join(root, '.alfred/staging'))).toEqual([]);
  });
});
describe('SAVE-02：真實跨程序鎖、階段中止與未知版本復原', () => {
  it('跨程序持鎖阻擋寫入，鎖timeout不強搶；持有程序SIGKILL後kernel回收', async () => {
    const { root, repository } = await fixture();
    const save = await request(repository);
    const lease = worker(root, 'hold');
    await lease.ready();
    const contender = new FileRepository({
      repositoryRoot: root,
      lockTimeoutMs: 100,
    });
    await expect(contender.commit(save)).rejects.toMatchObject({
      code: 'WORKSPACE_BUSY',
    });
    const inode = (await lstat(join(root, '.alfred/locks/writer.lock'))).ino;
    lease.child.kill('SIGKILL');
    await lease.done;
    await repository.commit(save);
    expect((await lstat(join(root, '.alfred/locks/writer.lock'))).ino).toBe(
      inode,
    );
  });
  const phases: FaultPhase[] = [
    'backup-file',
    'prepared-file',
    'prepared-journal',
    'verified-before-commit',
    'install-intent',
    'generation',
    'after-displace',
    'after-install',
    'per-file-journal',
    'committed-journal',
  ];
  for (const phase of phases)
    it(`真子程序在 ${phase} exit 後，重啟只得到完整舊版或完整新版`, async () => {
      const { root } = await fixture();
      const process = worker(root, 'commit', phase);
      expect(await process.done, process.error()).toBe(77);
      const recovered = new FileRepository({ repositoryRoot: root });
      expect((await recovered.initialize()).recoveryState).toBe('ready');
      const content = await actual(root);
      expect([old, next]).toContainEqual(content);
      const afterIntent = [
        'install-intent',
        'generation',
        'after-displace',
        'after-install',
        'per-file-journal',
        'committed-journal',
      ].includes(phase);
      expect(content).toEqual(afterIntent ? next : old);
      expect((await recovered.initialize()).generation).toBe(
        afterIntent ? 1 : 0,
      );
    });
  it('未知第三版完整保留，禁止一般寫入/build；模式可切換，人工選prepared另作新交易', async () => {
    let root = '';
    let injected = false;
    const result = await fixture({
      fault: async (event) => {
        if (event.phase === 'after-install' && !injected) {
          injected = true;
          await writeFile(
            join(root, required(keys[0])),
            '<p>external third</p>\n',
          );
        }
      },
    });
    root = result.root;
    const repository = result.repository;
    await expect(
      repository.commit(await request(repository)),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    const recovered = new FileRepository({ repositoryRoot: root });
    expect((await recovered.initialize()).recoveryState).toBe(
      'recovery-required',
    );
    await expect(
      recovered.withBuildInputLock(async () => true),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(
      recovered.commit(await request(recovered)),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const workspace = await recovered.workspace({ scanInputs: sourceRevision });
    await recovered.setEditMode('ide', workspace.etag, {
      scanInputs: sourceRevision,
    });
    const pending = await recovered.listRecoveries();
    expect(pending).toHaveLength(1);
    const id = required(pending[0]).id;
    const detail = await recovered.recovery(id);
    expect(RecoveryDetailSchema.safeParse(detail.value).success).toBe(true);
    const html = required(
      detail.value.resources.find((item) => item.resourceKey === keys[0]),
    );
    expect(html.base.text).toBe(old[0]);
    expect(html.current.text).toBe('<p>external third</p>\n');
    expect(html.prepared.text).toBe(next[0]);
    await resolution(recovered, id, 'apply-prepared');
    expect(await actual(root)).toEqual(next);
    expect((await recovered.initialize()).recoveryState).toBe('ready');
    expect((await recovered.recovery(id)).value.status).toBe('resolved');
    expect((await recovered.recovery(id)).value.choices).toContain(
      'apply-prepared',
    );
    await expect(
      resolution(recovered, id, 'keep-current'),
    ).rejects.toMatchObject({ code: 'RECOVERY_ALREADY_RESOLVED' });
    const observed = await readdir(
      join(root, `.alfred/transactions/${id}/observed`),
    );
    expect(
      observed.some((name) => name.endsWith(digest('<p>external third</p>\n'))),
    ).toBe(true);
  });
  it('復原要求完整current revisions與最新recovery ETag；不覆蓋後續IDE變更', async () => {
    let root = '';
    const result = await fixture({
      fault: async (event) => {
        if (event.phase === 'prepared-journal')
          await writeFile(join(root, required(keys[0])), '<p>third</p>');
      },
    });
    root = result.root;
    await expect(
      result.repository.commit(await request(result.repository)),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    const id = required((await result.repository.listRecoveries())[0]).id;
    const detail = await result.repository.recovery(id);
    const revisions = detail.value.resources.map((item) => ({
      resourceKey: item.resourceKey,
      revision: item.current.revision,
    }));
    await expect(
      result.repository.resolveRecovery(
        id,
        { choice: 'restore-backup', revisions: revisions.slice(0, 1) },
        detail.etag,
      ),
    ).rejects.toMatchObject({ status: 422 });
    await writeFile(join(root, required(keys[0])), '<p>fourth</p>');
    await expect(
      result.repository.resolveRecovery(
        id,
        { choice: 'restore-backup', revisions },
        detail.etag,
      ),
    ).rejects.toMatchObject({ status: 412 });
    expect((await actual(root))[0]).toBe('<p>fourth</p>');
    await resolution(
      new FileRepository({ repositoryRoot: root }),
      id,
      'restore-backup',
    );
    expect(await actual(root)).toEqual(old);
  });
  it('備份不與live共用inode；keep-current保留目前完整版本並解除阻擋', async () => {
    let root = '';
    const result = await fixture({
      fault: async (event) => {
        if (event.phase === 'prepared-journal')
          await writeFile(join(root, required(keys[0])), '<p>third</p>');
      },
    });
    root = result.root;
    await expect(
      result.repository.commit(await request(result.repository)),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    const id = required((await result.repository.listRecoveries())[0]).id;
    expect((await lstat(join(root, required(keys[0])))).ino).not.toBe(
      (await lstat(join(root, `.alfred/transactions/${id}/base/0`))).ino,
    );
    await resolution(result.repository, id, 'keep-current');
    expect((await actual(root))[0]).toBe('<p>third</p>');
    expect((await result.repository.initialize()).recoveryState).toBe('ready');
  });
  it('真實權限拒絕與rename失敗不回成功，保留所有已知或未知版本', async () => {
    const { root, repository } = await fixture();
    const save = await request(repository);
    await chmod(join(root, 'content/articles/example'), 0o500);
    try {
      await expect(repository.commit(save)).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      await chmod(join(root, 'content/articles/example'), 0o700);
    }
    const reopened = new FileRepository({ repositoryRoot: root });
    await reopened.initialize();
    expect([old, next]).toContainEqual(await actual(root));
    const second = await fixture({
      fault: async (event) => {
        if (event.phase === 'after-displace')
          await mkdir(join(second.root, required(event.resourceKey)));
      },
    });
    await expect(
      second.repository.commit(await request(second.repository)),
    ).rejects.toBeInstanceOf(Error);
    const journals = await readdir(join(second.root, '.alfred/transactions'));
    expect(
      await readFile(
        join(
          second.root,
          `.alfred/transactions/${required(journals[0])}/base/0`,
        ),
        'utf8',
      ),
    ).toBe(old[0]);
  });
  it('disk-full注入在durable prepared後中止，不宣稱成功且來源可復原', async () => {
    const { root, repository } = await fixture({
      fault: (event) => {
        if (event.phase === 'prepared-journal')
          throw Object.assign(new Error('fixture disk full'), {
            code: 'ENOSPC',
          });
      },
    });
    await expect(
      repository.commit(await request(repository)),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await actual(root)).toEqual(old);
    expect(
      (await new FileRepository({ repositoryRoot: root }).initialize())
        .recoveryState,
    ).toBe('ready');
  });
  it('committed operation關聯能在回應遺失/程序重啟後讀回，不把中斷候選當成功', async () => {
    const { root, repository } = await fixture({
      fault: (event) => {
        if (event.phase === 'committed-journal')
          throw new Error('fixture response lost');
      },
    });
    const operation = {
      id: randomUUID(),
      key: randomUUID(),
      payloadHash: digest('payload'),
      httpStatus: 201,
      resourceUrl: '/api/v1/articles/example',
    };
    await expect(
      repository.commit({ ...(await request(repository)), operation }),
    ).rejects.toThrow('fixture response lost');
    const reopened = new FileRepository({ repositoryRoot: root });
    await reopened.initialize();
    expect(await reopened.listCommittedOperations()).toEqual([operation]);
    expect(await actual(root)).toEqual(next);
  });
});
describe('SAVE-02：trash、還原與保留政策', () => {
  async function remove(repository: FileRepository) {
    const save = await request(repository);
    return repository.commit({
      ...save,
      kind: 'delete',
      trash: { kind: 'article', id: 'example' },
      changes: save.changes.map((item) => ({ ...item, content: null })),
    });
  }
  it('刪除進私有trash，還原整組bytes；同名新目錄或檔案一律409', async () => {
    const { root, repository } = await fixture();
    const removed = await remove(repository);
    await expect(
      lstat(join(root, 'content/articles/example')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(required((await repository.listRecoveries())[0]).kind).toBe('trash');
    await mkdir(join(root, 'content/articles/example'));
    await expect(
      resolution(repository, removed.transactionId, 'restore-trash'),
    ).rejects.toMatchObject({ code: 'TRASH_TARGET_EXISTS', status: 409 });
    await rm(join(root, 'content/articles/example'), { recursive: true });
    await resolution(repository, removed.transactionId, 'restore-trash');
    expect(await actual(root)).toEqual(old);
  });
  it('trash未滿30天不能purge，超過保留期仍須明確purge且無未解引用', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const { root, repository } = await fixture({ clock: () => now });
    const removed = await remove(repository);
    await expect(
      resolution(repository, removed.transactionId, 'purge-trash'),
    ).rejects.toMatchObject({ code: 'TRASH_RETENTION_REQUIRED' });
    now = new Date('2026-02-01T00:00:00Z');
    await repository.prune();
    expect(
      (await repository.recovery(removed.transactionId)).value.status,
    ).toBe('available');
    await resolution(repository, removed.transactionId, 'purge-trash');
    expect(
      (await repository.recovery(removed.transactionId)).value.status,
    ).toBe('resolved');
    await expect(
      lstat(join(root, `.alfred/transactions/${removed.transactionId}/base`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('成功備份至少7天且至少最近20筆，僅超過兩條件才自動prune', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const { repository } = await fixture({ clock: () => now });
    for (let index = 0; index < 22; index++) {
      await repository.commit(
        await request(repository, [
          `<p>${index}</p>\n`,
          `{"status":"draft","title":"${index}"}\n`,
        ]),
      );
      now = new Date(now.getTime() + 1000);
    }
    expect((await repository.prune()).removedTransactionIds).toHaveLength(0);
    now = new Date('2026-01-09T00:00:00Z');
    expect((await repository.prune()).removedTransactionIds).toHaveLength(2);
    expect((await repository.prune()).removedTransactionIds).toHaveLength(0);
  });
  it('二進位復原只下載journal映射fileId，不接受來源路徑，原始bytes未丟失', async () => {
    const { root, repository } = await fixture();
    const id = randomUUID();
    const key = `media/source/${id}/original.png`;
    const bytes = Buffer.from([0, 255, 1, 42]);
    await mkdir(join(root, `media/source/${id}`));
    await writeFile(join(root, key), bytes);
    const etag = await repository.withConsistentRead((session) =>
      session.etag([key]),
    );
    const removed = await repository.commit({
      kind: 'delete',
      precondition: { ifMatch: etag, resourceKeys: [key] },
      trash: { kind: 'media', id },
      changes: [
        { resourceKey: key, expectedRevision: digest(bytes), content: null },
      ],
    });
    const detail = await repository.recovery(removed.transactionId);
    const binary = required(required(detail.value.resources[0]).base.binary);
    const file = await repository.recoveryFile(
      removed.transactionId,
      binary.fileId,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(file.sha256).toBe(digest(bytes));
    await expect(
      repository.recoveryFile(removed.transactionId, '../base/0'),
    ).rejects.toMatchObject({ status: 404 });
    await resolution(repository, removed.transactionId, 'restore-trash');
    expect(await readFile(join(root, key))).toEqual(bytes);
  });
});
describe('SAVE-02：審查邊界、讀依賴與復原決議本身中止', () => {
  it('exclusive link安裝遇到最後瞬間新增的第三版，保留該版且不覆寫', async () => {
    let root = '';
    let once = false;
    const result = await fixture({
      fault: async (event) => {
        if (event.phase === 'before-install-link' && !once) {
          once = true;
          await writeFile(
            join(root, required(event.resourceKey)),
            '<p>last instant external</p>',
          );
        }
      },
    });
    root = result.root;
    await expect(
      result.repository.commit(await request(result.repository)),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    expect((await actual(root))[0]).toBe('<p>last instant external</p>');
    const id = required((await result.repository.listRecoveries())[0]).id;
    const detail = await result.repository.recovery(id);
    expect(required(detail.value.resources[0]).base.text).toBe(old[0]);
    expect(required(detail.value.resources[0]).prepared.text).toBe(next[0]);
    expect(required(detail.value.resources[0]).current.text).toBe(
      '<p>last instant external</p>',
    );
  });
  it('既有private目錄若group/world可讀會拒絕，不擴大或自行放寬權限', async () => {
    const { root } = await fixture();
    await chmod(join(root, '.alfred'), 0o755);
    const repository = new FileRepository({ repositoryRoot: root });
    await expect(repository.initialize()).rejects.toMatchObject({
      code: 'PRIVATE_DIRECTORY_PERMISSIONS',
    });
    expect((await lstat(join(root, '.alfred'))).mode & 0o777).toBe(0o755);
    await chmod(join(root, '.alfred'), 0o700);
  });
  for (const external of ['taxonomy-bytes', 'article-added'] as const)
    it(`loadContent的讀依賴在提交前核對 ${external}，不只核對寫入文章`, async () => {
      let root = '';
      const result = await fixture({
        fault: async (event) => {
          if (event.phase === 'verified-before-commit') {
            if (external === 'taxonomy-bytes')
              await writeFile(join(root, 'content/tags.json'), ' []\n');
            else {
              await mkdir(join(root, 'content/articles/added'));
              await writeFile(
                join(root, 'content/articles/added/meta.json'),
                '{"status":"draft"}',
              );
              await writeFile(
                join(root, 'content/articles/added/content.html'),
                '<p>added</p>',
              );
            }
          }
        },
      });
      root = result.root;
      const save = await request(result.repository);
      await expect(
        result.repository.commit({
          ...save,
          validate: async (session) => {
            await session.loadContent({ mode: 'preview' });
          },
        }),
      ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
      expect(await actual(root)).toEqual(old);
    });
  it('operation receipt原始response與ETag/Location持久保存，來源後續變更不改結果', async () => {
    const { root, repository } = await fixture();
    const operation = {
      id: randomUUID(),
      key: randomUUID(),
      payloadHash: digest('original payload'),
      httpStatus: 200,
      response: {
        id: 'example',
        contentHtml: required(next[0]),
        meta: { status: 'draft', title: 'new' },
      },
      headers: {
        ETag: `"${digest('original result')}"`,
        Location: '/api/v1/articles/example',
      },
    };
    await repository.commit({ ...(await request(repository)), operation });
    await repository.commit(await request(repository, old));
    expect(
      await new FileRepository({
        repositoryRoot: root,
      }).listCommittedOperations(),
    ).toEqual([operation]);
  });
  for (const phase of ['resolution-intent', 'resolution-committed'] as const)
    it(`restore-trash在 ${phase} 真程序中止後能恢復明確決議，沒有永遠pending的同名衝突`, async () => {
      const { root, repository } = await fixture();
      const save = await request(repository);
      const removed = await repository.commit({
        ...save,
        kind: 'delete',
        trash: { kind: 'article', id: 'example' },
        changes: save.changes.map((item) => ({ ...item, content: null })),
      });
      const process = worker(
        root,
        'resolve',
        phase,
        removed.transactionId,
        'restore-trash',
      );
      expect(await process.done, process.error()).toBe(77);
      const reopened = new FileRepository({ repositoryRoot: root });
      await reopened.initialize();
      if (phase === 'resolution-intent') {
        expect(
          (await reopened.recovery(removed.transactionId)).value.status,
        ).toBe('available');
        await resolution(reopened, removed.transactionId, 'restore-trash');
      }
      expect(
        (await reopened.recovery(removed.transactionId)).value.status,
      ).toBe('resolved');
      expect(await actual(root)).toEqual(old);
    });
  for (const phase of ['resolution-intent', 'purge-files'] as const)
    it(`purge-trash在 ${phase} 真程序中止，重啟依已持久確認決議完成清理`, async () => {
      const { root, repository } = await fixture({
        clock: () => new Date('2026-01-01T00:00:00Z'),
      });
      const save = await request(repository);
      const removed = await repository.commit({
        ...save,
        kind: 'delete',
        trash: { kind: 'article', id: 'example' },
        changes: save.changes.map((item) => ({ ...item, content: null })),
      });
      const process = worker(
        root,
        'resolve',
        phase,
        removed.transactionId,
        'purge-trash',
      );
      expect(await process.done, process.error()).toBe(77);
      const reopened = new FileRepository({ repositoryRoot: root });
      await reopened.initialize();
      expect(
        (await reopened.recovery(removed.transactionId)).value.status,
      ).toBe('resolved');
      await expect(
        lstat(join(root, `.alfred/transactions/${removed.transactionId}/base`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('fixture required value missing');
  return value;
}

describe('SAVE-02：搬移邊界未知版本與bounded I/O', () => {
  it('rename前第三版搬入displaced後完整保留；後來第四版不隱藏第三版preserved', async () => {
    let root = '';
    let once = false;
    const result = await fixture({
      fault: async (event) => {
        if (event.phase === 'before-displace' && !once) {
          once = true;
          await writeFile(
            join(root, required(event.resourceKey)),
            '<p>displaced third</p>',
          );
        }
      },
    });
    root = result.root;
    await expect(
      result.repository.commit(await request(result.repository)),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    expect((await actual(root))[0]).toBe('<p>displaced third</p>');
    await writeFile(join(root, required(keys[0])), '<p>later fourth</p>');
    const id = required((await result.repository.listRecoveries())[0]).id;
    const resource = required(
      (await result.repository.recovery(id)).value.resources[0],
    );
    expect(resource.base.text).toBe(old[0]);
    expect(resource.prepared.text).toBe(next[0]);
    expect(resource.current.text).toBe('<p>later fourth</p>');
    expect(resource.preserved.map((version) => version.text)).toContain(
      '<p>displaced third</p>',
    );
    await resolution(
      new FileRepository({ repositoryRoot: root }),
      id,
      'keep-current',
    );
    expect((await actual(root))[0]).toBe('<p>later fourth</p>');
  });
  it('未知二進位displaced由preserved fileId真正下載，不能以額外路徑偷讀', async () => {
    let root = '';
    let once = false;
    const id = randomUUID();
    const key = `media/source/${id}/original.png`;
    const result = await fixture({
      fault: async (event) => {
        if (event.phase === 'before-displace' && !once) {
          once = true;
          await writeFile(join(root, key), Buffer.from([3, 33, 255]));
        }
      },
    });
    root = result.root;
    await mkdir(join(root, `media/source/${id}`));
    await writeFile(join(root, key), Buffer.from([1, 11, 255]));
    const base = await result.repository.withConsistentRead(
      async (session) => ({
        etag: await session.etag([key]),
        revision: required(await session.read(key)).revision,
      }),
    );
    await expect(
      result.repository.commit({
        kind: 'save',
        precondition: { ifMatch: base.etag, resourceKeys: [key] },
        changes: [
          {
            resourceKey: key,
            expectedRevision: base.revision,
            content: Buffer.from([2, 22, 255]),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    await writeFile(join(root, key), Buffer.from([4, 44, 255]));
    const recoveryId = required(
      (await result.repository.listRecoveries())[0],
    ).id;
    const version = required(
      required(
        (await result.repository.recovery(recoveryId)).value.resources[0],
      ).preserved[0],
    );
    const binary = required(version.binary);
    const download = await result.repository.recoveryFile(
      recoveryId,
      binary.fileId,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([3, 33, 255]));
    expect(
      RecoveryDetailSchema.safeParse(
        (await result.repository.recovery(recoveryId)).value,
      ).success,
    ).toBe(true);
  });
  it('超限HTML於讀取前拒絕，壞UTF-8 private JSON只輸出安全診斷', async () => {
    const { root, repository } = await fixture();
    await writeFile(
      join(root, required(keys[0])),
      Buffer.alloc(5 * 1024 * 1024 + 1),
    );
    await expect(
      repository.withConsistentRead((session) =>
        session.read(required(keys[0])),
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE', status: 422 });
    await writeFile(
      join(root, '.alfred/workspace-state.json'),
      Buffer.from([255, 254, 253]),
    );
    try {
      await new FileRepository({ repositoryRoot: root }).initialize();
      throw new Error('expected private JSON rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_PRIVATE_JSON' });
      expect((error as Error).message).not.toContain(root);
    }
  });
});

describe('SAVE-02：受控資源寫入大小守門', () => {
  for (const [resourceKey, limit] of [
    ['content/articles/example/content.html', 5 * 1024 * 1024],
    ['content/articles/example/meta.json', 64 * 1024],
    ['content/site.json', 256 * 1024],
    ['content/tags.json', 4 * 1024 * 1024],
    ['content/categories.json', 4 * 1024 * 1024],
  ] as const)
    it(`${resourceKey}不可寫入超限且自身讀不回的候選`, async () => {
      const { root, repository } = await fixture();
      const current = await repository.withConsistentRead(async (session) => ({
        value: required(await session.read(resourceKey)),
        etag: await session.etag([resourceKey]),
      }));
      await expect(
        repository.commit({
          kind: 'save',
          precondition: { ifMatch: current.etag, resourceKeys: [resourceKey] },
          changes: [
            {
              resourceKey,
              expectedRevision: current.value.revision,
              content: Buffer.alloc(limit + 1),
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE', status: 422 });
      expect(await readFile(join(root, resourceKey))).toEqual(
        current.value.bytes,
      );
    });
});

describe('SAVE-01：ETag串流與已提交版本', () => {
  it('session串流ETag與公開純函式一致；metadata-only提交回原始已提交etag', async () => {
    let root = '';
    let injected = false;
    const result = await fixture({
      fault: async (event) => {
        if (event.phase === 'committed-journal' && !injected) {
          injected = true;
          await writeFile(
            join(root, required(keys[0])),
            '<p>after commit IDE</p>',
          );
        }
      },
    });
    root = result.root;
    const before = await result.repository.withConsistentRead((session) =>
      session.etag(keys),
    );
    expect(before).toBe(
      etagForResources(
        keys.map((resourceKey, index) => ({
          resourceKey,
          bytes: Buffer.from(required(old[index])),
        })),
      ),
    );
    const save = await request(result.repository);
    const saved = await result.repository.commit({
      ...save,
      changes: [required(save.changes[1])],
    });
    const expected = etagForResources([
      { resourceKey: required(keys[0]), bytes: Buffer.from(required(old[0])) },
      { resourceKey: required(keys[1]), bytes: Buffer.from(required(next[1])) },
    ]);
    expect(saved.etag).toBe(expected);
    expect(
      await result.repository.withConsistentRead((session) =>
        session.etag(keys),
      ),
    ).not.toBe(expected);
    expect((await actual(root))[0]).toBe('<p>after commit IDE</p>');
  });
});

describe('SAVE-01／02：審查發現的完整讀取與還原目錄守門', () => {
  it('只讀ETag仍登錄raw依賴，結束前發生外部變更則拒絕舊ETag成功', async () => {
    const { root, repository } = await fixture();
    await expect(
      repository.withConsistentRead(async (session) => {
        const etag = await session.etag(['content/site.json']);
        await writeFile(join(root, 'content/site.json'), ' []\n');
        return etag;
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  });
  it('validate只讀crossresource ETag也有final guard；Build讀取同樣驗證session', async () => {
    let root = '';
    const result = await fixture({
      fault: async (event) => {
        if (event.phase === 'prepared-journal')
          await writeFile(join(root, 'content/tags.json'), ' []\n');
      },
    });
    root = result.root;
    await expect(
      result.repository.commit({
        ...(await request(result.repository)),
        validate: async (session) => {
          await session.etag(['content/tags.json']);
        },
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    expect(await actual(root)).toEqual(old);
    await expect(
      result.repository.withBuildInputLock(async (session) => {
        const etag = await session.etag(['content/categories.json']);
        await writeFile(join(root, 'content/categories.json'), ' []\n');
        return etag;
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  });
  it('restore-trash child prepared後新同名目錄即409，絕不混合external.txt與原文章', async () => {
    const { root, repository } = await fixture();
    const save = await request(repository);
    const removed = await repository.commit({
      ...save,
      kind: 'delete',
      trash: { kind: 'article', id: 'example' },
      changes: save.changes.map((item) => ({ ...item, content: null })),
    });
    let once = false;
    const restoring = new FileRepository({
      repositoryRoot: root,
      fault: async (event) => {
        if (event.phase === 'prepared-journal' && !once) {
          once = true;
          await mkdir(join(root, 'content/articles/example'));
          await writeFile(
            join(root, 'content/articles/example/external.txt'),
            'external',
          );
        }
      },
    });
    await expect(
      resolution(restoring, removed.transactionId, 'restore-trash'),
    ).rejects.toMatchObject({ code: 'TRASH_TARGET_EXISTS', status: 409 });
    expect(await readdir(join(root, 'content/articles/example'))).toEqual([
      'external.txt',
    ]);
    expect(
      await readFile(
        join(root, 'content/articles/example/external.txt'),
        'utf8',
      ),
    ).toBe('external');
    expect(
      (
        await new FileRepository({ repositoryRoot: root }).recovery(
          removed.transactionId,
        )
      ).value.status,
    ).toBe('available');
  });
  for (const phase of [
    'directory-created',
    'directory-reserved',
    'install-intent',
  ] as const)
    it(`restore-trash在 ${phase} 真中止，目錄ownership證據決定復原而非猜測空目錄`, async () => {
      const { root, repository } = await fixture();
      const save = await request(repository);
      const removed = await repository.commit({
        ...save,
        kind: 'delete',
        trash: { kind: 'article', id: 'example' },
        changes: save.changes.map((item) => ({ ...item, content: null })),
      });
      const process = worker(
        root,
        'resolve',
        phase,
        removed.transactionId,
        'restore-trash',
      );
      expect(await process.done, process.error()).toBe(77);
      const reopened = new FileRepository({ repositoryRoot: root });
      const state = await reopened.initialize();
      if (phase === 'directory-created') {
        expect(state.recoveryState).toBe('recovery-required');
        expect(await readdir(join(root, 'content/articles/example'))).toEqual(
          [],
        );
        expect(
          (await reopened.recovery(removed.transactionId)).value.status,
        ).toBe('available');
        await expect(
          reopened.withBuildInputLock(async () => true),
        ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      } else {
        expect(state.recoveryState).toBe('ready');
        if (phase === 'directory-reserved')
          await resolution(reopened, removed.transactionId, 'restore-trash');
        expect(
          (await reopened.recovery(removed.transactionId)).value.status,
        ).toBe('resolved');
        expect(await actual(root)).toEqual(old);
      }
    });
  it('底層在新增article目錄前拒絕第10001個來源，即使是可保存Draft', async () => {
    const { root, repository } = await fixture();
    const ids = Array.from({ length: 9999 }, (_, index) => `existing-${index}`);
    for (let index = 0; index < ids.length; index += 50)
      await Promise.all(
        ids
          .slice(index, index + 50)
          .map((id) => mkdir(join(root, 'content/articles', id))),
      );
    await expect(
      repository.commit({
        kind: 'create',
        changes: [
          {
            resourceKey: 'content/articles/overflow/meta.json',
            expectedRevision: null,
            content: Buffer.from('{"status":"draft"}'),
          },
          {
            resourceKey: 'content/articles/overflow/content.html',
            expectedRevision: null,
            content: Buffer.from(''),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ARTICLE_CAPACITY_EXCEEDED', status: 422 });
    await expect(
      lstat(join(root, 'content/articles/overflow')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('SAVE-02：損壞journal不得擴張目錄恢復範圍', () => {
  for (const variant of [
    'outside-controlled',
    'other-article',
    'different-kind',
    'cross-directory-entry',
    'invalid-identity',
  ] as const)
    it(`${variant} reservation拒絕且不rmdir/修改任何來源`, async () => {
      const { root, repository } = await fixture();
      const saved = await repository.commit(await request(repository));
      await mkdir(join(root, 'victim'));
      await mkdir(join(root, 'content/articles/other'));
      const victim = await lstat(join(root, 'victim'));
      const article = await lstat(join(root, 'content/articles/example'));
      const path = join(
        root,
        `.alfred/transactions/${saved.transactionId}/journal.json`,
      );
      const journal = JSON.parse(await readFile(path, 'utf8')) as {
        kind: string;
        status: string;
        entries: { resourceKey: string }[];
        directoryReservation?: {
          resourceKey: string;
          token: string;
          identity: { dev: number; ino: number };
        };
      };
      journal.status = 'prepared';
      journal.kind = variant === 'different-kind' ? 'save' : 'restore';
      journal.directoryReservation = {
        resourceKey:
          variant === 'outside-controlled'
            ? 'victim'
            : variant === 'other-article'
              ? 'content/articles/other'
              : 'content/articles/example',
        token: randomUUID(),
        identity: { dev: victim.dev, ino: victim.ino },
      };
      if (variant === 'different-kind')
        journal.directoryReservation.identity = {
          dev: article.dev,
          ino: article.ino,
        };
      if (variant === 'cross-directory-entry')
        required(journal.entries[0]).resourceKey =
          'content/articles/other/content.html';
      if (variant === 'invalid-identity')
        journal.directoryReservation.identity.ino = -1;
      await writeFile(path, JSON.stringify(journal));
      await expect(
        new FileRepository({ repositoryRoot: root }).initialize(),
      ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect((await lstat(join(root, 'victim'))).ino).toBe(victim.ino);
      expect(await actual(root)).toEqual(next);
      expect(await readdir(join(root, 'content/articles/other'))).toEqual([]);
    });
});

describe('SAVE-02：正常保存備份可見、可還原且冪等原始結果仍可取得', () => {
  it('save history available不阻擋workspace，restore-backup真恢復舊版且原receipt持久可查', async () => {
    const { root, repository } = await fixture();
    const operation = {
      id: randomUUID(),
      key: randomUUID(),
      payloadHash: digest('saved payload'),
      httpStatus: 200,
      response: { id: 'example', contentHtml: required(next[0]) },
      headers: { ETag: `"${digest('saved receipt')}"` },
    };
    const saved = await repository.commit({
      ...(await request(repository)),
      operation,
    });
    const available = required(
      (await repository.listRecoveries()).find(
        (item) => item.id === saved.transactionId,
      ),
    );
    expect(available.status).toBe('available');
    expect(available.kind).toBe('transaction');
    expect((await repository.recovery(saved.transactionId)).value.status).toBe(
      'available',
    );
    expect(
      (await repository.workspace({ scanInputs: sourceRevision })).value
        .recoveryState,
    ).toBe('ready');
    await resolution(repository, saved.transactionId, 'restore-backup');
    expect(await actual(root)).toEqual(old);
    expect((await repository.recovery(saved.transactionId)).value.status).toBe(
      'resolved',
    );
    expect(
      await new FileRepository({
        repositoryRoot: root,
      }).listCommittedOperations(),
    ).toEqual([operation]);
  });
});
