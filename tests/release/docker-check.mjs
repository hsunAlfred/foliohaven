// Shared author workflow contract for isolated Docker and native release checkers.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ArticleResourceSchema,
  CurrentArtifactSchema,
  JobSchema,
  MediaSourceResourceSchema,
} from '@foliohaven/core';

const root = process.cwd();
const mode = process.argv[2];
assert.ok(['prepare', 'verify'].includes(mode) && process.argv.length === 3);
const acceptancePlatform =
  process.env.FOLIOHAVEN_ACCEPTANCE_PLATFORM ?? 'docker';
assert.ok(['docker', 'native'].includes(acceptancePlatform));
const started = Date.now();
function progress(message) {
  console.log(
    `[${new Date().toISOString()}][${mode}][+${Math.floor((Date.now() - started) / 1000)}s] ${message}`,
  );
}
const watchdog = setTimeout(() => {
  console.error(
    'RELEASE_CHECK_TIMEOUT：本輪作者操作驗收超過15分鐘，已停止並保留現場。',
  );
  process.exit(1);
}, 15 * 60_000);
watchdog.unref();
progress('檢查 Node、pnpm 版本與隔離副本標記');
const packageJson = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8'),
);
const nodeVersion = (
  await readFile(resolve(root, '.node-version'), 'utf8')
).trim();
const pnpmVersion = execFileSync('pnpm', ['--version'], {
  encoding: 'utf8',
  timeout: 15_000,
  killSignal: 'SIGKILL',
}).trim();
assert.equal(process.versions.node, nodeVersion);
assert.equal(packageJson.packageManager, `pnpm@${pnpmVersion}`);
const marker = JSON.parse(
  await readFile(resolve(root, '.alfred/release-check-workspace.json'), 'utf8'),
);
assert.deepEqual(marker, { schemaVersion: 1, purpose: 'release-validation' });
await assert.rejects(access(resolve(root, '.git')), { code: 'ENOENT' });
const origin = 'http://127.0.0.1:5173';
const report = resolve(root, '.alfred/reports/release-docker-check');
await mkdir(report, { recursive: true, mode: 0o700 });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function call(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { Origin: origin }),
      ...(body instanceof FormData || body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined
      ? {}
      : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    json: () => JSON.parse(bytes.toString('utf8')),
  };
}
async function job(id) {
  const deadline = Date.now() + 300_000;
  let previousStatus = '';
  let lastProgress = 0;
  while (Date.now() < deadline) {
    const response = await call(`/api/v1/jobs/${id}`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(15_000, deadline - Date.now())),
      ),
    });
    assert.equal(response.status, 200);
    const value = JobSchema.parse(response.json());
    if (
      value.status !== previousStatus ||
      Date.now() - lastProgress >= 30_000
    ) {
      progress(`工作 ${id}：${value.status}（每項最多等待300秒）`);
      previousStatus = value.status;
      lastProgress = Date.now();
    }
    if (!['queued', 'running'].includes(value.status)) {
      assert.equal(
        value.status,
        'succeeded',
        value.error?.code ?? value.status,
      );
      return value;
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('RELEASE_CHECK_JOB_TIMEOUT');
}
async function current() {
  const response = await call('/api/v1/artifacts/current');
  assert.equal(response.status, 200);
  const value = CurrentArtifactSchema.parse(response.json());
  assert.equal(value.recoveryState, 'ready');
  assert.ok(value.current?.build);
  return value.current;
}
async function jobFiles() {
  const names = (await readdir(resolve(root, '.alfred/jobs')))
    .filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        digest(await readFile(resolve(root, '.alfred/jobs', name))),
      ]),
    ),
  );
}
async function readable(path) {
  const response = await fetch(`http://127.0.0.1:4322${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}
async function verify(state) {
  progress('核對網站產物來源與工作紀錄');
  const artifact = await current();
  assert.equal(artifact.digest, state.artifactDigest);
  assert.equal(artifact.build.result.snapshotRevision, state.snapshotRevision);
  assert.deepEqual(await jobFiles(), state.jobFiles);
  for (const name of Object.keys(state.jobFiles)) {
    const response = await call(`/api/v1/jobs/${name.slice(0, -5)}`);
    assert.equal(response.status, 200);
    assert.equal(JobSchema.parse(response.json()).status, 'succeeded');
  }
  const article = await call(`/api/v1/articles/${state.articleId}`);
  assert.equal(article.status, 200);
  const value = ArticleResourceSchema.parse(article.json());
  assert.equal(value.meta.status, 'published');
  assert.equal(value.contentHtml, state.contentHtml);
  assert.equal(
    digest(await readFile(resolve(root, state.originalPath))),
    state.originalSha256,
  );
  progress('核對已發布文章、原始圖片與兩個網站預覽');
  const html = (await readable(state.articleUrl)).toString('utf8');
  assert.ok(html.includes(state.sentinel));
  assert.ok(html.includes(state.publicPath));
  const development = await fetch(`http://127.0.0.1:4321${state.articleUrl}`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(development.status, 200);
  assert.ok((await development.text()).includes(state.sentinel));
  const developmentImage = await fetch(
    `http://127.0.0.1:4321${state.publicPath}`,
    {
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(developmentImage.status, 200);
  assert.equal(
    digest(Buffer.from(await developmentImage.arrayBuffer())),
    state.outputSha256,
  );
  assert.equal(digest(await readable(state.publicPath)), state.outputSha256);
  const source = await call(`/api/v1/media/sources/${state.sourceId}`);
  assert.equal(source.status, 200);
  assert.ok(MediaSourceResourceSchema.parse(source.json()).asset);
  return {
    checkedAt: new Date().toISOString(),
    mode,
    articleSaved: true,
    mediaSaved: true,
    artifactUnchanged: true,
    jobCount: Object.keys(state.jobFiles).length,
    environment: {
      node: process.version,
      pnpm: pnpmVersion,
      platform: process.platform,
      arch: process.arch,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
    },
  };
}
let state;
if (mode === 'prepare') {
  progress('確認首次網站建置與 API 安全邊界');
  await current(); // Verifies the actual first-start Build proof.
  const forbidden = await fetch('http://127.0.0.1:3001/api/v1/workspace', {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(forbidden.status, 403);
  await forbidden.arrayBuffer();
  const crossOrigin = await call('/api/v1/build-jobs', {
    method: 'POST',
    body: {},
    headers: {
      Origin: 'https://outside.invalid',
      'Idempotency-Key': randomUUID(),
    },
  });
  assert.equal(crossOrigin.status, 403);
  progress('建立並上傳驗收圖片');
  const sharp = createRequire(
    new URL('../../server/package.json', import.meta.url),
  )('sharp');
  const png = await sharp({
    create: { width: 64, height: 32, channels: 3, background: '#537664' },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append(
    'file',
    new Blob([png], { type: 'image/png' }),
    'release-check.png',
  );
  const uploaded = await call('/api/v1/media/sources', {
    method: 'POST',
    body: form,
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(uploaded.status, 201);
  const source = MediaSourceResourceSchema.parse(uploaded.json());
  progress('處理圖片並驗證 WebP 尺寸與 Range 讀取');
  const processed = await call('/api/v1/media-jobs', {
    method: 'POST',
    body: { sourceId: source.id, preset: 'article-image' },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(processed.status, 202);
  await job(JobSchema.parse(processed.json()).id);
  const output = await call(`/api/v1/media/files/${source.id}/image.webp`);
  assert.equal(output.status, 200);
  assert.equal(output.headers.get('content-type'), 'image/webp');
  const decoded = await sharp(output.bytes).metadata();
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 32);
  const range = await call(`/api/v1/media/files/${source.id}/image.webp`, {
    headers: { Range: 'bytes=0-7' },
  });
  assert.equal(range.status, 206);
  assert.deepEqual(range.bytes, output.bytes.subarray(0, 8));
  const categories = JSON.parse(
    await readFile(resolve(root, 'content/categories.json'), 'utf8'),
  );
  assert.ok(categories[0]?.path);
  const slug = `release-check-${randomUUID().slice(0, 8)}`;
  const sentinel = `RELEASE_PERSISTENCE_${randomUUID()}`;
  const publicPath = `/media/${source.id}/image.webp`;
  const contentHtml = `<h2 id="release-check">網站資料保存驗收</h2><p>${sentinel}</p><img src="${publicPath}" alt="驗收用中性色塊" width="64" height="32">`;
  const now = new Date().toISOString();
  const input = {
    contentHtml,
    meta: {
      status: 'draft',
      title: '網站資料保存驗收',
      slug,
      category: categories[0].path,
      tags: [],
      publishedAt: now,
      updatedAt: now,
      featuredImage: null,
      featuredImageAlt: '',
      seo: {
        title: null,
        description: '以真實操作確認重新啟動後內容與網站產物仍完整保存。',
        index: null,
        ogImage: null,
      },
    },
  };
  progress('建立草稿並發布驗收文章');
  const created = await call('/api/v1/articles', {
    method: 'POST',
    body: input,
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(created.status, 201);
  const article = ArticleResourceSchema.parse(created.json());
  const published = await call(`/api/v1/articles/${article.id}`, {
    method: 'PUT',
    body: { ...input, meta: { ...input.meta, status: 'published' } },
    headers: { 'If-Match': created.headers.get('etag') },
  });
  assert.equal(published.status, 200);
  assert.equal(
    ArticleResourceSchema.parse(published.json()).meta.status,
    'published',
  );
  progress('更新網站，等待正式建置完成');
  const build = await call('/api/v1/build-jobs', {
    method: 'POST',
    body: {},
    headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(build.status, 202);
  await job(JobSchema.parse(build.json()).id);
  const artifact = await current();
  state = {
    articleId: article.id,
    sourceId: source.id,
    contentHtml,
    sentinel,
    originalPath: `media/source/${source.id}/original.png`,
    originalSha256: digest(png),
    publicPath,
    outputSha256: digest(output.bytes),
    articleUrl: `/${input.meta.category}/${slug}/`,
    artifactDigest: artifact.digest,
    snapshotRevision: artifact.build.result.snapshotRevision,
    jobFiles: await jobFiles(),
  };
  await writeFile(
    resolve(report, 'state.json'),
    JSON.stringify(state, null, 2) + '\n',
    { mode: 0o600 },
  );
} else {
  progress('讀取前次保存驗收資料');
  state = JSON.parse(await readFile(resolve(report, 'state.json'), 'utf8'));
}
const result = {
  scope: acceptancePlatform === 'native' ? 'linux-native' : 'docker',
  ...(await verify(state)),
};
await writeFile(
  resolve(report, `${mode}.json`),
  JSON.stringify(result, null, 2) + '\n',
  { mode: 0o600 },
);
clearTimeout(watchdog);
progress('本輪作者操作與資料保存檢查通過');
console.log(JSON.stringify(result));
