import { privateResource } from '../workspace-paths.mjs';
import { lookup as lookupAddress } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'parse5';
import { normalizeSearchQuery } from '@foliohaven/core';
import { CloudflareError, cancelled } from './errors.mjs';
import { hasUploadProof } from './state.mjs';
import {
  digestPattern,
  hashFile,
  hasControl,
  privateDirectory,
  safePath,
  uuidPattern,
  validPath,
} from './io.mjs';

const requestTimeout = 5 * 60_000;
const textLimit = 25 * 1024 * 1024;
const browserLimit = 32 * 1024 * 1024;
const fail = (code, message) => new CloudflareError(code, message);

/** 僅接受公開 HTTPS 根網址；不把路徑、userinfo 或顯式 port 當成網站名稱。 */
export function normalizeDomain(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    hasControl(value) ||
    value.length > 2048
  )
    throw fail(
      'CLOUDFLARE_DOMAIN_INVALID',
      '請提供正式網站的 HTTPS 根網址或完整網域名稱。',
    );
  const input = value.trim();
  let url;
  try {
    url = new URL(input.includes('://') ? input : `https://${input}`);
  } catch {
    throw fail('CLOUDFLARE_DOMAIN_INVALID', '網站網址格式不正確。');
  }
  const authority = (
    input.includes('://') ? input.split('://')[1] : input
  ).split('/')[0];
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    authority.includes(':') ||
    input.includes('?') ||
    input.includes('#') ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    isIP(url.hostname) ||
    url.hostname.length > 253 ||
    !url.hostname.includes('.') ||
    !url.hostname
      .split('.')
      .every((label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
      ) ||
    /(?:^|\.)(?:localhost|localdomain|local|internal|lan|home|onion|invalid)$/i.test(
      url.hostname,
    )
  )
    throw fail(
      'CLOUDFLARE_DOMAIN_INVALID',
      '只接受公開 HTTPS 網域根網址，不可含連接埠、帳密、查詢、片段或額外路徑。',
    );
  return url.origin + '/';
}

/** 允許一般 public unicast；拒絕私有、loopback、文件、轉譯與保留位址。 */
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const first = Number.parseInt(address.split(':')[0], 16);
  if (
    !Number.isFinite(first) ||
    (first & 0xe000) !== 0x2000 ||
    first === 0x2002 ||
    first === 0x3fff
  )
    return false;
  const second = Number.parseInt(address.split(':')[1] || '0', 16);
  return !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

async function resolvePublic(hostname, lookup, signal) {
  cancelled(signal);
  let addresses;
  let stop;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        stop = () =>
          reject(fail('CLOUDFLARE_DOMAIN_TIMEOUT', 'DNS 查詢已取消或逾時。'));
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
      }),
    ]);
  } catch {
    throw fail(
      'CLOUDFLARE_DOMAIN_DNS_FAILED',
      '無法解析正式網域，請檢查 DNS 與 Proxy 設定。',
    );
  } finally {
    if (stop) signal?.removeEventListener('abort', stop);
  }
  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.some(
      (entry) =>
        !isPublicAddress(entry.address) || isIP(entry.address) !== entry.family,
    )
  )
    throw fail(
      'CLOUDFLARE_DOMAIN_ADDRESS_BLOCKED',
      '網站解析結果包含私人或保留位址，已停止連線。',
    );
  return addresses[0];
}

function nodeRequest(url, options) {
  return new Promise((resolveRequest, reject) => {
    const abort = () =>
      request.destroy(fail('CLOUDFLARE_CANCELLED', '操作已取消。'));
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        servername: url.hostname,
        path: url.pathname + url.search,
        method: options.method,
        headers: options.headers,
        agent: false,
        signal: options.signal,
        // 只回傳剛才驗過的 address，TLS 仍驗證正式 hostname，沒有第二次 DNS lookup。
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all)
            callback(null, [
              { address: options.address, family: options.family },
            ]);
          else callback(null, options.address, options.family);
        },
      },
      (response) => {
        response.once('close', () =>
          options.signal?.removeEventListener('abort', abort),
        );
        resolveRequest({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
        });
      },
    );
    request.setTimeout(30_000, () =>
      request.destroy(
        fail(
          'CLOUDFLARE_DOMAIN_TIMEOUT',
          '網站回應逾時，請檢查 HTTPS 與來源設定。',
        ),
      ),
    );
    request.once('error', () => {
      options.signal?.removeEventListener('abort', abort);
      reject(
        fail(
          'CLOUDFLARE_DOMAIN_REQUEST_FAILED',
          '無法完成安全的 HTTPS 網站請求。',
        ),
      );
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    request.end();
  });
}

