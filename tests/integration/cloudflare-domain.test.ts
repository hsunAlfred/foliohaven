import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSearchQuery } from '@foliohaven/core';
import {
  buildProcessEnvironment,
  runControlledProcess,
} from '@foliohaven/server';
import {
  createDomainVerifier,
  isPublicAddress,
  normalizeDomain,
} from '../../scripts/cloudflare/verify-domain.mjs';
import type {
  DomainCheck,
  DomainContext,
  DomainFile,
  DomainRequestOptions,
  DomainResponse,
  DomainVerifierDependencies,
  DomainVerificationFailure,
} from '../../scripts/cloudflare/verify-domain.mjs';

const domain = 'https://blog.example.com/';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const html = (
  path: string | null,
  content = '<h1>測試網站</h1>',
  noindex = false,
) =>
  Buffer.from(
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>測試</title>${path === null ? '' : `<link rel="canonical" href="${domain.slice(0, -1)}${path}"><meta property="og:url" content="${domain.slice(0, -1)}${path}">`}<meta name="robots" content="${noindex ? 'noindex' : 'index'},follow"><link rel="stylesheet" href="/assets/site.css"></head><body>${content}</body></html>`,
  );
interface Fixture {
  context: DomainContext;
  files: Map<string, Buffer>;
  mime: Map<string, string>;
  calls: { url: URL; options: DomainRequestOptions }[];
  lookup: NonNullable<DomainVerifierDependencies['lookup']>;
  request: (url: URL, options: DomainRequestOptions) => Promise<DomainResponse>;
}
async function body(bytes: Buffer) {
  return (async function* () {
    for (let offset = 0; offset < bytes.length; offset += 65_536)
      yield bytes.subarray(offset, offset + 65_536);
  })();
}
const browserSuccess = async (): Promise<readonly DomainCheck[]> =>
  ['chromium', 'firefox', 'webkit'].map((name) => ({
    code: `browser-${name}`,
    status: 'passed',
  }));
async function fixture({
  video = false,
  largeVideo = false,
  codedLargeVideo = false,
  webmVideo = false,
  videoBelowViewport = false,
  externalImage = false,
  websocket = false,
  searchBoot = false,
  articleTitle = '第一篇文章',
} = {}): Promise<Fixture> {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), 'alfred-cloudflare-domain-'),
  );
  roots.push(repositoryRoot);
  const deploymentId = randomUUID();
  const root = join(repositoryRoot, '.alfred/deployments', deploymentId);
  const files = new Map<string, Buffer>([
    [
      'index.html',
      html(
        '/',
        `<h1>測試網站</h1><img width="20" height="20" src="${externalImage ? 'https://127.0.0.1/private.png' : '/media/image.svg'}">${websocket ? '<script>new WebSocket("wss://127.0.0.1/private")</script>' : ''}`,
      ),
    ],
    [
      'articles/index.html',
      html(
        '/articles/',
        (searchBoot
          ? '<section hidden><input type="search" name="q" readonly tabindex="-1"></section><aside><form><input type="search" name="q"><button>側邊搜尋</button></form><h2 class="article-card-title"><a href="/notes/first/">側邊文章</a></h2></aside>'
          : '') +
          '<main data-search-state="loading"><form><input type="search" name="q"><button>搜尋</button></form><div id="results"></div></main><script src="/assets/search.js"></script>',
      ),
    ],
    [
      'notes/first/index.html',
      html(
        '/notes/first/',
        `<h1>${articleTitle}</h1>` +
          (video
            ? (videoBelowViewport
                ? '<div style="height:2200px">影片位於文章下方</div>'
                : '') +
              (webmVideo
                ? '<video controls playsinline preload="metadata"><source src="/media/video.webm" type="video/webm"></video>'
                : '<video controls preload="metadata" src="/media/video.mp4"></video>')
            : ''),
      ),
    ],
    [
      'notes/noindex/index.html',
      html('/notes/noindex/', '<h1>不列入搜尋引擎</h1>', true),
    ],
    ['404.html', html(null, '<h1>找不到頁面</h1>', true)],
    [
      'assets/site.css',
      Buffer.from('body { font: 18px sans-serif; color: #123; }'),
    ],
    [
      'assets/search.js',
      Buffer.from(
        `fetch('/search-index.json').then(r=>r.json()).then(index=>{
          const normalize=value=>value.normalize('NFKC').trim().replace(/\\s+/gu,' ').toLowerCase();
          const main=document.querySelector('[data-search-state]');
          const input=main.querySelector('input[name="q"]');
          const render=()=>{main.querySelector('#results').innerHTML=index.articles.filter(a=>normalize(a.title).includes(normalize(input.value))).map(a=>'<h2 class="article-card-title"><a href="'+a.url+'">'+a.title+'</a></h2>').join('');};
          render();main.dataset.searchState='ready';
          main.querySelector('form').addEventListener('submit',async event=>{
            event.preventDefault();main.dataset.searchState='loading';
            input.value=normalize(input.value);history.pushState({},'', '?q='+encodeURIComponent(input.value));
            ${searchBoot ? "await fetch('/search-index.json?fixture-query='+encodeURIComponent(input.value));" : ''}
            render();main.dataset.searchState='ready';
          });
        });`,
      ),
    ],
    [
      'media/image.svg',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#456"/></svg>',
      ),
    ],
    [
      'rss.xml',
      Buffer.from(
        `<rss><channel><link>${domain}</link><item><link>${domain}notes/first/</link></item></channel></rss>`,
      ),
    ],
    [
      'sitemap-index.xml',
      Buffer.from(
        `<sitemapindex><sitemap><loc>${domain}sitemap-0.xml</loc></sitemap></sitemapindex>`,
      ),
    ],
    [
      'sitemap-0.xml',
      Buffer.from(
        `<urlset><url><loc>${domain}</loc></url><url><loc>${domain}notes/first/</loc></url></urlset>`,
      ),
    ],
    [
      'robots.txt',
      Buffer.from(
        `User-agent: *\nAllow: /\nSitemap: ${domain}sitemap-index.xml\n`,
      ),
    ],
    [
      'search-index.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          articles: [{ title: articleTitle, url: '/notes/first/' }],
        }),
      ),
    ],
  ]);
  if (video) {
    const original = fileURLToPath(
      new URL(
        '../fixtures/samples/reference/media/source/68789bc2-e491-4dbe-81de-f1a42adb7234/original.mp4',
        import.meta.url,
      ),
    );
    let bytes = await readFile(original);
    if (webmVideo) {
      const output = join(repositoryRoot, 'fixture-video.webm');
      await runControlledProcess({
        command: 'ffmpeg',
        args: [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          original,
          '-an',
          '-c:v',
          'libvpx-vp9',
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          '-threads',
          '2',
          '-pix_fmt',
          'yuv420p',
          '-map_metadata',
          '-1',
          output,
        ],
        cwd: repositoryRoot,
        env: buildProcessEnvironment(),
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
      });
      bytes = await readFile(output);
    }
    if (codedLargeVideo) {
      const output = join(repositoryRoot, 'fixture-coded-large.mp4');
      await runControlledProcess({
        command: 'ffmpeg',
        args: [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-stream_loop',
          '-1',
          '-i',
          original,
          '-t',
          '12',
          '-vf',
          'scale=320:180,noise=alls=40:allf=t',
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '6',
          '-profile:v',
          'main',
          '-pix_fmt',
          'yuv420p',
          '-threads',
          '2',
          '-map_metadata',
          '-1',
          '-movflags',
          '+faststart',
          output,
        ],
        cwd: repositoryRoot,
        env: buildProcessEnvironment(),
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
      });
      bytes = await readFile(output);
    }
    if (largeVideo) {
      // ISO BMFF 的 free box 是合法填充，不改原本可播放影片的時間軸。
      const padding = Buffer.alloc(26 * 1024 * 1024);
      padding.writeUInt32BE(padding.length);
      padding.write('free', 4, 'ascii');
      bytes = Buffer.concat([bytes, padding]);
    }
    files.set(webmVideo ? 'media/video.webm' : 'media/video.mp4', bytes);
  }
  const mime = new Map<string, string>();
  const manifest: DomainFile[] = [];
  for (const [path, bytes] of files) {
    await mkdir(join(root, 'source', path, '..'), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(root, 'source', path), bytes);
    const type = path.endsWith('.html')
      ? 'text/html'
      : path.endsWith('.xml')
        ? 'application/xml'
        : path.endsWith('.css')
          ? 'text/css'
          : path.endsWith('.js')
            ? 'text/javascript'
            : path.endsWith('.svg')
              ? 'image/svg+xml'
              : path.endsWith('.mp4')
                ? 'video/mp4'
                : path.endsWith('.webm')
                  ? 'video/webm'
                  : path.endsWith('.json')
                    ? 'application/json'
                    : 'text/plain';
    mime.set(path, type);
    manifest.push({
      path,
      target: /^(?:assets|media)\//.test(path) ? 'r2' : 'worker',
      byteSize: bytes.length,
      sha256: sha(bytes),
      mime: type,
    });
  }
  const calls: Fixture['calls'] = [];
  const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  const request = async (
    url: URL,
    options: DomainRequestOptions,
  ): Promise<DomainResponse> => {
    calls.push({ url, options });
    let path = decodeURIComponent(
      url.pathname === '/'
        ? 'index.html'
        : url.pathname.endsWith('/')
          ? url.pathname.slice(1) + 'index.html'
          : url.pathname.slice(1),
    );
    if (!files.has(path) && path.endsWith('/index.html')) {
      const alternate = path.slice(0, -11) + '.html';
      if (files.has(alternate)) path = alternate;
    }
    const value = files.get(path);
    const status = value ? (path === '404.html' ? 404 : 200) : 404;
    const fallback =
      !value && !/^(?:assets|media)\//.test(path)
        ? files.get('404.html')
        : undefined;
    const bytes = value ?? fallback ?? Buffer.from('Not found');
    const headers: Record<string, string> = {
      'content-type': mime.get(path) ?? (fallback ? 'text/html' : 'text/plain'),
      'content-length': String(bytes.length),
    };
    const range = options.headers.Range;
    if (value && range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) throw new Error('Invalid fixture Range');
      const start = match[1]
        ? Number(match[1])
        : Math.max(0, bytes.length - Number(match[2]));
      const end =
        match[1] && match[2]
          ? Math.min(Number(match[2]), bytes.length - 1)
          : bytes.length - 1;
      if (start >= bytes.length || start > end)
        return {
          statusCode: 416,
          headers: {
            'content-range': `bytes */${bytes.length}`,
            'content-length': '0',
          },
          body: await body(Buffer.alloc(0)),
        };
      const part = bytes.subarray(start, end + 1);
      return {
        statusCode: 206,
        headers: {
          ...headers,
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
          'content-length': String(part.length),
        },
        body: await body(options.method === 'HEAD' ? Buffer.alloc(0) : part),
      };
    }
    return {
      statusCode: status,
      headers,
      body: await body(options.method === 'HEAD' ? Buffer.alloc(0) : bytes),
    };
  };
  return {
    context: {
      repositoryRoot,
      root,
      deploymentId,
      journal: { uploadStatus: 'uploaded' },
      manifest,
    },
    files,
    mime,
    lookup,
    request,
    calls,
  };
}
async function addFixtureFile(
  fixture: Fixture,
  path: string,
  bytes: Buffer,
  mime: string,
) {
  fixture.files.set(path, bytes);
  fixture.mime.set(path, mime);
  await mkdir(join(fixture.context.root, 'source', path, '..'), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(fixture.context.root, 'source', path), bytes);
  fixture.context = {
    ...fixture.context,
    manifest: [
      ...fixture.context.manifest,
      {
        path,
        target: 'worker',
        byteSize: bytes.length,
        sha256: sha(bytes),
        mime,
      },
    ],
  };
}
async function replaceFixtureFile(
  fixture: Fixture,
  path: string,
  bytes: Buffer,
) {
  if (!fixture.files.has(path)) throw new Error('Fixture file missing');
  fixture.files.set(path, bytes);
  await writeFile(join(fixture.context.root, 'source', path), bytes);
  fixture.context = {
    ...fixture.context,
    manifest: fixture.context.manifest.map((file) =>
      file.path === path
        ? { ...file, byteSize: bytes.length, sha256: sha(bytes) }
        : file,
    ),
  };
}
function previouslyUploaded(fixture: Fixture) {
  const target = {
    schemaVersion: 1,
    accountId: 'a'.repeat(32),
    workerName: 'fixture-blog',
    bucketName: 'fixture-assets',
  };
  const manifestDigest = sha(
    Buffer.from(JSON.stringify(fixture.context.manifest)),
  );
  const artifactDigest = 'b'.repeat(64);
  const worker = {
    status: 'uploaded',
    after: { versionId: randomUUID(), deploymentId: randomUUID() },
  };
  return {
    uploadStatus: 'failed',
    deploymentId: fixture.context.deploymentId,
    target,
    manifestDigest,
    artifactDigest,
    worker,
    uploadProof: {
      schemaVersion: 1,
      deploymentId: fixture.context.deploymentId,
      manifestDigest,
      artifactDigest,
      targetDigest: sha(
        Buffer.from(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(target).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            ),
          ),
        ),
      ),
      r2Verified: true,
      workerVersion: worker.after.versionId,
      workerDeploymentId: worker.after.deploymentId,
      verifiedAt: '2026-10-26T07:00:00.000Z',
    },
  };
}

describe('Cloudflare domain validation and safe networking', () => {
  it('normalizes a hostname or HTTPS root and rejects ambiguous or internal targets', () => {
    expect(normalizeDomain('blog.example.com')).toBe(domain);
    expect(normalizeDomain('https://BLOG.example.com/')).toBe(domain);
    for (const invalid of [
      '',
      'http://blog.example.com',
      'https://user:password@blog.example.com/',
      'https://blog.example.com:443/',
      'https://blog.example.com/path',
      'https://blog.example.com/?q=1',
      'https://blog.example.com/#fragment',
      'localhost',
      'localhost.localdomain',
      'api.local',
      'api.internal',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://0x7f000001/',
      'https://blog.example.com\n',
    ]) {
      expect(() => normalizeDomain(invalid)).toThrow();
    }
  });

  it('classifies mapped, private, reserved and public IPv4/IPv6 without trusting DNS labels', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.1.2',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.0.1',
      '192.0.2.1',
      '198.18.1.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:8.8.8.8',
      '2001:db8::1',
      '2002:7f00:1::',
      'not-an-ip',
    ])
      expect(isPublicAddress(address)).toBe(false);
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
    ])
      expect(isPublicAddress(address)).toBe(true);
  });

  it('checks every file, original XML routes, identity bytes, SEO, media HEAD and real 404 responses', async () => {
    const f = await fixture();
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('passed');
    expect(report.scope).toBe('automatic');
    expect(report.requiresManualVerification).toContain(
      'cloud-connector-and-no-script-routes',
    );
    expect(report.checks.filter((check) => check.code === 'file')).toHaveLength(
      f.context.manifest.length,
    );
    expect(
      f.calls.some((call) => call.url.pathname === '/sitemap-index.xml'),
    ).toBe(true);
    expect(
      f.calls.some((call) => call.url.pathname === '/sitemap-index.xml/'),
    ).toBe(false);
    expect(
      f.calls.every(
        (call) =>
          call.options.address === '8.8.8.8' &&
          call.options.family === 4 &&
          call.options.headers['Accept-Encoding'] === 'identity',
      ),
    ).toBe(true);
    expect(
      report.checks.filter((check) => check.code === 'missing-and-private'),
    ).toHaveLength(4);
  });

  it('keeps an injected fake transport offline instead of enabling native video connections', async () => {
    const f = await fixture({ video: true });
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: async (
        _context,
        _base,
        _request,
        _texts,
        _onCheck,
        options,
      ) => {
        expect(options?.useNativeVideo).toBe(false);
        return browserSuccess();
      },
    })(f.context, domain);
    expect(report.status).toBe('passed');
  });

  it('verifies 404.html bytes through a genuinely missing route even when the file URL redirects', async () => {
    const f = await fixture();
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: async (url, options) => {
        if (url.pathname === '/404.html')
          return {
            statusCode: 308,
            headers: { location: '/404/' },
            body: await body(Buffer.alloc(0)),
          };
        return f.request(url, options);
      },
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('passed');
    const fallback = report.checks.find(
      (check) =>
        check.code === 'file' &&
        check.path === `/__alfred_not_found_${f.context.deploymentId}/`,
    );
    const source = f.files.get('404.html');
    if (!source) throw new Error('Fixture 404 missing');
    expect(source.toString()).toContain('content="noindex,follow"');
    expect(source.toString()).not.toContain('rel="canonical"');
    expect(source.toString()).not.toContain('property="og:url"');
    expect(fallback).toMatchObject({
      status: 'passed',
      httpStatus: 404,
      sha256: sha(source),
      byteSize: source.length,
      mime: 'text/html',
    });
    expect(f.calls.some((call) => call.url.pathname === '/404.html')).toBe(
      false,
    );
  });

  it.each([
    {
      name: 'missing noindex',
      bytes: html(null, '<h1>找不到頁面</h1>'),
      errorCode: 'CLOUDFLARE_DOMAIN_NOINDEX',
    },
    {
      name: 'unexpected canonical',
      bytes: Buffer.from(
        html(null, '<h1>找不到頁面</h1>', true)
          .toString()
          .replace(
            '</head>',
            `<link rel="canonical" href="${domain}404.html"></head>`,
          ),
      ),
      errorCode: 'CLOUDFLARE_DOMAIN_SEO_404',
    },
    {
      name: 'unexpected OG URL',
      bytes: Buffer.from(
        html(null, '<h1>找不到頁面</h1>', true)
          .toString()
          .replace(
            '</head>',
            `<meta property="og:url" content="${domain}404/"></head>`,
          ),
      ),
      errorCode: 'CLOUDFLARE_DOMAIN_SEO_404',
    },
  ])(
    'rejects a source-matching 404 with $name',
    async ({ bytes, errorCode }) => {
      const f = await fixture();
      await replaceFixtureFile(f, '404.html', bytes);
      const report = await createDomainVerifier({
        lookup: f.lookup,
        request: f.request,
        runBrowsers: browserSuccess,
      })(f.context, domain);
      expect(report.status).toBe('failed');
      expect(
        report.checks.find(
          (check) =>
            check.code === 'file' &&
            check.path === `/__alfred_not_found_${f.context.deploymentId}/`,
        ),
      ).toMatchObject({ status: 'failed', errorCode });
    },
  );

  it.each(['/404.html', '/404/', 'missing-page'])(
    'rejects a 404 route included in Sitemap: %s',
    async (route) => {
      const f = await fixture();
      const path =
        route === 'missing-page'
          ? `/__alfred_not_found_${f.context.deploymentId}/`
          : route;
      await replaceFixtureFile(
        f,
        'sitemap-0.xml',
        Buffer.from(
          `<urlset><url><loc>${new URL(path, domain).href}</loc></url></urlset>`,
        ),
      );
      const report = await createDomainVerifier({
        lookup: f.lookup,
        request: f.request,
        runBrowsers: browserSuccess,
      })(f.context, domain);
      expect(report.status).toBe('failed');
      expect(
        report.checks.find((check) => check.code === 'indexes-and-noindex'),
      ).toMatchObject({
        status: 'failed',
        errorCode: 'CLOUDFLARE_DOMAIN_NOINDEX',
      });
    },
  );

  it('continues to require canonical on normal HTML even when original and public bytes match', async () => {
    const f = await fixture();
    const bytes = Buffer.from(
      html('/')
        .toString()
        .replace(/<link rel="canonical"[^>]*>/, ''),
    );
    await replaceFixtureFile(f, 'index.html', bytes);
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('failed');
    expect(
      report.checks.find(
        (check) => check.code === 'file' && check.path === '/',
      ),
    ).toMatchObject({
      status: 'failed',
      errorCode: 'CLOUDFLARE_DOMAIN_SEO_MISSING',
    });
  });

  it('does not accept a generic 404 body instead of the deployed custom 404 artifact', async () => {
    const f = await fixture();
    const path = `/__alfred_not_found_${f.context.deploymentId}/`;
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: async (url, options) => {
        if (url.pathname === path)
          return {
            statusCode: 404,
            headers: { 'content-type': 'text/html' },
            body: await body(Buffer.from('Other 404 response')),
          };
        return f.request(url, options);
      },
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(
      report.checks.find(
        (check) => check.code === 'file' && check.path === path,
      )?.errorCode,
    ).toBe('CLOUDFLARE_DOMAIN_CONTENT');
  });

  it('chooses a missing namespace that cannot collide with any manifest file or directory', async () => {
    const f = await fixture();
    const prefix = `__alfred_not_found_${f.context.deploymentId}`;
    await addFixtureFile(
      f,
      `${prefix}/index.html`,
      html(`/${prefix}/`),
      'text/html',
    );
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('passed');
    expect(
      report.checks.find(
        (check) => check.code === 'file' && check.path === `/${prefix}_1/`,
      ),
    ).toMatchObject({ status: 'passed', httpStatus: 404 });
    expect(
      report.checks.find(
        (check) => check.code === 'file' && check.path === `/${prefix}/`,
      ),
    ).toMatchObject({ status: 'passed', httpStatus: 200 });
  });

  it('maps an ordinary non-index HTML file to its force-trailing-slash public URL', async () => {
    const f = await fixture();
    await addFixtureFile(f, 'intro.html', html('/intro/'), 'text/html');
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('passed');
    expect(
      report.checks.find(
        (check) => check.code === 'file' && check.path === '/intro/',
      ),
    ).toMatchObject({ status: 'passed', httpStatus: 200 });
    expect(f.calls.some((call) => call.url.pathname === '/intro.html')).toBe(
      false,
    );
  });

  it('rejects conflicting HTML files that would share one canonical public URL before connecting', async () => {
    const f = await fixture();
    await addFixtureFile(f, 'intro.html', html('/intro/'), 'text/html');
    await addFixtureFile(f, 'intro/index.html', html('/intro/'), 'text/html');
    await expect(
      createDomainVerifier({
        lookup: f.lookup,
        request: f.request,
        runBrowsers: browserSuccess,
      })(f.context, domain),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_DOMAIN_MANIFEST_INVALID' });
    expect(f.calls).toHaveLength(0);
  });

  it('does not open connections when DNS includes even one private answer', async () => {
    const f = await fixture();
    const report = await createDomainVerifier({
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      request: f.request,
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('failed');
    expect(f.calls).toHaveLength(0);
    expect(
      report.checks.some(
        (check) => check.errorCode === 'CLOUDFLARE_DOMAIN_ADDRESS_BLOCKED',
      ),
    ).toBe(true);
  });

  it('rechecks DNS per request and stops a rebinding result before the next connection', async () => {
    const f = await fixture();
    let lookups = 0;
    const report = await createDomainVerifier({
      lookup: async () =>
        ++lookups === 1
          ? [{ address: '8.8.8.8', family: 4 }]
          : [{ address: '169.254.169.254', family: 4 }],
      request: f.request,
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('failed');
    expect(f.calls).toHaveLength(1);
  });

  it('reports redirects without following an external or private Location', async () => {
    const f = await fixture();
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: async (url, options) =>
        url.pathname.endsWith('.xml')
          ? {
              statusCode: 302,
              headers: { location: 'http://169.254.169.254/private' },
              body: await body(Buffer.alloc(0)),
            }
          : f.request(url, options),
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('failed');
    expect(
      f.calls.every((call) => call.url.hostname === 'blog.example.com'),
    ).toBe(true);
    expect(
      report.checks.find((check) => check.path === '/sitemap-index.xml')
        ?.errorCode,
    ).toBe('CLOUDFLARE_DOMAIN_HTTP_STATUS');
  });

  it('detects stale content at the unchanged URL and unexpected MIME independently', async () => {
    const f = await fixture();
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: async (url, options) => {
        const response = await f.request(url, options);
        if (url.pathname === '/assets/site.css' && options.method === 'GET')
          return {
            ...response,
            body: await body(Buffer.from('old cached stylesheet')),
          };
        if (url.pathname === '/media/image.svg')
          return {
            ...response,
            headers: { ...response.headers, 'content-type': 'text/html' },
          };
        return response;
      },
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('failed');
    expect(
      report.checks.find(
        (check) => check.code === 'file' && check.path === '/assets/site.css',
      )?.errorCode,
    ).toBe('CLOUDFLARE_DOMAIN_CONTENT');
    expect(
      report.checks.find(
        (check) => check.code === 'file' && check.path === '/media/image.svg',
      )?.errorCode,
    ).toBe('CLOUDFLARE_DOMAIN_MIME');
  });

  it('rejects author source drift before reading that public file', async () => {
    const f = await fixture();
    await writeFile(
      join(f.context.root, 'source/index.html'),
      'modified source',
    );
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(
      report.checks.find((check) => check.code === 'file' && check.path === '/')
        ?.errorCode,
    ).toBe('CLOUDFLARE_DOMAIN_SOURCE_CHANGED');
    expect(f.calls.some((call) => call.url.pathname === '/')).toBe(false);
  });

  it('rejects incorrect source siteUrl even if public bytes exactly match the uploaded version', async () => {
    const f = await fixture();
    const bytes = html('/')
      .toString()
      .replaceAll(domain, 'https://example.invalid/');
    f.files.set('index.html', Buffer.from(bytes));
    await writeFile(join(f.context.root, 'source/index.html'), bytes);
    const manifest = f.context.manifest.map((file) =>
      file.path === 'index.html'
        ? {
            ...file,
            byteSize: Buffer.byteLength(bytes),
            sha256: sha(Buffer.from(bytes)),
          }
        : file,
    );
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: browserSuccess,
    })({ ...f.context, manifest }, domain);
    expect(
      report.checks.find((check) => check.code === 'file' && check.path === '/')
        ?.errorCode,
    ).toBe('CLOUDFLARE_DOMAIN_SEO_URL');
  });

  it.each([
    {
      path: 'sitemap-0.xml',
      bytes: Buffer.from(
        `<urlset><url><loc>${domain}notes/noindex/</loc></url></urlset>`,
      ),
      errorCode: 'CLOUDFLARE_DOMAIN_NOINDEX',
    },
    {
      path: 'search-index.json',
      bytes: Buffer.from(
        JSON.stringify({ articles: [{ url: '/draft/private/' }] }),
      ),
      errorCode: 'CLOUDFLARE_DOMAIN_PUBLIC_BOUNDARY',
    },
  ])(
    'rejects an invalid public boundary in $path',
    async ({ path, bytes: replacement, errorCode }) => {
      const f = await fixture();
      f.files.set(path, replacement);
      const manifest: DomainFile[] = [];
      for (const file of f.context.manifest) {
        const bytes = f.files.get(file.path);
        if (!bytes) throw new Error('Fixture file missing');
        await writeFile(join(f.context.root, 'source', file.path), bytes);
        manifest.push({ ...file, byteSize: bytes.length, sha256: sha(bytes) });
      }
      const report = await createDomainVerifier({
        lookup: f.lookup,
        request: f.request,
        runBrowsers: browserSuccess,
      })({ ...f.context, manifest }, domain);
      expect(
        report.checks.find((check) => check.code === 'indexes-and-noindex')
          ?.errorCode,
      ).toBe(errorCode);
      expect(report.status).toBe('failed');
    },
  );

  it('validates single, suffix, open-ended and invalid video byte ranges', async () => {
    const f = await fixture({ video: true });
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('passed');
    expect(
      report.checks
        .filter((check) => check.code.startsWith('video-range-'))
        .map((check) => check.httpStatus),
    ).toEqual([206, 206, 206, 416]);
  });

  it('reports incorrect Range responses rather than accepting a complete 200 video', async () => {
    const f = await fixture({ video: true });
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: async (url, options) => {
        if (options.headers.Range)
          return {
            statusCode: 200,
            headers: { 'content-length': '0' },
            body: await body(Buffer.alloc(0)),
          };
        return f.request(url, options);
      },
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('failed');
    expect(
      report.checks
        .filter((check) => check.code.startsWith('video-range-'))
        .every((check) => check.status === 'failed'),
    ).toBe(true);
  });

  it('streams a file larger than the Worker limit without collecting the complete response', async () => {
    const f = await fixture();
    const size = 33 * 1024 * 1024;
    const bytes = Buffer.alloc(1024 * 1024);
    const hash = createHash('sha256');
    for (let index = 0; index < 33; index++) hash.update(bytes);
    const handle = await open(
      join(f.context.root, 'source/media/large.bin'),
      'wx',
      0o600,
    );
    await handle.truncate(size);
    await handle.close();
    const file: DomainFile = {
      path: 'media/large.bin',
      target: 'r2',
      byteSize: size,
      sha256: hash.digest('hex'),
      mime: 'application/octet-stream',
    };
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: async (url, options) => {
        if (url.pathname !== '/media/large.bin') return f.request(url, options);
        return {
          statusCode: 200,
          headers: {
            'content-length': String(size),
            'content-type': file.mime,
          },
          body: (async function* () {
            if (options.method !== 'HEAD')
              for (let index = 0; index < 33; index++) yield bytes;
          })(),
        };
      },
      runBrowsers: browserSuccess,
    })({ ...f.context, manifest: [...f.context.manifest, file] }, domain);
    expect(report.status).toBe('passed');
    expect(
      report.checks.find(
        (check) => check.code === 'file' && check.path === '/media/large.bin',
      )?.byteSize,
    ).toBe(size);
  });

  it('refuses invalid or incomplete deployment contexts and unsafe manifest paths before network', async () => {
    const f = await fixture();
    const verify = createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: browserSuccess,
    });
    await expect(
      verify({ ...f.context, journal: { uploadStatus: 'unknown' } }, domain),
    ).rejects.toThrow();
    await expect(
      verify(
        { ...f.context, root: join(f.context.repositoryRoot, 'other') },
        domain,
      ),
    ).rejects.toThrow();
    const first = f.context.manifest[0];
    if (!first) throw new Error('Fixture manifest missing');
    await expect(
      verify(
        {
          ...f.context,
          manifest: [{ ...first, path: '../private' }],
        },
        domain,
      ),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it('accepts the immutable manifest of a previously successful deployment after its current status became failed', async () => {
    const f = await fixture();
    const journal = previouslyUploaded(f);
    const original = JSON.stringify(journal.uploadProof);
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: browserSuccess,
    })({ ...f.context, journal }, domain);
    expect(report.status).toBe('passed');
    expect(report.checks.filter((check) => check.code === 'file')).toHaveLength(
      f.context.manifest.length,
    );
    expect(journal.uploadStatus).toBe('failed');
    expect(JSON.stringify(journal.uploadProof)).toBe(original);
  });

  it('rejects failed records with missing, forged or mismatched upload proof before connecting', async () => {
    const f = await fixture();
    const journal = previouslyUploaded(f);
    const verify = createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: browserSuccess,
    });
    for (const invalid of [
      { uploadStatus: 'failed' },
      {
        ...journal,
        uploadProof: { ...journal.uploadProof, r2Verified: false },
      },
      {
        ...journal,
        uploadProof: { ...journal.uploadProof, manifestDigest: 'c'.repeat(64) },
      },
      { ...journal, manifestDigest: 'd'.repeat(64) },
      { ...journal, artifactDigest: 'e'.repeat(64) },
      {
        ...journal,
        worker: {
          ...journal.worker,
          after: { ...journal.worker.after, versionId: randomUUID() },
        },
      },
      {
        ...journal,
        worker: {
          ...journal.worker,
          after: { ...journal.worker.after, deploymentId: randomUUID() },
        },
      },
      { ...journal, target: { ...journal.target, bucketName: 'other-bucket' } },
      {
        ...journal,
        uploadProof: { ...journal.uploadProof, verifiedAt: 'invalid' },
      },
    ])
      await expect(
        verify({ ...f.context, journal: invalid }, domain),
      ).rejects.toMatchObject({ code: 'CLOUDFLARE_DOMAIN_CONTEXT_INVALID' });
    expect(f.calls).toHaveLength(0);
    expect(f.lookup).not.toHaveBeenCalled();
  });

  it.each(['dry-run', 'running', 'unknown', 'recovery-required', 'restored'])(
    'never accepts the %s state even when historical upload proof is complete',
    async (uploadStatus) => {
      const f = await fixture();
      const journal = { ...previouslyUploaded(f), uploadStatus };
      await expect(
        createDomainVerifier({
          lookup: f.lookup,
          request: f.request,
          runBrowsers: browserSuccess,
        })({ ...f.context, journal }, domain),
      ).rejects.toMatchObject({ code: 'CLOUDFLARE_DOMAIN_CONTEXT_INVALID' });
      expect(f.calls).toHaveLength(0);
    },
  );

  it('honors cancellation and sanitizes unexpected transport errors', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createDomainVerifier({
        lookup: f.lookup,
        request: f.request,
        runBrowsers: browserSuccess,
      })({ ...f.context, signal: controller.signal }, domain),
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_CANCELLED' });
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: async () => {
        throw new Error('fixture-secret-not-for-output');
      },
      runBrowsers: browserSuccess,
    })(f.context, domain);
    expect(report.status).toBe('failed');
    expect(JSON.stringify(report)).not.toContain(
      'fixture-secret-not-for-output',
    );
  });

  it('retains completed HTTP checks on cancellation and still rejects with a cancellation code', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const operation = createDomainVerifier({
      lookup: f.lookup,
      request: async (url, options) => {
        if (url.pathname === '/articles/') {
          controller.abort();
          throw new Error('interrupted transport');
        }
        return f.request(url, options);
      },
      runBrowsers: browserSuccess,
    })({ ...f.context, signal: controller.signal }, domain);
    const error = (await operation.then(
      () => undefined,
      (failure: unknown) => failure,
    )) as DomainVerificationFailure;
    expect(error.code).toBe('CLOUDFLARE_CANCELLED');
    expect(error.verificationReport).toMatchObject({
      status: 'cancelled',
      partial: true,
      domain,
    });
    expect(error.verificationReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'file', path: '/', status: 'passed' }),
        expect.objectContaining({
          code: 'verification-cancelled',
          path: '/articles/',
          status: 'failed',
        }),
      ]),
    );
  });

  it('retains completed HTTP checks and safe failure details when browser initialization throws', async () => {
    const f = await fixture();
    const operation = createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: async () => {
        throw new Error('fixture-secret-browser-error');
      },
    })(f.context, domain);
    const error = (await operation.then(
      () => undefined,
      (failure: unknown) => failure,
    )) as DomainVerificationFailure;
    expect(error.code).toBe('CLOUDFLARE_DOMAIN_CHECK_FAILED');
    expect(error.verificationReport.status).toBe('failed');
    expect(error.verificationReport.partial).toBe(true);
    expect(
      error.verificationReport.checks.filter((check) => check.code === 'file'),
    ).toHaveLength(f.context.manifest.length);
    expect(JSON.stringify(error.verificationReport)).not.toContain(
      'fixture-secret-browser-error',
    );
  });

  it('retains finished browser checks when a later browser is cancelled', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const operation = createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
      runBrowsers: async (_context, _base, _request, _texts, onCheck) => {
        onCheck?.({ code: 'browser-chromium', status: 'passed' });
        controller.abort();
        throw new Error('browser cancelled');
      },
    })({ ...f.context, signal: controller.signal }, domain);
    const error = (await operation.then(
      () => undefined,
      (failure: unknown) => failure,
    )) as DomainVerificationFailure;
    expect(error.verificationReport.status).toBe('cancelled');
    expect(error.verificationReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'browser-chromium', status: 'passed' }),
      ]),
    );
  });

  it('opens all public pages through the pinned transport in three actual browsers, including search and video playback', async () => {
    const f = await fixture({ video: true, largeVideo: true });
    expect(f.files.get('media/video.mp4')?.length).toBeGreaterThan(
      25 * 1024 * 1024,
    );
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
    })(f.context, domain);
    expect(
      report.checks.filter((check) => check.code.startsWith('browser-')),
    ).toEqual(
      expect.arrayContaining(
        ['chromium', 'firefox', 'webkit'].map((name) =>
          expect.objectContaining({
            code: `browser-${name}`,
            status: 'passed',
          }),
        ),
      ),
    );
    expect(report.status).toBe('passed');
    for (const name of ['chromium', 'firefox', 'webkit'])
      expect(
        (
          await readFile(
            join(
              f.context.repositoryRoot,
              '.alfred/reports/cloudflare',
              f.context.deploymentId,
              'screenshots',
              `${name}-home.png`,
            ),
          )
        ).length,
      ).toBeGreaterThan(100);
  });

  it('searches normalized titles in three actual browsers while ignoring boot and sidebar controls', async () => {
    const articleTitle = 'Responses  API 實戰（三）：串流、背景任務與失敗恢復';
    const f = await fixture({ searchBoot: true, articleTitle });
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
    })(f.context, domain);
    expect(report.status, JSON.stringify(report.checks)).toBe('passed');
    for (const name of ['chromium', 'firefox', 'webkit'])
      expect(
        report.checks.find((check) => check.code === `browser-${name}`),
      ).toMatchObject({ status: 'passed' });
    expect(
      f.calls.some(
        (call) =>
          call.url.pathname === '/search-index.json' &&
          call.options.method === 'GET' &&
          call.url.search === '',
      ),
    ).toBe(true);
    const searches = f.calls.filter(
      (call) =>
        call.url.pathname === '/search-index.json' &&
        call.url.searchParams.has('fixture-query'),
    );
    expect(searches).toHaveLength(6);
    expect(searches.every((call) => call.options.method === 'GET')).toBe(true);
    for (const query of [
      normalizeSearchQuery(articleTitle),
      normalizeSearchQuery(`__alfred_no_result_${f.context.deploymentId}`),
    ])
      expect(
        searches.filter(
          (call) => call.url.searchParams.get('fixture-query') === query,
        ),
      ).toHaveLength(3);
  });

  it('plays and seeks a real WebM below the initial viewport in all three browsers', async () => {
    const f = await fixture({
      video: true,
      webmVideo: true,
      videoBelowViewport: true,
    });
    expect(f.files.get('media/video.webm')?.readUInt32BE(0)).toBe(0x1a45dfa3);
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
    })(f.context, domain);
    for (const name of ['chromium', 'firefox', 'webkit'])
      expect(
        report.checks.find((check) => check.code === `browser-${name}`),
        JSON.stringify(
          report.checks.filter((check) => check.code.startsWith('browser-')),
        ),
      ).toMatchObject({ status: 'passed' });
    expect(report.status).toBe('passed');
    expect(
      f.calls.some((call) => call.url.pathname === '/media/video.webm'),
    ).toBe(true);
  });

  it('preserves full GET responses and decodes new frames after seeking through genuinely coded large video', async () => {
    const f = await fixture({ video: true, codedLargeVideo: true });
    const bytes = f.files.get('media/video.mp4');
    if (!bytes) throw new Error('Fixture coded video missing');
    const mediaData = bytes.indexOf(Buffer.from('mdat'));
    expect(mediaData).toBeGreaterThan(4);
    expect(bytes.readUInt32BE(mediaData - 4)).toBeGreaterThan(8 * 1024 * 1024);
    expect(bytes.length).toBeLessThan(32 * 1024 * 1024);
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
    })(f.context, domain);
    for (const name of ['chromium', 'firefox', 'webkit'])
      expect(
        report.checks.find((check) => check.code === `browser-${name}`),
      ).toMatchObject({
        status: 'passed',
        videoTransport: 'injected-buffered',
      });
    expect(report.status).toBe('passed');
    expect(
      f.calls.filter(
        (call) =>
          call.url.pathname === '/media/video.mp4' &&
          call.options.method === 'GET' &&
          !call.options.headers.Range,
      ).length,
    ).toBeGreaterThan(1);
  });

  it.each(['unexpected-partial-response', 'wrong-mime'])(
    'rejects invalid browser video response metadata: %s',
    async (kind) => {
      const f = await fixture({ video: true });
      let fullReads = 0;
      const report = await createDomainVerifier({
        lookup: f.lookup,
        request: async (url, options) => {
          const response = await f.request(url, options);
          if (
            url.pathname === '/media/video.mp4' &&
            options.method === 'GET' &&
            !options.headers.Range &&
            ++fullReads > 1
          ) {
            const headers = { ...response.headers };
            if (kind === 'unexpected-partial-response')
              return {
                ...response,
                statusCode: 206,
                headers: {
                  ...headers,
                  'content-range': `bytes 0-${Number(headers['content-length']) - 1}/${headers['content-length']}`,
                },
              };
            return {
              ...response,
              headers: {
                ...headers,
                'content-type': 'application/octet-stream',
              },
            };
          }
          return response;
        },
      })(f.context, domain);
      expect(report.status).toBe('failed');
      expect(
        report.checks.filter((check) => check.code.startsWith('browser-')),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'failed',
            errorCode: 'CLOUDFLARE_BROWSER_VIDEO_RESPONSE',
          }),
        ]),
      );
    },
  );

  it('blocks browser requests to private or external resource hosts before transport', async () => {
    const f = await fixture({ externalImage: true });
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
    })(f.context, domain);
    expect(report.status).toBe('failed');
    expect(
      report.checks
        .filter((check) => check.code.startsWith('browser-'))
        .every((check) => check.status === 'failed'),
    ).toBe(true);
    expect(
      f.calls.every((call) => call.url.hostname === 'blog.example.com'),
    ).toBe(true);
  });

  it('blocks browser WebSockets before they can establish private or external connections', async () => {
    const f = await fixture({ websocket: true });
    const report = await createDomainVerifier({
      lookup: f.lookup,
      request: f.request,
    })(f.context, domain);
    expect(report.status).toBe('failed');
    expect(
      report.checks
        .filter((check) => check.code.startsWith('browser-'))
        .map((check) => check.errorCode),
    ).toEqual([
      'CLOUDFLARE_BROWSER_WEBSOCKET_BLOCKED',
      'CLOUDFLARE_BROWSER_WEBSOCKET_BLOCKED',
      'CLOUDFLARE_BROWSER_WEBSOCKET_BLOCKED',
    ]);
    expect(
      f.calls.every((call) => call.url.hostname === 'blog.example.com'),
    ).toBe(true);
  });
});
