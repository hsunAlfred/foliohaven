import {
  ArticleMetaSchema,
  CategoriesSchema,
  FixedPageSchema,
  SiteConfigSchema,
  TagsSchema,
  buildSiteModel,
  previewArticle,
} from '@foliohaven/core';
import type { Article } from '@foliohaven/core';

export const uiRawHtml =
  '<!-- 原始正文，不經 React 重新序列化 -->\n<h2 id="章節">章節 &amp; 說明</h2>\n<p class="author-class">RAW_HTML_SENTINEL  原始文字</p>\n<h3 id="details">詳細內容</h3>\n<pre><code>' +
  'very_long_code_without_breaks_'.repeat(30) +
  '</code></pre>\n<table><caption>資料表格</caption><thead><tr>' +
  Array.from({ length: 12 }, (_, i) => `<th>欄位${i + 1}</th>`).join('') +
  '</tr></thead><tbody><tr>' +
  Array.from({ length: 12 }, (_, i) => `<td>資料${i + 1}</td>`).join('') +
  '</tr></tbody></table>\n';
export function uiModels() {
  const mediaId = 'b9b5681a-36f0-49bf-a715-7604db77a32f';
  const image = `/media/${mediaId}/image.webp`;
  const site = SiteConfigSchema.parse({
    siteName: 'UI 測試網站',
    siteDescription: '完整靜態內容與共用展示元件。',
    siteUrl: 'https://example.invalid/',
    language: 'zh-Hant',
    timeZone: 'Asia/Taipei',
    author: { name: '測試作者', url: null },
    navigation: [
      { label: '首頁', href: '/' },
      { label: '筆記', href: '/category/notes/' },
      { label: '文章總覽', href: '/articles/' },
    ],
    pagination: { category: 2, tag: 2, articles: 2 },
    home: { featuredArticleIds: ['ui-first'], latestCount: 5 },
  });
  const categories = CategoriesSchema.parse([
    { path: 'notes', name: '筆記', description: '測試分類文章。' },
    { path: 'empty', name: '空分類', description: '暫無文章。' },
  ]);
  const tags = TagsSchema.parse([
    { slug: 'example', name: '範例 <&>', description: '測試標籤。' },
    { slug: 'empty', name: '空標籤', description: '暫無文章。' },
  ]);
  const fixedPages = [
    FixedPageSchema.parse({
      id: 'home',
      path: '/',
      entry: 'src/pages/index.astro',
    }),
    FixedPageSchema.parse({
      id: 'articles',
      path: '/articles/',
      entry: 'src/pages/articles/index.astro',
    }),
  ];
  const articles: Article[] = ['ui-first', 'ui-second', 'ui-third'].map(
    (articleId, index) => ({
      articleId,
      contentHtml: index === 0 ? uiRawHtml : '<p>沒有 Heading 的文章。</p>\n',
      meta: ArticleMetaSchema.parse({
        status: 'published',
        title:
          index === 0
            ? '文字 <script>不執行</script> & 標題'
            : `展示文章 ${index + 1}`,
        slug: articleId,
        category: 'notes',
        tags: index === 2 ? [] : ['example'],
        publishedAt: '2026-10-22T23:30:00Z',
        updatedAt: '2026-10-23T01:00:00Z',
        featuredImage: index === 0 ? image : null,
        featuredImageAlt: index === 0 ? '圖片 & 替代文字' : '',
        seo: { description: `展示文章 ${index + 1} 的摘要。` },
      }),
    }),
  );
  const mediaManifest = {
    schemaVersion: 1 as const,
    assets: [
      {
        id: mediaId,
        kind: 'image' as const,
        sourceSha256: 'a'.repeat(64),
        presetVersion: 'ui-fixture-v1',
        tools: { sharp: 'fixture' },
        outputs: [
          {
            publicPath: image,
            mimeType: 'image/webp' as const,
            width: 1200,
            height: 675,
            byteSize: 1000,
            sha256: 'b'.repeat(64),
          },
          {
            publicPath: `/media/${mediaId}/image-480.webp`,
            mimeType: 'image/webp' as const,
            width: 480,
            height: 270,
            byteSize: 300,
            sha256: 'c'.repeat(64),
          },
        ],
      },
    ],
  };
  const input = {
    site,
    categories,
    tags,
    articles,
    fixedPages,
    mediaManifest,
    now: '2026-10-24T00:00:00Z',
  };
  const model = buildSiteModel(input);
  const preview = previewArticle({
    ...input,
    article: {
      articleId: 'ui-draft',
      contentHtml: '<p>未命名草稿正文。</p>\n',
      meta: ArticleMetaSchema.parse({ status: 'draft' }),
    },
  });
  return { model, preview };
}
