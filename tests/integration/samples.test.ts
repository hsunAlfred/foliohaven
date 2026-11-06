import { describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import {
  ArticleMetaSchema,
  MediaSourceSchema,
  SearchIndexSchema,
  buildSiteModel,
} from '@foliohaven/core';
import { loadContent, validateFixedPageEntries } from '@foliohaven/core/node';
import { fixedPages, pageSchemas } from '@foliohaven/site/registry';
import {
  buildSamples,
  samplesReferenceRoot,
  samplesWorkspace,
} from '../fixtures/samples/workspace.js';
import type { NativeImageFactory } from '../../server/src/media/worker.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const sharp = createRequire(
  new URL('../../server/package.json', import.meta.url),
)('sharp') as NativeImageFactory;
const imageId = 'd65927b5-381f-4d2e-90d8-f6a8c5e38e57';
const videoId = '68789bc2-e491-4dbe-81de-f1a42adb7234';
const expectedArticles = [
  {
    id: 'sample-article-basics',
    slug: 'article-basics',
    category: 'notes',
    tags: ['example'],
  },
  {
    id: 'sample-local-editing',
    slug: 'local-editing',
    category: 'tools',
    tags: ['example', 'workflow'],
  },
  {
    id: 'sample-image-content',
    slug: 'image-content',
    category: 'notes',
    tags: ['example', 'media'],
  },
  {
    id: 'sample-table-content',
    slug: 'table-content',
    category: 'notes',
    tags: ['example', 'workflow'],
  },
  {
    id: 'sample-video-content',
    slug: 'video-content',
    category: 'tools',
    tags: [],
  },
] as const;
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
function elements(node: Node, tag: string): Element[] {
  const own = 'tagName' in node && node.tagName === tag ? [node] : [];
  return [
    ...own,
    ...('childNodes' in node
      ? node.childNodes.flatMap((child) => elements(child, tag))
      : []),
  ];
}
function attr(node: Element, name: string) {
  return node.attrs.find((attribute) => attribute.name === name)?.value;
}
function textContent(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(textContent).join('') : '';
}
async function htmlDocument(root: string, resource: string) {
  return parse(await readFile(join(root, 'dist', resource), 'utf8'));
}
function articleLinks(document: Node) {
  return elements(document, 'article')
    .map((article) =>
      elements(article, 'a').find((link) =>
        /^\/(?:notes|tools)\/[a-z-]+\/$/u.test(attr(link, 'href') ?? ''),
      ),
    )
    .map((link) => (link === undefined ? undefined : attr(link, 'href')));
}
function json(value: unknown) {
  return JSON.stringify(value, null, 2) + '\n';
}

