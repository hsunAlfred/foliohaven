import type { APIRoute } from 'astro';
import { absoluteSiteUrl } from '@foliohaven/core';
import { loadRenderContext } from '../lib/server/context.js';
export const GET: APIRoute = async () => {
  const { site } = await loadRenderContext();
  return new Response(
    `User-agent: *\nAllow: /\nSitemap: ${absoluteSiteUrl(site, '/sitemap-index.xml')}\n`,
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
};
