import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  createRouteManifest,
  validateRouteManifest,
  validateSiteLinks,
  notFoundSeo,
  ManagedMediaPathSchema,
  SearchIndexSchema,
  absoluteSiteUrl,
  type Diagnostic,
  type SeoViewModel,
  type SiteLinkSource,
} from '@foliohaven/core';
import { safePath, hashFile } from '../../files/io.js';
import { RenderError } from './context.js';
import type {
  SiteOutputValidation,
  ValidateSiteOutputOptions,
} from './types.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
function elements(node: Node): Element[] {
  const result: Element[] = [];
  const stack: Node[] = [node];
  while (stack.length) {
    const item = stack.pop();
    if (item === undefined) continue;
    if ('tagName' in item) result.push(item);
    if ('childNodes' in item)
      for (const child of [...item.childNodes].reverse()) stack.push(child);
  }
  return result;
}
function attr(node: Element, name: string) {
  return node.attrs.find((item) => item.name === name)?.value;
}
function text(node: Node): string {
  if ('value' in node) return node.value;
  if ('childNodes' in node) return node.childNodes.map(text).join('');
  return '';
}
function expectedSeo(
  options: ValidateSiteOutputOptions,
  path: string,
): SeoViewModel | undefined {
  if (path === '/404.html') return notFoundSeo(options.model.site);
  if (path === '/') return options.model.home.seo;
  return (
    options.model.articlePages.find((item) => item.url === path)?.seo ??
    options.model.listPages.find((item) => item.url === path)?.seo ??
    options.fixedPageSeos?.[path]
  );
}
/** 最後一關檢查實際Document，而不是只檢查來源fragment或檔名。 */
export async function validateSiteOutput(
  options: ValidateSiteOutputOptions,
): Promise<SiteOutputValidation> {
  const root = resolve(options.outputDirectory);
  const diagnostics: Diagnostic[] = [];
  let currentResource = 'dist';
  const fail = (code: string, message: string) =>
    diagnostics.push({
      severity: 'error',
      code,
      message,
      resource: currentResource,
    });
  const files = new Map<string, { byteSize: number; sha256: string }>();
  const appManifest = options.model.home.site.iconSet?.manifest ?? null;
  const routeDirectories = new Set<string>();
  for (const route of options.model.routeManifest.routes) {
    const segments = route.outputPath.split('/');
    for (let n = 1; n < segments.length; n++)
      routeDirectories.add(segments.slice(0, n).join('/'));
  }
  async function scan(resource: string): Promise<void> {
    const path = resource === '' ? root : await safePath(root, resource);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      fail('OUTPUT_SYMLINK', '公開產物不得使用符號連結。');
      return;
    }
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        const child = resource === '' ? name : `${resource}/${name}`;
        const registeredPageDirectory = routeDirectories.has(child);
        if (
          (name.startsWith('.') &&
            !(name === '.well-known' && registeredPageDirectory)) ||
          (!registeredPageDirectory &&
            [
              'node_modules',
              'server',
              'studio',
              'content',
              'source',
              'tests',
            ].includes(name))
        )
          fail('PRIVATE_OUTPUT', '公開產物包含私有或來源目錄。');
        await scan(child);
      }
      return;
    }
    if (!stat.isFile()) {
      fail('OUTPUT_NOT_FILE', '公開產物只接受一般檔案。');
      return;
    }
    const managedPng =
      resource.endsWith('.png') &&
      ManagedMediaPathSchema.safeParse(`/${resource}`).success &&
      options.model.mediaRefs.includes(`/${resource}`);
    if (
      (!/\.(?:html|css|js|xml|json|txt|webp|webm|svg|ico|woff2?)$/u.test(
        resource,
      ) &&
        !managedPng &&
        !(resource === 'site.webmanifest' && appManifest !== null)) ||
      resource.endsWith('.map')
    )
      fail('PRIVATE_OUTPUT', '公開產物包含未允許的來源或程式檔案。');
    if (resource.endsWith('.json') && resource !== 'search-index.json')
      fail('PRIVATE_OUTPUT', '公開產物包含未允許的JSON資料。');
    const sha256 = await hashFile(path);
    if (sha256 === null)
      throw new RenderError('OUTPUT_CHANGED', '產物在驗證期間改變。');
    files.set(resource, { byteSize: stat.size, sha256 });
  }
  await scan('');
  const publicPaths = new Set([...files.keys()].map((path) => `/${path}`));
  const sources: SiteLinkSource[] = [];
  const sourceLocations = new Map<
    string,
    { resource: string; articleId?: string }
  >();
  const pageIds: Record<string, readonly string[]> = {};
  const htmlRoutes = new Map(
    options.model.routeManifest.routes.map((route) => [
      route.outputPath,
      route.path,
    ]),
  );
  htmlRoutes.set('404.html', '/404.html');
  for (const [output, path] of htmlRoutes)
    if (!files.has(output))
      fail('OUTPUT_ROUTE_MISSING', `公開路由缺少完整HTML：${path}`);
  const managedReferences = new Set<string>();
  const checkResource = (href: string, owner: string, managed = false) => {
    let url: URL;
    try {
      url = new URL(href, options.model.site.siteUrl);
    } catch {
      fail('OUTPUT_RESOURCE_INVALID', `頁面包含無效資源URL：${owner}`);
      return;
    }
    if (url.origin !== new URL(options.model.site.siteUrl).origin) {
      fail('EXTERNAL_OUTPUT_RESOURCE', `頁面依賴外部資源：${owner}`);
      return;
    }
    let path: string;
    try {
      path = decodeURI(url.pathname);
    } catch {
      fail('OUTPUT_RESOURCE_INVALID', `資源URL編碼無效：${owner}`);
      return;
    }
    if (!href.startsWith('/') && !/^https?:\/\//iu.test(href)) {
      fail('OUTPUT_RESOURCE_INVALID', `資源必須使用根路徑：${owner}`);
      return;
    }
    if (managed && !ManagedMediaPathSchema.safeParse(path).success) {
      fail('UNMANAGED_OUTPUT_MEDIA', `媒體必須使用受管本機資源：${owner}`);
      return;
    }
    if (!publicPaths.has(path))
      fail('OUTPUT_RESOURCE_MISSING', `公開資源不存在：${path}`);
    if (ManagedMediaPathSchema.safeParse(path).success)
      managedReferences.add(path);
  };
  if (appManifest !== null) {
    currentResource = 'dist/site.webmanifest';
    try {
      const value: unknown = JSON.parse(
        await readFile(await safePath(root, 'site.webmanifest'), 'utf8'),
      );
      if (!isDeepStrictEqual(value, appManifest.data))
        fail(
          'OUTPUT_MANIFEST_INVALID',
          'Web App Manifest 與目前網站設定不符。',
        );
      for (const icon of appManifest.data.icons)
        checkResource(icon.src, '/site.webmanifest', true);
    } catch {
      fail('OUTPUT_MANIFEST_INVALID', 'Web App Manifest 缺失或不是有效 JSON。');
    }
  }
  for (const [file] of files) {
    currentResource = `dist/${file}`;
    const bytes = /\.(?:html|css|js)$/u.test(file)
      ? await readFile(await safePath(root, file))
      : Buffer.alloc(0);
    if (file.endsWith('.js')) {
      const source = bytes.toString('utf8');
      if (
        /\bnode:(?:fs|path|process|child_process|crypto)|__vite-browser-external|@(?:alfred-wiki|foliohaven)\/server|(?:server|studio)\/src\/|sourceMappingURL|\.node["']/u.test(
          source,
        )
      )
        fail(
          'PRIVATE_BROWSER_BUNDLE',
          '瀏覽器產物含管理、Node或來源對應資訊。',
        );
      // Vite輸出靜態import須對應同一產物樹；不允許依賴外部CDN。
      for (const match of source.matchAll(
        /(?:from\s*|import\s*\()(["'])([^"']+)\1/gu,
      )) {
        const href = match[2];
        if (href === undefined) continue;
        if (href.startsWith('.')) {
          const resolved = new URL(href, `https://assets.invalid/${file}`);
          if (!files.has(resolved.pathname.slice(1)))
            fail('OUTPUT_IMPORT_MISSING', '瀏覽器程式缺少必要相依資源。');
        } else if (!href.startsWith('/'))
          fail(
            'EXTERNAL_BROWSER_IMPORT',
            '瀏覽器程式包含外部或未解析套件依賴。',
          );
        else checkResource(href, file);
      }
    }
    if (file.endsWith('.css'))
      for (const match of bytes
        .toString('utf8')
        .matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/giu)) {
        if (match[1] !== undefined) checkResource(match[1], file);
      }
    if (!file.endsWith('.html')) continue;
    const path = htmlRoutes.get(file);
    if (path === undefined) {
      fail('UNEXPECTED_HTML_ROUTE', `產物含未登錄HTML：/${file}`);
      continue;
    }
    const html = bytes.toString('utf8');
    if (
      options.draftSentinels?.some(
        (sentinel) => sentinel !== '' && html.includes(sentinel),
      )
    )
      fail('DRAFT_OUTPUT_LEAK', '草稿專用內容進入正式HTML。');
    const parseErrors: string[] = [];
    const document = parse(html, {
      sourceCodeLocationInfo: true,
      onParseError: (error) => parseErrors.push(error.code),
    });
    if (parseErrors.length)
      fail('OUTPUT_HTML_INVALID', `生成的HTML Document無效：${path}`);
    const nodes = elements(document);
    const islands = nodes.filter((node) => node.tagName === 'astro-island');
    if (path !== '/articles/' ? islands.length !== 0 : islands.length > 1)
      fail(
        'UNEXPECTED_HYDRATION',
        '一般頁面不得包含主要內容的瀏覽器hydration。',
      );
    if (
      nodes.filter((node) => node.tagName === 'main').length !== 1 ||
      nodes.filter((node) => node.tagName === 'h1').length !== 1
    )
      fail('OUTPUT_PAGE_STRUCTURE', `頁面必須具有單一main與H1：${path}`);
    if (
      nodes
        .find((node) => node.tagName === 'html')
        ?.attrs.find((item) => item.name === 'lang')?.value !==
      options.model.site.language
    )
      fail('OUTPUT_LANGUAGE_INVALID', `頁面語言設定不一致：${path}`);
    const ids: string[] = [];
    const seen = new Set<string>();
    const links: SiteLinkSource['links'][number][] = [];
    for (const node of nodes) {
      const id = attr(node, 'id');
      if (id !== undefined) {
        if (id === '' || seen.has(id))
          fail('OUTPUT_DUPLICATE_ID', `頁面包含空白或重複anchor：${path}`);
        ids.push(id);
        seen.add(id);
      }
      const href = attr(node, 'href');
      if (node.tagName === 'astro-island')
        for (const key of ['component-url', 'renderer-url']) {
          const value = attr(node, key);
          if (value === undefined)
            fail(
              'OUTPUT_ISLAND_RESOURCE_MISSING',
              '搜尋頁缺少必要的瀏覽器模組。',
            );
          else checkResource(value, path);
        }
      if (
        (node.tagName === 'a' || node.tagName === 'area') &&
        href !== undefined
      )
        links.push({
          href,
          ...(node.sourceCodeLocation === undefined ||
          node.sourceCodeLocation === null
            ? {}
            : {
                line: node.sourceCodeLocation.startLine,
                column: node.sourceCodeLocation.startCol,
              }),
        });
      if (
        node.tagName === 'link' &&
        href !== undefined &&
        [
          'stylesheet',
          'preload',
          'modulepreload',
          'icon',
          'apple-touch-icon',
          'mask-icon',
          'manifest',
        ].includes(attr(node, 'rel') ?? '')
      )
        checkResource(href, path);
      for (const key of ['src', 'poster']) {
        const value = attr(node, key);
        if (value !== undefined)
          checkResource(
            value,
            path,
            ['img', 'source', 'video', 'audio', 'track'].includes(node.tagName),
          );
      }
      const srcset = attr(node, 'srcset');
      if (srcset !== undefined)
        for (const candidate of srcset.split(',')) {
          const href = candidate.trim().split(/\s+/u)[0];
          if (href) checkResource(href, path, true);
        }
      if (
        node.tagName === 'meta' &&
        ['og:image', 'twitter:image'].includes(
          attr(node, 'property') ?? attr(node, 'name') ?? '',
        )
      ) {
        const image = attr(node, 'content');
        if (image !== undefined) checkResource(image, path, true);
      }
      if (
        node.tagName === 'script' &&
        attr(node, 'type') === 'application/ld+json'
      )
        try {
          JSON.parse(text(node));
        } catch {
          fail('OUTPUT_JSON_LD_INVALID', `JSON-LD無法解析：${path}`);
        }
      const style = attr(node, 'style');
      if (style !== undefined)
        for (const match of style.matchAll(
          /url\(\s*["']?([^\s"')]+)["']?\s*\)/giu,
        ))
          if (match[1] !== undefined) checkResource(match[1], path, true);
    }
    if (!seen.has('ui-main'))
      fail('OUTPUT_MAIN_ANCHOR_MISSING', `頁面缺少鍵盤跳轉目標：${path}`);
    pageIds[path] = ids;
    const sourceId = `rendered-page-${sources.length}`;
    const articleId = options.model.articlePages.find(
      (article) => article.url === path,
    )?.articleId;
    sourceLocations.set(sourceId, {
      resource: `dist/${file}`,
      ...(articleId === undefined ? {} : { articleId }),
    });
    sources.push({ articleId: sourceId, path, ids, links });
    const seo = expectedSeo(options, path);
    if (seo === undefined)
      fail(
        'OUTPUT_SEO_EXPECTATION_MISSING',
        `固定頁缺少共用SEO驗證資料：${path}`,
      );
    const canonical = nodes.filter(
      (node) => node.tagName === 'link' && attr(node, 'rel') === 'canonical',
    );
    if (seo !== undefined) {
      if (
        seo.canonical === null
          ? canonical.length !== 0
          : canonical.length !== 1 ||
            attr(canonical[0] as Element, 'href') !== seo.canonical
      )
        fail('OUTPUT_CANONICAL_INVALID', `頁面canonical不符合Core：${path}`);
      if (
        nodes
          .filter((node) => node.tagName === 'title')
          .map(text)
          .join('') !== seo.title
      )
        fail('OUTPUT_TITLE_INVALID', `頁面title不符合Core：${path}`);
      if (
        nodes
          .find(
            (node) =>
              node.tagName === 'meta' && attr(node, 'name') === 'robots',
          )
          ?.attrs.find((item) => item.name === 'content')?.value !== seo.robots
      )
        fail('OUTPUT_ROBOTS_INVALID', `頁面robots不符合Core：${path}`);
      const expectedMeta: readonly (readonly [
        string,
        string,
        string | null,
      ])[] = [
        ['name', 'description', seo.description],
        ['property', 'og:type', seo.openGraph.type],
        ['property', 'og:title', seo.openGraph.title],
        ['property', 'og:description', seo.openGraph.description],
        ['property', 'og:site_name', seo.openGraph.siteName],
        ['property', 'og:locale', seo.openGraph.locale],
        ['property', 'og:url', seo.openGraph.url],
        ['property', 'og:image', seo.openGraph.image],
        ['name', 'twitter:card', seo.twitter.card],
        ['name', 'twitter:title', seo.twitter.title],
        ['name', 'twitter:description', seo.twitter.description],
        ['name', 'twitter:image', seo.twitter.image],
        ['name', 'twitter:site', seo.twitter.site],
      ];
      for (const [attribute, key, value] of expectedMeta) {
        const matches = nodes.filter(
          (node) => node.tagName === 'meta' && attr(node, attribute) === key,
        );
        if (
          value === null
            ? matches.length !== 0
            : matches.length !== 1 ||
              attr(matches[0] as Element, 'content') !== value
        )
          fail('OUTPUT_SEO_META_INVALID', `頁面meta不符合Core：${path}`);
      }
      const jsonLd = nodes.filter(
        (node) =>
          node.tagName === 'script' &&
          attr(node, 'type') === 'application/ld+json',
      );
      try {
        if (
          seo.jsonLd.length === 0
            ? jsonLd.length !== 0
            : jsonLd.length !== 1 ||
              JSON.stringify(JSON.parse(text(jsonLd[0] as Element))) !==
                JSON.stringify(seo.jsonLd)
        )
          throw new Error('changed');
      } catch {
        fail('OUTPUT_JSON_LD_INVALID', `頁面JSON-LD不符合Core：${path}`);
      }
    }
    const gsc = nodes.filter(
      (node) =>
        node.tagName === 'meta' &&
        attr(node, 'name') === 'google-site-verification',
    );
    if (
      path === '/' && options.model.site.googleSiteVerification !== null
        ? gsc.length !== 1 ||
          attr(gsc[0] as Element, 'content') !==
            options.model.site.googleSiteVerification
        : gsc.length !== 0
    )
      fail('OUTPUT_GSC_INVALID', '搜尋站台驗證標記只能依設定出現在首頁。');
    if (
      !nodes.some(
        (node) =>
          node.tagName === 'link' &&
          attr(node, 'rel') === 'alternate' &&
          attr(node, 'type') === 'application/rss+xml' &&
          attr(node, 'href') ===
            absoluteSiteUrl(options.model.site, '/rss.xml'),
      )
    )
      fail('OUTPUT_RSS_DISCOVERY_MISSING', `頁面缺少RSS discovery：${path}`);
  }
  currentResource = 'dist';
  const routeManifest = createRouteManifest(
    options.model.routeManifest.routes,
    [
      ...new Set([
        ...options.model.routeManifest.assets,
        ...[...publicPaths].filter(
          (path) => !htmlRoutes.has(path.slice(1)) || path === '/404.html',
        ),
      ]),
    ],
  );
  diagnostics.push(...validateRouteManifest(routeManifest));
  const links = validateSiteLinks(sources, routeManifest, {
    siteUrl: options.model.site.siteUrl,
    pageIds,
    allowPending: false,
  });
  diagnostics.push(
    ...links.diagnostics.map((diagnostic) => {
      const location = sourceLocations.get(diagnostic.articleId ?? '');
      return {
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        ...(location ?? {}),
        field: 'links',
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
        ...(diagnostic.column === undefined
          ? {}
          : { column: diagnostic.column }),
      };
    }),
  );
  const expectedMedia = new Map(
    options.manifest.assets.flatMap((asset) =>
      asset.outputs.map((output) => [output.publicPath, output] as const),
    ),
  );
  for (const ref of options.model.mediaRefs) {
    const output = expectedMedia.get(ref);
    const bytes = files.get(ref.slice(1));
    if (
      output === undefined ||
      bytes === undefined ||
      output.byteSize !== bytes.byteSize ||
      output.sha256 !== bytes.sha256
    )
      fail('OUTPUT_MEDIA_INVALID', `受管媒體缺失或內容不符：${ref}`);
  }
  for (const path of publicPaths)
    if (path.startsWith('/media/') && !options.model.mediaRefs.includes(path))
      fail('UNREACHABLE_MEDIA_OUTPUT', '產物包含未被公開集合引用的媒體。');
  for (const path of managedReferences)
    if (!options.model.mediaRefs.includes(path))
      fail('UNDECLARED_MEDIA_OUTPUT', `頁面引用未登錄媒體：${path}`);
  try {
    const bytes = files.has('search-index.json')
      ? await readFile(await safePath(root, 'search-index.json'))
      : undefined;
    if (
      bytes === undefined ||
      !SearchIndexSchema.safeParse(JSON.parse(bytes.toString('utf8'))).success
    )
      throw new Error('invalid');
    if (bytes.toString('utf8') !== JSON.stringify(options.model.searchIndex))
      throw new Error('changed');
  } catch {
    fail('OUTPUT_SEARCH_INDEX_INVALID', '公開搜尋索引格式或內容不符合Core。');
  }
  for (const auxiliary of ['rss.xml', 'robots.txt', 'sitemap-index.xml'])
    if (!files.has(auxiliary))
      fail('OUTPUT_AUXILIARY_MISSING', '建置缺少必要輔助檔案。');
  await validateAuxiliaryOutput(root, new Set(files.keys()), options, fail);
  if (options.model.mediaPending)
    fail('MEDIA_PROCESSING_PENDING', '媒體仍有未完成項目。');
  if (diagnostics.some((item) => item.severity === 'error'))
    throw new RenderError(
      'OUTPUT_VALIDATION_FAILED',
      '靜態產物未通過完整性驗證。',
      diagnostics,
    );
  return {
    fileCount: files.size,
    routeCount: options.model.routeManifest.routes.length,
    warnings: [...options.model.diagnostics, ...diagnostics].filter(
      (item) => item.severity === 'warning',
    ),
    mediaPending: false,
    pendingLinkChecks: 0,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
async function validateAuxiliaryOutput(
  root: string,
  files: ReadonlySet<string>,
  options: ValidateSiteOutputOptions,
  fail: (code: string, message: string) => void,
) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  });
  const xml = async (file: string): Promise<Record<string, unknown>> => {
    if (!files.has(file)) throw new Error('missing');
    const value = await readFile(await safePath(root, file), 'utf8');
    if (XMLValidator.validate(value) !== true) throw new Error('invalid');
    return object(parser.parse(value));
  };
  try {
    const channel = object(object((await xml('rss.xml'))['rss'])['channel']);
    const expected = options.model.articlePages.slice(
      0,
      options.model.site.rss.maxItems,
    );
    const items = array(channel['item']);
    if (
      items.length !== expected.length ||
      channel['title'] !== options.model.site.rss.title ||
      channel['description'] !== options.model.site.rss.description ||
      channel['link'] !== options.model.site.siteUrl
    )
      throw new Error('changed');
    for (const [index, value] of items.entries()) {
      const item = object(value);
      const article = expected[index];
      if (article === undefined) throw new Error('changed');
      const guid = object(item['guid']);
      if (
        guid['#text'] !== `article:${article.articleId}` ||
        guid['@_isPermaLink'] !== 'false' ||
        item['link'] !== absoluteSiteUrl(options.model.site, article.url) ||
        item['title'] !== article.meta.title ||
        item['description'] !== article.description ||
        item['pubDate'] !== new Date(article.meta.publishedAt).toUTCString() ||
        item['content:encoded'] !== undefined
      )
        throw new Error('changed');
    }
    const updated = expected.reduce<string | null>(
      (latest, item) =>
        latest === null || Date.parse(item.meta.updatedAt) > Date.parse(latest)
          ? item.meta.updatedAt
          : latest,
      null,
    );
    if (
      updated === null
        ? channel['lastBuildDate'] !== undefined
        : channel['lastBuildDate'] !== new Date(updated).toUTCString()
    )
      throw new Error('changed');
  } catch {
    fail(
      'OUTPUT_RSS_INVALID',
      'RSS的XML、公開集合、GUID或日期不符合正式契約。',
    );
  }
  try {
    const index = object((await xml('sitemap-index.xml'))['sitemapindex']);
    const locations: string[] = [];
    const sitemapFiles = new Set<string>();
    for (const value of array(index['sitemap'])) {
      const loc = object(value)['loc'];
      if (typeof loc !== 'string') throw new Error('invalid');
      const url = new URL(loc);
      if (
        url.origin !== new URL(options.model.site.siteUrl).origin ||
        !/^\/sitemap-\d+\.xml$/u.test(url.pathname) ||
        url.search !== '' ||
        url.hash !== ''
      )
        throw new Error('invalid');
      const file = url.pathname.slice(1);
      if (sitemapFiles.has(file)) throw new Error('duplicate');
      sitemapFiles.add(file);
      const set = object((await xml(file))['urlset']);
      for (const value of array(set['url'])) {
        const loc = object(value)['loc'];
        if (typeof loc !== 'string') throw new Error('invalid');
        locations.push(loc);
      }
    }
    const expected = options.model.routeManifest.routes
      .filter((route) => route.index)
      .map((route) => absoluteSiteUrl(options.model.site, route.path))
      .sort();
    if (
      sitemapFiles.size === 0 ||
      JSON.stringify(locations.sort()) !== JSON.stringify(expected) ||
      [...files].some(
        (file) => /^sitemap-\d+\.xml$/u.test(file) && !sitemapFiles.has(file),
      )
    )
      throw new Error('changed');
  } catch {
    fail('OUTPUT_SITEMAP_INVALID', 'Sitemap的XML或可索引路由集合不符合Core。');
  }
  try {
    const robots = await readFile(await safePath(root, 'robots.txt'), 'utf8');
    if (
      robots !==
      `User-agent: *\nAllow: /\nSitemap: ${absoluteSiteUrl(options.model.site, '/sitemap-index.xml')}\n`
    )
      throw new Error('changed');
  } catch {
    fail('OUTPUT_ROBOTS_INVALID', 'robots.txt與網站Sitemap設定不一致。');
  }
}