function headersOf(response) {
  return Object.fromEntries(
    Object.entries(response.headers).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value ?? ''),
    ]),
  );
}
async function consume(response, limit, collect, signal) {
  const headers = headersOf(response);
  if (
    headers['content-encoding'] &&
    headers['content-encoding'].toLowerCase() !== 'identity'
  ) {
    response.body.destroy?.();
    throw fail(
      'CLOUDFLARE_DOMAIN_ENCODING',
      '來源未遵守 identity 傳輸要求，無法核對原始檔案。',
    );
  }
  const hash = createHash('sha256');
  const chunks = [];
  let byteSize = 0;
  for await (const chunk of response.body) {
    cancelled(signal);
    const bytes = Buffer.from(chunk);
    byteSize += bytes.length;
    if (byteSize > limit)
      throw fail(
        'CLOUDFLARE_DOMAIN_RESPONSE_TOO_LARGE',
        '網站回應超過本次檔案或驗收請求的容量。',
      );
    hash.update(bytes);
    if (collect) chunks.push(bytes);
  }
  return {
    statusCode: response.statusCode,
    headers,
    byteSize,
    sha256: hash.digest('hex'),
    body: collect ? Buffer.concat(chunks) : undefined,
  };
}
function mime(value) {
  return value?.split(';')[0].trim().toLowerCase();
}
function mimeMatches(expected, actual) {
  const left = mime(expected);
  const right = mime(actual);
  return (
    left === right ||
    (['application/xml', 'text/xml'].includes(left) &&
      ['application/xml', 'text/xml'].includes(right)) ||
    (['application/javascript', 'text/javascript'].includes(left) &&
      ['application/javascript', 'text/javascript'].includes(right))
  );
}
function publicPath(path) {
  if (path === 'index.html') return '/';
  if (path.endsWith('/index.html'))
    return (
      '/' + path.slice(0, -10).split('/').map(encodeURIComponent).join('/')
    );
  if (path.endsWith('.html'))
    return (
      '/' + path.slice(0, -5).split('/').map(encodeURIComponent).join('/') + '/'
    );
  return '/' + path.split('/').map(encodeURIComponent).join('/');
}
function fallbackPath(manifest, deploymentId) {
  const occupied = new Set(manifest.map((file) => file.path.split('/')[0]));
  const prefix = `__foliohaven_not_found_${deploymentId}`;
  let suffix = 0;
  while (occupied.has(prefix + (suffix ? `_${suffix}` : ''))) suffix++;
  return '/' + prefix + (suffix ? `_${suffix}` : '') + '/';
}
function htmlData(text) {
  const result = { canonical: [], og: [], robots: [], resources: [] };
  const visit = (node) => {
    const attr = Object.fromEntries(
      (node.attrs ?? []).map((entry) => [
        entry.name.toLowerCase(),
        entry.value,
      ]),
    );
    if (node.tagName === 'link' && attr.rel?.toLowerCase() === 'canonical')
      result.canonical.push(attr.href);
    if (node.tagName === 'meta' && attr.property?.toLowerCase() === 'og:url')
      result.og.push(attr.content);
    if (node.tagName === 'meta' && attr.name?.toLowerCase() === 'robots')
      result.robots.push(attr.content.toLowerCase());
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(text));
  return result;
}
function requireUrl(value, base) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail('CLOUDFLARE_DOMAIN_SEO_URL', 'SEO 或網站索引含無效的絕對網址。');
  }
  if (
    url.origin !== new URL(base).origin ||
    url.username ||
    url.password ||
    url.protocol !== 'https:'
  )
    throw fail(
      'CLOUDFLARE_DOMAIN_SEO_URL',
      'canonical、OG URL、RSS、Sitemap 或 robots 網址與正式網域不一致。',
    );
  return url;
}
function xmlValues(text, tag) {
  return [
    ...text.matchAll(
      new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi'),
    ),
  ].map((match) =>
    match[1]
      .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
      .replaceAll('&amp;', '&')
      .trim(),
  );
}
async function sourceText(root, file) {
  const handle = await open(
    await safePath(root, `source/${file.path}`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > textLimit)
      throw fail(
        'CLOUDFLARE_DOMAIN_SOURCE_INVALID',
        '驗收來源不是容量允許的一般文字檔。',
      );
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
async function localBytes(root, path, offset, length) {
  const handle = await open(
    await safePath(root, `source/${path}`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const result = Buffer.alloc(length);
    const { bytesRead } = await handle.read(result, 0, length, offset);
    if (bytesRead !== length)
      throw fail(
        'CLOUDFLARE_DOMAIN_SOURCE_CHANGED',
        '部署副本長度已改變，請保留紀錄並重新部署。',
      );
    return result;
  } finally {
    await handle.close();
  }
}

function validateBrowserVideoResponse(
  file,
  method,
  range,
  statusCode,
  headers,
) {
  let start = 0;
  let end = file.byteSize - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      throw fail(
        'CLOUDFLARE_BROWSER_VIDEO_RESPONSE',
        '影片請求的 Range 格式不受支援。',
      );
    start = match[1]
      ? Number(match[1])
      : Math.max(0, file.byteSize - Number(match[2]));
    end =
      match[1] && match[2]
        ? Math.min(Number(match[2]), file.byteSize - 1)
        : file.byteSize - 1;
  }
  if (
    !['GET', 'HEAD'].includes(method) ||
    !mimeMatches(file.mime, headers['content-type']) ||
    (headers['content-encoding'] &&
      headers['content-encoding'].toLowerCase() !== 'identity') ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= file.byteSize ||
    statusCode !== (range ? 206 : 200) ||
    Number(headers['content-length']) !== end - start + 1 ||
    (range &&
      headers['content-range'] !== `bytes ${start}-${end}/${file.byteSize}`)
  )
    throw fail(
      'CLOUDFLARE_BROWSER_VIDEO_RESPONSE',
      '影片回應的狀態、MIME、大小或 Range 不符。',
    );
}

async function browserChecks(
  context,
  base,
  request,
  texts,
  onCheck,
  { useNativeVideo = false, lookup = lookupAddress } = {},
) {
  const { chromium, firefox, webkit } = await import('@playwright/test');
  const screenshots = await privateDirectory(
    context.repositoryRoot,
    privateResource(
      context.repositoryRoot,
      `reports/cloudflare/${context.deploymentId}/screenshots`,
    ),
  );
  const filesByUrl = new Map(
    context.manifest.map((file) => [publicPath(file.path), file]),
  );
  const pages = context.manifest.filter(
    (file) => file.path.endsWith('.html') && file.path !== '404.html',
  );
  const search = texts.get('search-index.json');
  let firstArticle;
  try {
    firstArticle = JSON.parse(search ?? '{}').articles?.[0];
  } catch {
    /* 索引格式由 HTTP 檢查報告。 */
  }
  const results = [];
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    cancelled(context.signal);
    let browser, proxy;
    let currentPath;
    let stage = 'browser-start';
    try {
      if (
        useNativeVideo &&
        context.manifest.some((file) => file.mime.startsWith('video/'))
      ) {
        const { createBrowserProxy } = await import('./browser-proxy.mjs');
        proxy = await createBrowserProxy({
          domain: base,
          signal: context.signal,
          lookup,
        });
      }
      browser = await engine.launch({ headless: true });
      const stop = () => {
        void browser.close().catch(() => undefined);
      };
      context.signal?.addEventListener('abort', stop, { once: true });
      try {
        const session = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          serviceWorkers: 'block',
          ignoreHTTPSErrors: false,
          ...(proxy ? { proxy: { server: proxy.server } } : {}),
        });
        const failures = [];
        const pendingResponses = new Set();
        const nativeVideoRequests = new Set();
        const verifiedNativeVideos = new Set();
        if (proxy)
          session.on('response', (response) => {
            const task = (async () => {
              let path = '/';
              try {
                const url = new URL(response.url());
                path = url.pathname;
                const file = filesByUrl.get(path);
                if (!file?.mime.startsWith('video/')) return;
                // WebKit 可先發無 HTTP 狀態的媒體事件；它不構成成功證據。
                if (response.status() === 0) return;
                if (url.origin !== new URL(base).origin)
                  throw fail(
                    'CLOUDFLARE_BROWSER_HOST_BLOCKED',
                    '原生影片回應來自其他 hostname。',
                  );
                const incoming = response.request();
                validateBrowserVideoResponse(
                  file,
                  incoming.method(),
                  incoming.headers().range,
                  response.status(),
                  await response.allHeaders(),
                );
                verifiedNativeVideos.add(path);
              } catch (error) {
                if (failures.length < 64)
                  failures.push({
                    code:
                      error instanceof CloudflareError
                        ? error.code
                        : 'CLOUDFLARE_BROWSER_VIDEO_RESPONSE',
                    path,
                  });
              }
            })();
            pendingResponses.add(task);
            void task.finally(() => pendingResponses.delete(task));
          });
        await session.routeWebSocket('**/*', (socket) => {
          failures.push({
            code: 'CLOUDFLARE_BROWSER_WEBSOCKET_BLOCKED',
            path: '/',
          });
          socket.close();
        });
        await session.route('**/*', async (route) => {
          try {
            const incoming = route.request();
            const url = new URL(incoming.url());
            if (
              url.origin !== new URL(base).origin ||
              url.username ||
              url.password ||
              url.port
            )
              throw fail(
                'CLOUDFLARE_BROWSER_HOST_BLOCKED',
                '瀏覽器嘗試讀取正式網域以外的資源，已停止該請求。',
              );
            // WebKit 的媒體播放會讀取同源 blob；它只讀瀏覽器記憶體，沒有 DNS 或遠端連線。
            if (url.protocol === 'blob:') {
              await route.continue();
              return;
            }
            if (url.protocol !== 'https:')
              throw fail(
                'CLOUDFLARE_BROWSER_PROTOCOL_BLOCKED',
                '瀏覽器資源沒有使用 HTTPS，已停止該請求。',
              );
            if (!['GET', 'HEAD'].includes(incoming.method()))
              throw fail(
                'CLOUDFLARE_BROWSER_METHOD_BLOCKED',
                '網站驗收只允許讀取，已停止修改型請求。',
              );
            const outgoing = {};
            const originalRange = incoming.headers().range;
            if (originalRange) outgoing.Range = originalRange;
            const file = filesByUrl.get(url.pathname);
            if (proxy && file?.mime.startsWith('video/')) {
              if (url.search || url.hash)
                throw fail(
                  'CLOUDFLARE_BROWSER_VIDEO_REQUEST',
                  '原生影片驗收僅接受本次清單中的精確媒體網址。',
                );
              nativeVideoRequests.add(url.pathname);
              await route.continue();
              return;
            }
            const response = await request(url, {
              method: incoming.method(),
              headers: outgoing,
              limit: browserLimit,
              collect: true,
            });
            if (file?.mime.startsWith('video/'))
              validateBrowserVideoResponse(
                file,
                incoming.method(),
                originalRange,
                response.statusCode,
                response.headers,
              );
            if (response.statusCode >= 400)
              failures.push({
                code: 'CLOUDFLARE_BROWSER_RESOURCE_FAILED',
                path: url.pathname,
              });
            const headers = { ...response.headers };
            delete headers['transfer-encoding'];
            delete headers['content-encoding'];
            await route.fulfill({
              status: response.statusCode,
              headers,
              body: response.body,
            });
          } catch (error) {
            if (failures.length < 64)
              failures.push({
                code:
                  error instanceof CloudflareError
                    ? error.code
                    : 'CLOUDFLARE_BROWSER_RESOURCE_FAILED',
                path: '/',
              });
            await route.abort('blockedbyclient').catch(() => undefined);
          }
        });
        const page = await session.newPage();
        page.setDefaultTimeout(15_000);
        const played = new Set();
        for (const file of pages) {
          cancelled(context.signal);
          const path = publicPath(file.path);
          currentPath = path;
          stage = 'page-load';
          const response = await page.goto(new URL(path, base).href, {
            waitUntil: 'load',
            timeout: 30_000,
          });
          if (response?.status() !== 200)
            throw fail(
              'CLOUDFLARE_BROWSER_NAVIGATION_FAILED',
              '瀏覽器無法正常開啟本次網站頁面。',
            );
          if (failures.length)
            throw fail(
              failures[0].code,
              '瀏覽器有資源載入失敗或被安全規則阻擋。',
            );
          stage = 'images-and-styles';
          await page.locator('img').evaluateAll((images) => {
            for (const image of images) image.loading = 'eager';
          });
          await page.waitForFunction(
            () =>
              [...globalThis.document.images].every(
                (image) => image.complete && image.naturalWidth > 0,
              ) &&
              [
                ...globalThis.document.querySelectorAll(
                  'link[rel="stylesheet"]',
                ),
              ].every((link) => link.sheet !== null),
          );
          for (const video of await page.locator('video').all()) {
            stage = 'video';
            const url = await video.evaluate(
              (element) =>
                element.currentSrc ||
                element.querySelector('source')?.src ||
                element.src,
            );
            if (played.has(url)) continue;
            played.add(url);
            await video.scrollIntoViewIfNeeded();
            await video.evaluate(async (element) => {
              if (typeof element.requestVideoFrameCallback !== 'function')
                throw new Error('decoded frame callback unavailable');
              const frames = { count: 0, mediaTime: -1 };
              element.__foliohavenVerificationFrames = frames;
              const observe = (_time, metadata) => {
                frames.count++;
                frames.mediaTime = metadata.mediaTime;
                element.requestVideoFrameCallback(observe);
              };
              element.requestVideoFrameCallback(observe);
              element.muted = true;
              element.preload = 'auto';
              await Promise.race([
                element.play(),
                new Promise((_, reject) =>
                  setTimeout(
                    () => reject(new Error('playback timeout')),
                    12_000,
                  ),
                ),
              ]);
            });
            await page.waitForFunction(
              (src) =>
                [...globalThis.document.querySelectorAll('video')].some(
                  (video) =>
                    video.currentSrc === src &&
                    video.readyState >= 2 &&
                    video.error === null &&
                    video.currentTime > 0.02 &&
                    video.__foliohavenVerificationFrames.count > 0 &&
                    video.__foliohavenVerificationFrames.mediaTime > 0.02,
                ),
              url,
            );
            const seek = await video.evaluate((element) => {
              element.pause();
              const target = Math.min(
                element.duration * 0.6,
                Math.max(0, element.duration - 0.05),
              );
              element.currentTime = target;
              return target;
            });
            if (!Number.isFinite(seek) || seek <= 0)
              throw fail(
                'CLOUDFLARE_BROWSER_VIDEO_FAILED',
                '影片缺少可播放及跳轉的有效時間範圍。',
              );
            await page.waitForFunction(
              ({ src, target }) =>
                [...globalThis.document.querySelectorAll('video')].some(
                  (video) =>
                    video.currentSrc === src &&
                    video.readyState >= 2 &&
                    video.error === null &&
                    !video.seeking &&
                    Math.abs(video.currentTime - target) < 0.5,
                ),
              { src: url, target: seek },
            );
            const resumed = await video.evaluate(async (element) => {
              const frames = element.__foliohavenVerificationFrames.count;
              const target = element.currentTime;
              const advance = Math.min(0.12, (element.duration - target) / 3);
              await Promise.race([
                element.play(),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('resume timeout')), 12_000),
                ),
              ]);
              return { frames, target, advance };
            });
            await page.waitForFunction(
              ({ src, frames, target, advance }) =>
                [...globalThis.document.querySelectorAll('video')].some(
                  (video) =>
                    video.currentSrc === src &&
                    video.readyState >= 2 &&
                    video.error === null &&
                    !video.seeking &&
                    video.currentTime > target + advance &&
                    video.__foliohavenVerificationFrames.count > frames &&
                    video.__foliohavenVerificationFrames.mediaTime >
                      target + advance / 2,
                ),
              { src: url, ...resumed },
            );
            await video.evaluate((element) => element.pause());
            await Promise.all([...pendingResponses]);
          }
          if (
            path === '/articles/' &&
            firstArticle?.title &&
            firstArticle?.url
          ) {
            stage = 'search';
            await page.waitForFunction(
              () =>
                globalThis.document
                  .querySelector('[data-search-state]')
                  ?.getAttribute('data-search-state') === 'ready',
            );
            // The boot shell remains in the DOM after hydration. Interact only
            // with the ready search island and use Core's URL normalization.
            const searchRoot = page.locator('[data-search-state]');
            const query = searchRoot.locator('input[type="search"][name="q"]');
            if ((await query.count()) !== 1)
              throw fail(
                'CLOUDFLARE_BROWSER_SEARCH_FAILED',
                '文章總覽缺少唯一可操作的搜尋欄位。',
              );
            const expectedQuery = normalizeSearchQuery(firstArticle.title);
            await query.fill(firstArticle.title);
            await query.press('Enter');
            await page.waitForFunction(
              (expected) =>
                new URL(globalThis.location.href).searchParams.get('q') ===
                  expected &&
                globalThis.document
                  .querySelector('[data-search-state]')
                  ?.getAttribute('data-search-state') === 'ready',
              expectedQuery,
            );
            if (
              !(await searchRoot
                .locator(
                  `.article-card-title a[href=${JSON.stringify(firstArticle.url)}]`,
                )
                .count())
            )
              throw fail(
                'CLOUDFLARE_BROWSER_SEARCH_FAILED',
                '搜尋未顯示索引中的已發布文章。',
              );
            const absent = `__foliohaven_no_result_${context.deploymentId}`;
            await query.fill(absent);
            await query.press('Enter');
            await page.waitForFunction((expected) => {
              const search = globalThis.document.querySelector(
                '[data-search-state]',
              );
              return (
                new URL(globalThis.location.href).searchParams.get('q') ===
                  expected &&
                search?.getAttribute('data-search-state') === 'ready' &&
                search.querySelectorAll('.article-card-title').length === 0
              );
            }, normalizeSearchQuery(absent));
          }
          if (path === '/') {
            stage = 'screenshot';
            await page.screenshot({
              path: join(screenshots, `${name}-home.png`),
              fullPage: false,
            });
          }
        }
        await Promise.all([...pendingResponses]);
        proxy?.assertHealthy();
        if (
          [...nativeVideoRequests].some(
            (path) => !verifiedNativeVideos.has(path),
          )
        )
          throw fail(
            'CLOUDFLARE_BROWSER_VIDEO_RESPONSE',
            '原生影片缺少已核對狀態、MIME、大小與 Range 的 HTTP 回應證據。',
          );
        if (failures.length)
          throw fail(
            failures[0].code,
            '瀏覽器有資源載入失敗或被安全規則阻擋，請檢查同源資源與分流。',
          );
        results.push({
          code: `browser-${name}`,
          status: 'passed',
          message:
            '公開頁面、圖片、樣式、搜尋及影片播放、跳轉後續播與新影格檢查通過。',
          videoTransport: proxy ? 'native-https-stream' : 'injected-buffered',
        });
      } finally {
        context.signal?.removeEventListener('abort', stop);
      }
    } catch (error) {
      cancelled(context.signal);
      results.push({
        code: `browser-${name}`,
        status: 'failed',
        ...(currentPath ? { path: currentPath } : {}),
        stage,
        errorCode:
          error instanceof CloudflareError
            ? error.code
            : 'CLOUDFLARE_BROWSER_CHECK_FAILED',
        message:
          error instanceof CloudflareError
            ? error.message
            : '瀏覽器驗收未完成，請確認瀏覽器工具鏈、網站資源與互動功能。',
      });
    } finally {
      await browser?.close().catch(() => undefined);
      await proxy?.close();
    }
    onCheck?.(results.at(-1));
  }
  return results;
}

