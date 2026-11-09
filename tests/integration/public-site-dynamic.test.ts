import { expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ArticleMetaSchema,
  CategoriesSchema,
  SiteConfigSchema,
} from '@foliohaven/core';
import { createStaticPreview } from '../../server/src/static-preview/index.js';
import {
  buildSamples,
  samplesWorkspace,
} from '../fixtures/samples/workspace.js';
import {
  expectSearchPublicSite,
  expectStaticPublicSite,
  isPrivatePublicRequest,
  publicSiteExpected,
} from '../fixtures/public-site/assertions.js';

function json(value: unknown) {
  return JSON.stringify(value, null, 2) + '\n';
}
async function read(root: string, key: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, key), 'utf8')) as unknown;
}
it('public request boundaries reject only protected root prefixes, allowing article slugs with the same words', () => {
  for (const path of [
    '/api/v1/jobs',
    '/server/file',
    '/studio/',
    '/content/site.json',
    '/.foliohaven/cache/file',
    '/media/source/id/original.png',
  ])
    expect(isPrivatePublicRequest(path)).toBe(true);
  for (const path of [
    '/notes/server/',
    '/journal/content/',
    '/tools/studio/',
    '/category/content/',
    '/media/id/image.webp',
    '/articles/?q=api',
    '/search-index.json',
  ])
    expect(isPrivatePublicRequest(path)).toBe(false);
});

it('the same public browser assertions follow six renamed author sources and a genuine empty site through two default CLI builds', async () => {
  const fixture = await samplesWorkspace();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const root = fixture.root;
    const mapping = new Map([
      ['notes', 'journal'],
      ['tools', 'utilities'],
    ]);
    const rewrite = (value: string) =>
      value
        .replaceAll('/notes/', '/journal/')
        .replaceAll('/tools/', '/utilities/');
    const categories = CategoriesSchema.parse(
      await read(root, 'content/categories.json'),
    ).map((category) => ({
      ...category,
      path: mapping.get(category.path) ?? category.path,
      name: `動態${category.name}`,
    }));
    await writeFile(join(root, 'content/categories.json'), json(categories));
    for (const id of await readdir(join(root, 'content/articles'))) {
      const resource = `content/articles/${id}`;
      const meta = ArticleMetaSchema.parse(
        await read(root, `${resource}/meta.json`),
      );
      await writeFile(
        join(root, resource, 'meta.json'),
        json({
          ...meta,
          category:
            meta.category === null
              ? null
              : (mapping.get(meta.category) ?? meta.category),
        }),
      );
      await writeFile(
        join(root, resource, 'content.html'),
        rewrite(await readFile(join(root, resource, 'content.html'), 'utf8')),
      );
    }
    const site = SiteConfigSchema.parse(await read(root, 'content/site.json'));
    const dynamicSite = SiteConfigSchema.parse({
      ...site,
      siteName: '作者修改後的公開網站',
      siteDescription: '此站不是固定五篇示範的內容與名稱。',
      siteUrl: 'https://dynamic-public.invalid/',
      navigation: site.navigation.map((item) => ({
        ...item,
        href: rewrite(item.href),
      })),
      pagination: { category: 1, tag: 3, articles: 4 },
      home: { featuredArticleIds: ['authoring-dynamic-sixth'], latestCount: 6 },
    });
    await writeFile(join(root, 'content/site.json'), json(dynamicSite));
    const resource = join(root, 'content/articles/authoring-dynamic-sixth');
    await mkdir(resource);
    await writeFile(
      join(resource, 'meta.json'),
      json(
        ArticleMetaSchema.parse({
          status: 'published',
          title: '第六篇作者文章與合法 content 路徑',
          slug: 'content',
          category: 'journal',
          tags: [],
          publishedAt: '2027-01-01T00:00:00Z',
          updatedAt: '2027-01-01T00:00:00Z',
          seo: {
            description: '以不同篇數、分類、名稱與頁面大小驗證公開網站。',
          },
        }),
      ),
    );
    await writeFile(join(resource, 'content.html'), '');
    await buildSamples(root);
    browser = await chromium.launch();
    const check = async (count: number) => {
      const expected = await publicSiteExpected(root);
      const preview = createStaticPreview({ repositoryRoot: root });
      try {
        expect(expected.model.articlePages).toHaveLength(count);
        expect(expected.model.site.siteName).toBe(dynamicSite.siteName);
        expect(expected.model.site.pagination.articles).toBe(4);
        const address = await preview.listen({ port: 0 });
        if (!browser) throw new Error('Isolated browser missing');
        await expectStaticPublicSite(browser, address.url, expected);
        const context = await browser.newContext();
        try {
          await expectSearchPublicSite(
            await context.newPage(),
            address.url,
            expected,
          );
        } finally {
          await context.close();
        }
      } finally {
        await preview.close();
        await expected.cleanup();
      }
    };
    await check(6);
    await rm(join(root, 'content/articles'), { recursive: true });
    await mkdir(join(root, 'content/articles'));
    await writeFile(
      join(root, 'content/site.json'),
      json({
        ...dynamicSite,
        home: { ...dynamicSite.home, featuredArticleIds: [] },
      }),
    );
    await buildSamples(root);
    await check(0);
  } finally {
    await browser?.close();
    await fixture.cleanup();
  }
}, 360_000);
