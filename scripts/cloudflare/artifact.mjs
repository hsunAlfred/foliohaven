import { constants } from 'node:fs';
import { open, statfs } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { parse } from 'parse5';
import { CloudflareError, cancelled } from './errors.mjs';
import {
  digest,
  hashFile,
  privateDirectory,
  safePath,
  syncDirectory,
  validPath,
} from './io.mjs';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

export function splitManifest(artifact, config) {
  const files = [];
  for (const entry of artifact.entries) {
    if (entry.kind !== 'file') continue;
    const parts = entry.path.split('/');
    if (
      !validPath(entry.path) ||
      parts.some(
        (part) =>
          ['.git', '.alfred', '.codex', 'node_modules', '.wrangler'].includes(
            part,
          ) || part.startsWith('.env'),
      ) ||
      /\.(?:pem|key|map)$/i.test(entry.path) ||
      ['_headers', '_redirects', 'cloudflare.config.json'].includes(entry.path)
    )
      throw new CloudflareError(
        'CLOUDFLARE_PRIVATE_ARTIFACT',
        '產物包含私有資料或會改變託管行為的控制檔；請修正來源後重建。',
      );
    const target =
      entry.path.startsWith('assets/') || entry.path.startsWith('media/')
        ? 'r2'
        : 'worker';
    if (target === 'worker' && entry.byteSize > 25 * 1024 * 1024)
      throw new CloudflareError(
        'CLOUDFLARE_ASSET_LIMIT',
        'Worker 靜態檔案超過單檔 25 MiB 上限。',
      );
    files.push({
      ...entry,
      target,
      mime:
        mimeTypes[extname(entry.path).toLowerCase()] ??
        'application/octet-stream',
    });
  }
  const capacity = config.workersPlan === 'paid' ? 100000 : 20000;
  if (files.length > 200000)
    throw new CloudflareError(
      'CLOUDFLARE_RECORD_LIMIT',
      '完整網站最多處理 200,000 個檔案；請縮小資源量。',
    );
  if (files.filter((file) => file.target === 'worker').length > capacity)
    throw new CloudflareError(
      'CLOUDFLARE_ASSET_LIMIT',
      'Worker 檔案數超過 workersPlan 指定的方案容量；請核對實際方案及設定。',
    );
  if (
    !files.some((file) => file.path === 'index.html') ||
    files.length !== artifact.fileCount ||
    files.reduce((sum, file) => sum + file.byteSize, 0) !==
      artifact.totalBytes ||
    new Set(files.map((file) => file.path)).size !== files.length
  )
    throw new CloudflareError(
      'CLOUDFLARE_MANIFEST_INVALID',
      '分流清單未完整且互斥地覆蓋正式網站。',
    );
  return files;
}

export async function ensureSpace(root, bytes) {
  const space = await statfs(root, { bigint: true });
  if (space.bavail * space.bsize < BigInt(bytes) + 64n * 1024n * 1024n)
    throw new CloudflareError(
      'CLOUDFLARE_DISK_FULL',
      '磁碟可用空間不足以固定產物及保存必要資料。',
    );
}

export async function stageWorker(root, files, signal) {
  await ensureSpace(
    root,
    files
      .filter((file) => file.target === 'worker')
      .reduce((sum, file) => sum + file.byteSize, 0),
  );
  await privateDirectory(root, 'worker');
  for (const file of files.filter((entry) => entry.target === 'worker')) {
    cancelled(signal);
    const destination = `worker/${file.path}`;
    const parent = dirname(destination);
    await privateDirectory(root, parent);
    const source = await open(
      await safePath(root, `source/${file.path}`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let output;
    try {
      output = await open(
        await safePath(root, destination),
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      for await (const chunk of source.createReadStream({ autoClose: false })) {
        cancelled(signal);
        await output.writeFile(chunk);
      }
      await output.sync();
    } finally {
      await source.close();
      await output?.close();
    }
    await syncDirectory(await safePath(root, parent));
    const actual = await hashFile(root, destination, signal);
    if (actual.sha256 !== file.sha256 || actual.byteSize !== file.byteSize)
      throw new CloudflareError(
        'CLOUDFLARE_SOURCE_CHANGED',
        'Worker 分流副本與正式產物不一致。',
      );
  }
}

export async function readSiteUrl(root) {
  const handle = await open(
    await safePath(root, 'source/index.html'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let text;
  try {
    text = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const canonicals = [];
  function visit(node) {
    const attrs = Object.fromEntries(
      (node.attrs ?? []).map((attr) => [attr.name, attr.value]),
    );
    if (
      node.nodeName === 'link' &&
      attrs.rel?.split(/\s+/).includes('canonical')
    )
      canonicals.push(attrs.href);
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(parse(text));
  try {
    if (canonicals.length !== 1) throw new Error();
    const url = new URL(canonicals[0]);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.href;
  } catch {
    throw new CloudflareError(
      'CLOUDFLARE_SITE_URL_INVALID',
      '首頁須有唯一且有效的網站根網址 canonical。',
    );
  }
}

export function createManifest(captured, files, siteUrl) {
  return {
    schemaVersion: 1,
    artifactDigest: captured.manifest.digest,
    filesDigest: digest(files),
    build: {
      jobId: captured.proof.jobId,
      snapshotRevision: captured.proof.result.snapshotRevision,
    },
    siteUrl,
    files,
  };
}
