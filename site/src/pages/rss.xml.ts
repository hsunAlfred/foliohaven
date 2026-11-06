import type { APIRoute } from 'astro';
import rss from '@astrojs/rss';
import { loadRenderContext } from '../lib/server/context.js';
const xmlEscape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
export const GET: APIRoute = async () => {
  const context = await loadRenderContext();
  const articles = context.articles.slice(0, context.site.rss.maxItems);
  const updated = articles.reduce<string | null>(
    (latest, item) =>
      latest === null || Date.parse(item.updatedAt) > Date.parse(latest)
        ? item.updatedAt
        : latest,
    null,
  );
  return rss({
    title: context.site.rss.title,
    description: context.site.rss.description,
    site: context.site.siteUrl,
    customData: `<language>${xmlEscape(context.site.language)}</language>${updated === null ? '' : `<lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>`}`,
    items: articles.map((article) => ({
      title: article.title,
      description: article.description,
      link: article.url,
      pubDate: new Date(article.publishedAt),
      customData: `<guid isPermaLink="false">${xmlEscape(`article:${article.id}`)}</guid>`,
    })),
  });
};
