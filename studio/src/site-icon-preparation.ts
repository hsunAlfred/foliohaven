import { MediaSourceResourceSchema, siteIconMediaRefs } from '@foliohaven/core';
import type { SiteConfig } from '@foliohaven/core';
import { ApiFailure } from './api.js';
import type { StudioApi } from './api.js';

export function siteIconSourceRequirements(site: SiteConfig) {
  const sources = new Map<string, Set<string>>();
  if (!site.icons.enabled) return sources;
  for (const path of siteIconMediaRefs(site)) {
    const sourceId = path.split('/')[2];
    if (!sourceId) throw new Error('網站圖示路徑缺少媒體來源。');
    const paths = sources.get(sourceId) ?? new Set<string>();
    paths.add(path);
    sources.set(sourceId, paths);
  }
  return sources;
}

export async function firstMissingSiteIconSource(
  api: StudioApi,
  site: SiteConfig,
  signal?: AbortSignal,
): Promise<{ sourceId: string; missingPaths: readonly string[] } | null> {
  for (const [sourceId, paths] of siteIconSourceRequirements(site)) {
    const response = await api.get<unknown>(
      `/api/v1/media/sources/${sourceId}`,
      {
        ...(signal ? { signal } : {}),
      },
    );
    const source = MediaSourceResourceSchema.parse(response.data);
    if (source.id !== sourceId || source.kind !== 'image')
      throw new ApiFailure(
        422,
        'INVALID_SITE_ICON_SOURCE',
        '網站圖示必須使用有效的受管圖片。',
      );
    const outputs = new Set(
      source.asset?.sourceSha256 === source.sourceSha256
        ? source.asset.outputs.map((output) => output.publicPath)
        : [],
    );
    const missingPaths = [...paths].filter((path) => !outputs.has(path));
    if (missingPaths.length) return { sourceId, missingPaths };
  }
  return null;
}