describe('fixed reference sample content', () => {
  it('loads the five reference samples with exact taxonomy, noindex, and deterministic pagination', async () => {
    const source = await loadContent(samplesReferenceRoot, {
      mode: 'public',
      pageSchemas,
    });
    const model = buildSiteModel({
      ...source,
      fixedPages: await validateFixedPageEntries(repository, fixedPages),
    });
    expect(
      (await readdir(join(samplesReferenceRoot, 'content/articles'))).sort(),
    ).toEqual(expectedArticles.map((article) => article.id).sort());
    expect(source.articles).toHaveLength(5);
    for (const expected of expectedArticles) {
      const article = source.articles.find(
        (item) => item.articleId === expected.id,
      );
      expect(article?.meta).toMatchObject({
        status: 'published',
        slug: expected.slug,
        category: expected.category,
        tags: expected.tags,
      });
      expect(article?.contentHtml).not.toMatch(/<h1\b|<html\b|<body\b/u);
      expect(
        model.articlePages.find((item) => item.articleId === expected.id)?.url,
      ).toBe(`/${expected.category}/${expected.slug}/`);
    }
    expect(source.categories.map((category) => category.path)).toEqual([
      'notes',
      'tools',
    ]);
    expect(source.tags.map((tag) => tag.slug)).toEqual([
      'example',
      'workflow',
      'media',
    ]);
    expect(source.site.pagination).toEqual({
      category: 2,
      tag: 2,
      articles: 2,
    });
    expect(source.site.siteUrl).toBe('https://example.invalid/');
    expect(source.site.timeZone).toBe('Asia/Taipei');
    expect(
      model.diagnostics.filter((issue) => issue.severity === 'error'),
    ).toEqual([]);
    expect(model.mediaPending).toBe(true);
    expect(model.pendingLinkChecks).toEqual([]);
    expect(model.articlePages.map((article) => article.articleId)).toEqual([
      'sample-video-content',
      'sample-table-content',
      'sample-image-content',
      'sample-article-basics',
      'sample-local-editing',
    ]);
    const basics = source.articles.find(
      (article) => article.articleId === 'sample-article-basics',
    );
    const editing = source.articles.find(
      (article) => article.articleId === 'sample-local-editing',
    );
    expect(basics?.meta.publishedAt).toBe(editing?.meta.publishedAt);
    const notes = model.listPages.filter(
      (page) => page.kind === 'category' && page.key === 'notes',
    );
    const tools = model.listPages.filter(
      (page) => page.kind === 'category' && page.key === 'tools',
    );
    const example = model.listPages.filter(
      (page) => page.kind === 'tag' && page.key === 'example',
    );
    expect(notes.map((page) => [page.url, page.articles.length])).toEqual([
      ['/category/notes/', 2],
      ['/category/notes/2/', 1],
    ]);
    expect(tools.map((page) => [page.url, page.articles.length])).toEqual([
      ['/category/tools/', 2],
    ]);
    expect(example.map((page) => [page.url, page.articles.length])).toEqual([
      ['/tag/example/', 2],
      ['/tag/example/2/', 2],
    ]);
    expect(
      notes
        .flatMap((page) => page.articles)
        .every((article) => article.category.path === 'notes'),
    ).toBe(true);
    expect(
      tools
        .flatMap((page) => page.articles)
        .every((article) => article.category.path === 'tools'),
    ).toBe(true);
    expect(
      model.articlePages
        .filter((article) => !article.seo.index)
        .map((article) => article.articleId),
    ).toEqual(['sample-table-content']);
    expect(model.searchIndex.articles).toHaveLength(5);
    expect(
      model.routeManifest.routes.filter(
        (route) => route.kind === 'article' && route.index,
      ),
    ).toHaveLength(4);
    expect(model.home.featured.map((article) => article.articleId)).toEqual([
      'sample-article-basics',
      'sample-image-content',
    ]);
    expect(model.home.latest).toHaveLength(5);
    expect(
      model.home.categories.map((category) => [
        category.path,
        category.articleCount,
      ]),
    ).toEqual([
      ['notes', 3],
      ['tools', 2],
    ]);
    for (const [id, kind] of [
      [imageId, 'image'],
      [videoId, 'video'],
    ] as const) {
      const metadata = MediaSourceSchema.parse(
        JSON.parse(
          await readFile(
            join(samplesReferenceRoot, 'media/source', id, 'meta.json'),
            'utf8',
          ),
        ),
      );
      expect(metadata).toMatchObject({ id, kind });
    }
  });

  it('seeds fixed samples independently of an author workspace with six articles or a replacement two-article blog', async () => {
    const author = await samplesWorkspace();
    try {
      const sourceRoot = author.root;
      const articlesRoot = join(sourceRoot, 'content/articles');
      const basicsResource = 'content/articles/sample-article-basics';
      const originalMeta = ArticleMetaSchema.parse(
        JSON.parse(
          await readFile(
            join(samplesReferenceRoot, basicsResource, 'meta.json'),
            'utf8',
          ),
        ),
      );
      const originalBody = await readFile(
        join(samplesReferenceRoot, basicsResource, 'content.html'),
        'utf8',
      );
      const originalSite = await readFile(
        join(samplesReferenceRoot, 'content/site.json'),
        'utf8',
      );
      const site = (await loadContent(sourceRoot, { mode: 'public' })).site;
      await writeFile(
        join(sourceRoot, 'content/site.json'),
        json({
          ...site,
          siteName: '作者自訂 Blog',
          home: { ...site.home, featuredArticleIds: [] },
        }),
      );
      await writeFile(
        join(sourceRoot, basicsResource, 'meta.json'),
        json({ ...originalMeta, title: '作者已修改的標題' }),
      );
      await writeFile(
        join(sourceRoot, basicsResource, 'content.html'),
        `${originalBody}<p>作者自行維護的正文。</p>\n`,
      );
      const sixth = join(articlesRoot, 'author-sixth');
      await mkdir(sixth);
      await writeFile(
        join(sixth, 'meta.json'),
        json({ ...originalMeta, title: '作者第六篇', slug: 'author-sixth' }),
      );
      await writeFile(join(sixth, 'content.html'), '<p>作者新增的內容。</p>\n');

      for (const articleCount of [6, 2]) {
        if (articleCount === 2) {
          await rm(articlesRoot, { recursive: true });
          for (const slug of ['personal-first', 'personal-second']) {
            const directory = join(articlesRoot, slug);
            await mkdir(directory, { recursive: true });
            await writeFile(
              join(directory, 'meta.json'),
              json({ ...originalMeta, slug, title: `作者文章 ${slug}` }),
            );
            await writeFile(
              join(directory, 'content.html'),
              '<p>作者替換成兩篇文章的 Blog。</p>\n',
            );
          }
        }
        const before = await loadContent(sourceRoot, { mode: 'public' });
        expect(before.articles).toHaveLength(articleCount);
        expect(before.site.siteName).toBe('作者自訂 Blog');
        const seeded = await samplesWorkspace(sourceRoot);
        try {
          const sample = await loadContent(seeded.root, { mode: 'public' });
          expect(
            sample.articles.map((article) => article.articleId).sort(),
          ).toEqual(expectedArticles.map((article) => article.id).sort());
          expect(
            sample.articles.find(
              (article) => article.articleId === 'sample-article-basics',
            ),
          ).toMatchObject({ meta: originalMeta, contentHtml: originalBody });
          expect(
            await readFile(join(seeded.root, 'content/site.json'), 'utf8'),
          ).toBe(originalSite);
          expect(await loadContent(sourceRoot, { mode: 'public' })).toEqual(
            before,
          );
        } finally {
          await seeded.cleanup();
        }
      }
    } finally {
      await author.cleanup();
    }
  });

  it('builds the five reference samples through pnpm build, updates all projections, and adds an article plus independent page only in the sandbox', async () => {
    const fixture = await samplesWorkspace();
    try {
      const initial = await buildSamples(fixture.root);
      expect(initial['outputDirectory']).toBe('dist');
      expect(initial['warnings']).toEqual([]);
      const search = SearchIndexSchema.parse(
        JSON.parse(
          await readFile(join(fixture.root, 'dist/search-index.json'), 'utf8'),
        ),
      );
      expect(search.articles).toHaveLength(5);
      const rss = await readFile(join(fixture.root, 'dist/rss.xml'), 'utf8');
      expect(rss.match(/<item>/gu)).toHaveLength(5);
      for (const expected of expectedArticles) {
        const url = `/${expected.category}/${expected.slug}/`;
        const document = await htmlDocument(
          fixture.root,
          `${expected.category}/${expected.slug}/index.html`,
        );
        expect(elements(document, 'h1')).toHaveLength(1);
        expect(elements(document, 'main')).toHaveLength(1);
        expect(
          elements(document, 'link').find(
            (element) => attr(element, 'rel') === 'canonical',
          )?.attrs,
        ).toEqual(
          expect.arrayContaining([
            { name: 'href', value: `https://example.invalid${url}` },
          ]),
        );
        expect(
          elements(document, 'meta').find(
            (element) => attr(element, 'name') === 'robots',
          )?.attrs,
        ).toEqual(
          expect.arrayContaining([
            {
              name: 'content',
              value:
                expected.id === 'sample-table-content'
                  ? 'noindex,follow'
                  : 'index,follow',
            },
          ]),
        );
        expect(elements(document, 'astro-island')).toHaveLength(0);
        expect(rss).toContain(
          `<guid isPermaLink="false">article:${expected.id}</guid>`,
        );
      }
      const sitemapFiles = (await readdir(join(fixture.root, 'dist'))).filter(
        (file) => /^sitemap-\d+\.xml$/u.test(file),
      );
      const sitemap = (
        await Promise.all(
          sitemapFiles.map((file) =>
            readFile(join(fixture.root, 'dist', file), 'utf8'),
          ),
        )
      ).join('\n');
      const articleLocations = [
        ...sitemap.matchAll(
          /<loc>(https:\/\/example\.invalid\/(?:notes|tools)\/[^<]+)<\/loc>/gu,
        ),
      ].map((match) => match[1]);
      expect(articleLocations.sort()).toEqual(
        expectedArticles
          .filter((article) => article.id !== 'sample-table-content')
          .map(
            (article) =>
              `https://example.invalid/${article.category}/${article.slug}/`,
          )
          .sort(),
      );
      const home = await htmlDocument(fixture.root, 'index.html');
      for (const url of ['/category/notes/', '/category/tools/', '/articles/'])
        expect(
          elements(home, 'a').some((link) => attr(link, 'href') === url),
        ).toBe(true);
      expect(textContent(home)).toContain('精選文章');
      expect(textContent(home)).toContain('最新文章');
      const expectedLists = {
        'category/notes/index.html': [
          '/notes/table-content/',
          '/notes/image-content/',
        ],
        'category/notes/2/index.html': ['/notes/article-basics/'],
        'category/tools/index.html': [
          '/tools/video-content/',
          '/tools/local-editing/',
        ],
        'tag/example/index.html': [
          '/notes/table-content/',
          '/notes/image-content/',
        ],
        'tag/example/2/index.html': [
          '/notes/article-basics/',
          '/tools/local-editing/',
        ],
      };
      for (const [file, links] of Object.entries(expectedLists))
        expect(articleLinks(await htmlDocument(fixture.root, file))).toEqual(
          links,
        );
      const imageDocument = await htmlDocument(
        fixture.root,
        'notes/image-content/index.html',
      );
      expect(
        elements(imageDocument, 'img').some(
          (image) =>
            attr(image, 'width') === '1280' &&
            attr(image, 'height') === '800' &&
            (attr(image, 'srcset') ?? '').includes('image-480.webp 480w') &&
            (attr(image, 'alt') ?? '').includes('藍色'),
        ),
      ).toBe(true);
      const videoDocument = await htmlDocument(
        fixture.root,
        'tools/video-content/index.html',
      );
      expect(elements(videoDocument, 'video')[0]?.attrs).toEqual(
        expect.arrayContaining([
          { name: 'width', value: '640' },
          { name: 'height', value: '360' },
          { name: 'poster', value: `/media/${videoId}/poster.webp` },
        ]),
      );
      const imageOutputs = [
        { variant: 'favicon.png', format: 'png', width: 32, height: 32 },
        { variant: 'image-480.webp', format: 'webp', width: 480, height: 300 },
        { variant: 'image-768.webp', format: 'webp', width: 768, height: 480 },
        {
          variant: 'image-social-crop.webp',
          format: 'webp',
          width: 1200,
          height: 630,
        },
        {
          variant: 'image-social.webp',
          format: 'webp',
          width: 1200,
          height: 630,
        },
        { variant: 'image.webp', format: 'webp', width: 1280, height: 800 },
      ] as const;
      expect(
        (await readdir(join(fixture.root, 'dist/media', imageId))).sort(),
      ).toEqual(imageOutputs.map((output) => output.variant));
      for (const output of imageOutputs) {
        const encoded = await readFile(
          join(fixture.root, 'dist/media', imageId, output.variant),
        );
        expect((await sharp(encoded).metadata()).format).toBe(output.format);
        const decoded = await sharp(encoded)
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect(decoded.info.width).toBe(output.width);
        expect(decoded.info.height).toBe(output.height);
        expect(decoded.data.byteLength).toBeGreaterThan(0);
      }
      expect(
        (await readdir(join(fixture.root, 'dist/media', videoId))).sort(),
      ).toEqual(['poster.webp', 'video.webm']);

      // 更新來源只在沙箱；日期、摘要、首頁精選、分類與Tag卡片均由同一管線重建。
      const metaPath = join(
        fixture.root,
        'content/articles/sample-image-content/meta.json',
      );
      const imageMeta = ArticleMetaSchema.parse(
        JSON.parse(await readFile(metaPath, 'utf8')),
      );
      const changedTitle = '更新後的圖片範例';
      await writeFile(
        metaPath,
        json({
          ...imageMeta,
          title: changedTitle,
          updatedAt: '2026-10-23T10:00:00+08:00',
          seo: { ...imageMeta.seo, description: '更新後的圖片說明與日期。' },
        }),
      );
      const bodyPath = join(
        fixture.root,
        'content/articles/sample-image-content/content.html',
      );
      await writeFile(
        bodyPath,
        (await readFile(bodyPath, 'utf8')) + '\n<p>沙箱更新後的正文。</p>\n',
      );
      const updated = await buildSamples(fixture.root);
      expect(updated['snapshotRevision']).not.toBe(initial['snapshotRevision']);
      for (const file of [
        'index.html',
        'notes/image-content/index.html',
        'category/notes/index.html',
        'tag/example/index.html',
        'tag/media/index.html',
      ])
        expect(textContent(await htmlDocument(fixture.root, file))).toContain(
          changedTitle,
        );
      const changedPage = await htmlDocument(
        fixture.root,
        'notes/image-content/index.html',
      );
      expect(textContent(changedPage)).toContain('沙箱更新後的正文。');
      expect(
        elements(changedPage, 'time').some(
          (element) =>
            attr(element, 'datetime') === '2026-10-23T10:00:00+08:00',
        ),
      ).toBe(true);
      const updatedSearch = SearchIndexSchema.parse(
        JSON.parse(
          await readFile(join(fixture.root, 'dist/search-index.json'), 'utf8'),
        ),
      );
      expect(
        updatedSearch.articles.find(
          (article) => article.id === 'sample-image-content',
        ),
      ).toMatchObject({
        title: changedTitle,
        description: '更新後的圖片說明與日期。',
        updatedAt: '2026-10-23T02:00:00.000Z',
      });
      expect(
        await readFile(join(fixture.root, 'dist/rss.xml'), 'utf8'),
      ).toContain(changedTitle);
      expect(
        (await readdir(join(fixture.root, 'dist/media', imageId))).sort(),
      ).toEqual(imageOutputs.map((output) => output.variant));

      // 文章只新增HTML＋JSON；獨立頁依既定React＋Entry＋登錄流程建立，正式來源不加第六篇。
      const sixth = join(
        fixture.root,
        'content/articles/sandbox-sixth-article',
      );
      await mkdir(sixth);
      await writeFile(
        join(sixth, 'meta.json'),
        json({
          ...imageMeta,
          title: '沙箱第六篇',
          slug: 'sandbox-sixth',
          tags: ['example'],
          publishedAt: '2026-10-23T11:00:00+08:00',
          updatedAt: '2026-10-23T11:00:00+08:00',
        }),
      );
      await writeFile(
        join(sixth, 'content.html'),
        '<h2 id="sixth-section">第六篇的章節</h2><p>只新增 HTML 與 JSON。</p><a href="/sample-guide/#guide-section">獨立頁章節</a>',
      );
      await mkdir(join(fixture.root, 'packages/ui/src/pages/sample-guide'), {
        recursive: true,
      });
      await writeFile(
        join(
          fixture.root,
          'packages/ui/src/pages/sample-guide/SampleGuide.tsx',
        ),
        'export function SampleGuide(){return <main id="ui-main" tabIndex={-1}><h1>沙箱獨立頁</h1><h2 id="guide-section">獨立頁章節</h2><p>由共用 React 套件呈現。</p><a href="/notes/sandbox-sixth/#sixth-section">第六篇文章</a></main>;}\n',
      );
      const uiIndex = join(fixture.root, 'packages/ui/src/index.ts');
      await writeFile(
        uiIndex,
        (await readFile(uiIndex, 'utf8')) +
          "\nexport * from './pages/sample-guide/SampleGuide.js';\n",
      );
      const registry = join(fixture.root, 'site/src/fixed-pages.ts');
      await writeFile(
        registry,
        (await readFile(registry, 'utf8')).replace(
          'export const fixedPages: readonly FixedPage[] = [',
          "export const fixedPages: readonly FixedPage[] = [FixedPageSchema.parse({id:'sample-guide',path:'/sample-guide/',entry:'src/pages/sample-guide/index.astro',seo:{title:'沙箱獨立頁',description:'獨立頁的完整 SEO 說明。'},mediaRefs:[]}),",
        ),
      );
      await mkdir(join(fixture.root, 'site/src/pages/sample-guide'), {
        recursive: true,
      });
      await writeFile(
        join(fixture.root, 'site/src/pages/sample-guide/index.astro'),
        "---\nimport {SampleGuide} from '@foliohaven/ui';\nimport BaseLayout from '../../layouts/BaseLayout.astro';\nimport {loadFixedPage} from '../../lib/server/context.js';\nconst model=await loadFixedPage('sample-guide');\n---\n<BaseLayout site={model.site} seo={model.seo} currentPath=\"/sample-guide/\"><SampleGuide /></BaseLayout>\n",
      );
      await buildSamples(fixture.root);
      expect(
        textContent(
          await htmlDocument(fixture.root, 'notes/sandbox-sixth/index.html'),
        ),
      ).toContain('沙箱第六篇');
      expect(
        textContent(
          await htmlDocument(fixture.root, 'sample-guide/index.html'),
        ),
      ).toContain('沙箱獨立頁');
      expect(
        SearchIndexSchema.parse(
          JSON.parse(
            await readFile(
              join(fixture.root, 'dist/search-index.json'),
              'utf8',
            ),
          ),
        ).articles,
      ).toHaveLength(6);
      expect(
        (await readdir(join(samplesReferenceRoot, 'content/articles'))).sort(),
      ).toEqual(expectedArticles.map((article) => article.id).sort());
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
});
