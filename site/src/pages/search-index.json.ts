import type { APIRoute } from 'astro';
import { loadSearchIndex } from '../lib/server/context.js';
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(await loadSearchIndex()), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
