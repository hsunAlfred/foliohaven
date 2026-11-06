import { loadHomePage } from './context.js';

export async function siteManifestPaths() {
  const { site } = await loadHomePage();
  return site.iconSet?.manifest ? [{ params: { siteManifest: 'site' } }] : [];
}

export async function siteManifestResponse() {
  const manifest = (await loadHomePage()).site.iconSet?.manifest;
  if (!manifest) return new Response(null, { status: 404 });
  return new Response(JSON.stringify(manifest.data), {
    headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' },
  });
}