/** 測試可注入傳輸；正式 CLI 僅呼叫下方固定依賴的 verifyDomain。 */
export function createDomainVerifier({
  lookup = lookupAddress,
  request = nodeRequest,
  runBrowsers = browserChecks,
} = {}) {
  return async (context, domain) => {
    const base = normalizeDomain(domain);
    if (
      !uuidPattern.test(context.deploymentId) ||
      resolve(context.root) !==
        resolve(
          context.repositoryRoot,
          privateResource(
            context.repositoryRoot,
            `deployments/${context.deploymentId}`,
          ),
        ) ||
      !(
        context.journal?.uploadStatus === 'uploaded' ||
        (context.journal?.uploadStatus === 'failed' &&
          hasUploadProof(context.journal))
      ) ||
      !Array.isArray(context.manifest)
    )
      throw fail(
        'CLOUDFLARE_DOMAIN_CONTEXT_INVALID',
        '請選擇已完成上傳且資料完整的部署紀錄。',
      );
    const seen = new Set();
    const routes = new Set();
    for (const file of context.manifest) {
      if (
        !validPath(file.path) ||
        seen.has(file.path) ||
        !['r2', 'worker'].includes(file.target) ||
        !Number.isSafeInteger(file.byteSize) ||
        file.byteSize < 0 ||
        !digestPattern.test(file.sha256) ||
        typeof file.mime !== 'string' ||
        hasControl(file.mime) ||
        (file.target === 'r2') !== /^(?:assets|media)\//.test(file.path)
      )
        throw fail(
          'CLOUDFLARE_DOMAIN_MANIFEST_INVALID',
          '部署清單的檔案、目標或版本資料不符合規格。',
        );
      seen.add(file.path);
      if (file.path !== '404.html') {
        const path = publicPath(file.path);
        if (routes.has(path))
          throw fail(
            'CLOUDFLARE_DOMAIN_MANIFEST_INVALID',
            '部署清單含映射到同一公開網址的不同檔案。',
          );
        routes.add(path);
      }
    }
    if (
      [
        'index.html',
        '404.html',
        'rss.xml',
        'sitemap-index.xml',
        'robots.txt',
        'search-index.json',
      ].some((file) => !seen.has(file))
    )
      throw fail(
        'CLOUDFLARE_DOMAIN_MANIFEST_INVALID',
        '部署清單缺少首頁、404 或必要網站索引。',
      );
    const startedAt = new Date().toISOString();
    const checks = [];
    let activeCheck = null;
    const report = (status, entries = checks, partial = false) => ({
      schemaVersion: 1,
      deploymentId: context.deploymentId,
      domain: base,
      scope: 'automatic',
      status,
      partial,
      startedAt,
      completedAt: new Date().toISOString(),
      platform: process.platform,
      nodeVersion: process.versions.node,
      checks: entries,
      requiresManualVerification: [
        'cloud-connector-and-no-script-routes',
        'manual-rules-preserved-after-redeploy',
        'large-video-upload-and-update-restore-evidence',
      ],
    });
    const texts = new Map();
    const missingPagePath = fallbackPath(
      context.manifest,
      context.deploymentId,
    );
    const noindex = new Set(['/404.html', '/404/', missingPagePath]);
    const secureRequest = async (
      url,
      { method = 'GET', headers = {}, limit = textLimit, collect = false } = {},
    ) => {
      cancelled(context.signal);
      if (
        url.origin !== new URL(base).origin ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password
      )
        throw fail(
          'CLOUDFLARE_DOMAIN_REDIRECT_BLOCKED',
          '驗收不讀取正式網域以外的網址或重新導向目標。',
        );
      const signal = AbortSignal.any([
        AbortSignal.timeout(requestTimeout),
        ...(context.signal ? [context.signal] : []),
      ]);
      const selected = await resolvePublic(url.hostname, lookup, signal);
      const response = await request(url, {
        method,
        headers: { 'Accept-Encoding': 'identity', ...headers },
        address: selected.address,
        family: selected.family,
        signal,
      });
      return consume(response, limit, collect, signal);
    };
    const check = async (code, path, operation) => {
      activeCheck = { code, path };
      cancelled(context.signal);
      let result;
      try {
        const evidence = await operation();
        result = { code, path, status: 'passed', ...evidence };
      } catch (error) {
        cancelled(context.signal);
        result = {
          code,
          path,
          status: 'failed',
          errorCode:
            error instanceof CloudflareError
              ? error.code
              : 'CLOUDFLARE_DOMAIN_CHECK_FAILED',
          message:
            error instanceof CloudflareError
              ? error.message
              : '此項網站驗收未完成，請檢查部署、DNS、來源與快取。',
        };
      }
      checks.push(result);
      context.onProgress?.({
        event: 'domain-check',
        code,
        path,
        status: result.status,
      });
      activeCheck = null;
    };
    try {
      for (const file of context.manifest) {
        // 404.html 是不具 canonical 的錯誤頁內容，以不存在的路徑驗證。
        const path =
          file.path === '404.html' ? missingPagePath : publicPath(file.path);
        await check('file', path, async () => {
          const local = await hashFile(
            context.root,
            `source/${file.path}`,
            context.signal,
          );
          if (local.sha256 !== file.sha256 || local.byteSize !== file.byteSize)
            throw fail(
              'CLOUDFLARE_DOMAIN_SOURCE_CHANGED',
              '固定部署副本與清單不一致，請保留紀錄並重新部署。',
            );
          const collect = /(?:\.html|\.xml|\.json|robots\.txt)$/.test(
            file.path,
          );
          if (collect && file.byteSize > textLimit)
            throw fail(
              'CLOUDFLARE_DOMAIN_RESPONSE_TOO_LARGE',
              '文字產物超過允許的驗收容量。',
            );
          const response = await secureRequest(new URL(path, base), {
            limit: file.byteSize,
            collect,
          });
          if (response.statusCode !== (file.path === '404.html' ? 404 : 200))
            throw fail(
              'CLOUDFLARE_DOMAIN_HTTP_STATUS',
              '公開檔案沒有在原網址直接回傳預期狀態；請檢查路由、HTML handling 或來源。',
            );
          if (!mimeMatches(file.mime, response.headers['content-type']))
            throw fail(
              'CLOUDFLARE_DOMAIN_MIME',
              '公開檔案的 Content-Type 與檔案用途不一致。',
            );
          if (
            response.sha256 !== file.sha256 ||
            response.byteSize !== file.byteSize
          )
            throw fail(
              'CLOUDFLARE_DOMAIN_CONTENT',
              '公開網址內容與本次部署不同；請檢查 Worker 版本、R2 分流或舊快取。',
            );
          if (collect) texts.set(file.path, response.body.toString('utf8'));
          if (file.path.endsWith('.html')) {
            const actual = htmlData(texts.get(file.path));
            const original = htmlData(await sourceText(context.root, file));
            if (JSON.stringify(actual) !== JSON.stringify(original))
              throw fail(
                'CLOUDFLARE_DOMAIN_SEO_CHANGED',
                '公開 SEO 與本次正式產物不同。',
              );
            const isNoindex = actual.robots.some((value) =>
              /(?:^|,)\s*noindex\s*(?:,|$)/.test(value),
            );
            if (file.path === '404.html') {
              if (actual.canonical.length !== 0 || actual.og.length !== 0)
                throw fail(
                  'CLOUDFLARE_DOMAIN_SEO_404',
                  '404 錯誤頁不得提供 canonical 或 OG URL。',
                );
              if (!isNoindex)
                throw fail(
                  'CLOUDFLARE_DOMAIN_NOINDEX',
                  '404 錯誤頁必須明確設定 noindex。',
                );
            } else {
              if (actual.canonical.length !== 1 || actual.og.length !== 1)
                throw fail(
                  'CLOUDFLARE_DOMAIN_SEO_MISSING',
                  '公開頁面須有唯一 canonical 與 OG URL。',
                );
              for (const url of [...actual.canonical, ...actual.og])
                requireUrl(url, base);
              if (isNoindex)
                noindex.add(requireUrl(actual.canonical[0], base).pathname);
            }
            if (
              !isNoindex &&
              /(?:^|[,\s])noindex(?:[,\s]|$)/i.test(
                response.headers['x-robots-tag'] ?? '',
              )
            )
              throw fail(
                'CLOUDFLARE_DOMAIN_NOINDEX',
                'HTTP 標頭額外將可索引頁面設為 noindex，與網站產物不一致。',
              );
          }
          return {
            httpStatus: response.statusCode,
            byteSize: response.byteSize,
            sha256: response.sha256,
            mime: mime(response.headers['content-type']),
          };
        });
        if (file.target === 'r2') {
          await check('media-head', path, async () => {
            const response = await secureRequest(new URL(path, base), {
              method: 'HEAD',
              limit: 0,
            });
            if (
              response.statusCode !== 200 ||
              Number(response.headers['content-length']) !== file.byteSize ||
              !mimeMatches(file.mime, response.headers['content-type'])
            )
              throw fail(
                'CLOUDFLARE_DOMAIN_MEDIA_HEAD',
                '媒體 HEAD 的狀態、大小或 MIME 不正確。',
              );
            return { httpStatus: 200, byteSize: file.byteSize };
          });
        }
        if (
          file.target === 'r2' &&
          file.mime.startsWith('video/') &&
          file.byteSize > 0
        ) {
          const length = Math.min(32, file.byteSize);
          for (const [kind, range, start, end] of [
            ['single', `bytes=0-${length - 1}`, 0, length - 1],
            [
              'suffix',
              `bytes=-${length}`,
              file.byteSize - length,
              file.byteSize - 1,
            ],
            [
              'open-ended',
              `bytes=${file.byteSize - length}-`,
              file.byteSize - length,
              file.byteSize - 1,
            ],
          ])
            await check(`video-range-${kind}`, path, async () => {
              const response = await secureRequest(new URL(path, base), {
                headers: { Range: range },
                limit: length,
                collect: true,
              });
              if (
                response.statusCode !== 206 ||
                response.headers['content-range'] !==
                  `bytes ${start}-${end}/${file.byteSize}` ||
                Number(response.headers['content-length']) !== length ||
                !mimeMatches(file.mime, response.headers['content-type']) ||
                !response.body.equals(
                  await localBytes(context.root, file.path, start, length),
                )
              )
                throw fail(
                  'CLOUDFLARE_DOMAIN_VIDEO_RANGE',
                  '影片 Range 的 206、Content-Range、長度或內容不正確。',
                );
              return { httpStatus: 206, byteSize: length };
            });
          await check('video-range-unsatisfied', path, async () => {
            const response = await secureRequest(new URL(path, base), {
              headers: { Range: `bytes=${file.byteSize}-` },
              limit: 32768,
            });
            if (
              response.statusCode !== 416 ||
              response.headers['content-range'] !== `bytes */${file.byteSize}`
            )
              throw fail(
                'CLOUDFLARE_DOMAIN_VIDEO_RANGE',
                '超出影片範圍的請求須回傳 416 與正確總長度。',
              );
            return { httpStatus: 416 };
          });
        }
      }
      await check('indexes-and-noindex', '/', async () => {
        const sitemapUrls = [];
        for (const [path, text] of texts) {
          if (/^sitemap.*\.xml$/.test(path))
            for (const value of xmlValues(text, 'loc')) {
              const url = requireUrl(value, base);
              if (noindex.has(url.pathname))
                throw fail(
                  'CLOUDFLARE_DOMAIN_NOINDEX',
                  'noindex 頁面不可列入 Sitemap。',
                );
              sitemapUrls.push(url.pathname);
            }
          if (path === 'rss.xml')
            for (const value of xmlValues(text, 'link'))
              requireUrl(value, base);
          if (path === 'robots.txt')
            for (const match of text.matchAll(/^Sitemap:\s*(\S+)\s*$/gim))
              requireUrl(match[1], base);
          if (path === 'search-index.json') {
            let index;
            try {
              index = JSON.parse(text);
            } catch {
              throw fail(
                'CLOUDFLARE_DOMAIN_INDEX_INVALID',
                '搜尋索引不是有效 JSON。',
              );
            }
            if (!Array.isArray(index.articles))
              throw fail(
                'CLOUDFLARE_DOMAIN_INDEX_INVALID',
                '搜尋索引缺少文章清單。',
              );
            for (const article of index.articles) {
              if (
                typeof article.url !== 'string' ||
                !article.url.startsWith('/') ||
                article.url.startsWith('//') ||
                !context.manifest.some(
                  (file) => publicPath(file.path) === article.url,
                )
              )
                throw fail(
                  'CLOUDFLARE_DOMAIN_PUBLIC_BOUNDARY',
                  '搜尋索引含不屬於本次公開網站的文章網址。',
                );
            }
          }
        }
        return { noindexPages: noindex.size, sitemapUrls: sitemapUrls.length };
      });
      for (const path of [
        `/__foliohaven-missing-${context.deploymentId}/`,
        `/assets/__foliohaven-missing-${context.deploymentId}`,
        '/.foliohaven/',
        '/.alfred/',
        '/content/site.json',
      ])
        await check('missing-and-private', path, async () => {
          const response = await secureRequest(new URL(path, base), {
            limit: textLimit,
          });
          if (response.statusCode !== 404)
            throw fail(
              'CLOUDFLARE_DOMAIN_404',
              '不存在的頁面、資源及私有來源路徑必須回真正 404。',
            );
          return { httpStatus: 404 };
        });
      if (checks.every((entry) => entry.status === 'passed')) {
        activeCheck = { code: 'browsers', path: '/' };
        const browserResults = await runBrowsers(
          context,
          base,
          secureRequest,
          texts,
          (entry) => {
            checks.push(entry);
          },
          { useNativeVideo: request === nodeRequest, lookup },
        );
        for (const entry of browserResults)
          if (!checks.includes(entry)) checks.push(entry);
        activeCheck = null;
      } else
        checks.push({
          code: 'browsers',
          status: 'failed',
          errorCode: 'CLOUDFLARE_DOMAIN_PREREQUISITE_FAILED',
          message: '先修正 HTTP、內容或 SEO 失敗項目，再進行瀏覽器驗收。',
        });
      return report(
        checks.every((entry) => entry.status === 'passed')
          ? 'passed'
          : 'failed',
      );
    } catch (error) {
      const aborted =
        context.signal?.aborted || error?.code === 'CLOUDFLARE_CANCELLED';
      const failure = aborted
        ? fail(
            'CLOUDFLARE_CANCELLED',
            '網站驗收已取消，已完成項目已保留，其餘尚未驗證。',
          )
        : error instanceof CloudflareError
          ? error
          : fail(
              'CLOUDFLARE_DOMAIN_CHECK_FAILED',
              '網站驗收未完成，已完成項目已保留，請檢查工具鏈與部署來源。',
            );
      const terminal = {
        code: aborted ? 'verification-cancelled' : 'verification-failed',
        path: activeCheck?.path ?? '/',
        interruptedCheck: activeCheck?.code ?? 'verification',
        status: 'failed',
        errorCode: failure.code,
        message: failure.message,
      };
      failure.verificationReport = report(
        aborted ? 'cancelled' : 'failed',
        [...checks, terminal],
        true,
      );
      throw failure;
    }
  };
}

export const verifyDomain = createDomainVerifier();
