import { TagSchema, TaxonomySchema } from '@foliohaven/core';
import type { Tag, Taxonomy } from '@foliohaven/core';
import { ApiFailure } from './api.js';
import type { StudioApi } from './api.js';

const normalizedName = (value: string) =>
  value.normalize('NFKC').trim().toLocaleLowerCase();

function matchingTag(taxonomy: Taxonomy, candidate: Tag) {
  return taxonomy.tags.find(
    (tag) => JSON.stringify(tag) === JSON.stringify(candidate),
  );
}

function resultUnconfirmed(error: unknown) {
  return (
    error instanceof ApiFailure &&
    (error.status === 0 ||
      error.status === 408 ||
      error.status >= 500 ||
      (error.code === 'INVALID_API_RESPONSE' &&
        error.status >= 200 &&
        error.status < 300))
  );
}

/** Append to the latest taxonomy using its exact version, without stale retries. */
export async function createArticleTag(
  api: StudioApi,
  value: unknown,
): Promise<{ tag: Tag; taxonomy: Taxonomy }> {
  const tag = TagSchema.parse(value);
  const current = await api.get<Taxonomy>('/api/v1/taxonomy');
  const taxonomy = TaxonomySchema.parse(current.data);
  if (current.etag === null || current.etag === '')
    throw new ApiFailure(
      428,
      'TAXONOMY_VERSION_REQUIRED',
      '無法取得分類與 Tag 的版本，請重新讀取後再試。',
    );
  if (taxonomy.tags.some((item) => item.slug === tag.slug))
    throw new ApiFailure(
      409,
      'TAG_SLUG_EXISTS',
      '已有相同網址名稱的 Tag，請返回選單勾選，或修改網址名稱。',
      [
        {
          path: ['slug'],
          code: 'duplicate',
          message: '這個 Tag 網址名稱已被使用。',
        },
      ],
    );
  if (
    taxonomy.tags.some(
      (item) => normalizedName(item.name) === normalizedName(tag.name),
    )
  )
    throw new ApiFailure(
      409,
      'TAG_NAME_EXISTS',
      '已有相同名稱的 Tag，請返回選單勾選，或修改名稱。',
      [
        {
          path: ['name'],
          code: 'duplicate',
          message: '這個 Tag 名稱已存在。',
        },
      ],
    );

  const candidate = TaxonomySchema.parse({
    ...taxonomy,
    tags: [...taxonomy.tags, tag],
  });
  try {
    const response = await api.send<Taxonomy>(
      'PUT',
      '/api/v1/taxonomy',
      candidate,
      { etag: current.etag },
    );
    const parsed = TaxonomySchema.safeParse(response.data);
    const created = parsed.success ? matchingTag(parsed.data, tag) : undefined;
    if (!parsed.success || !created)
      throw new ApiFailure(
        200,
        'INVALID_API_RESPONSE',
        '新增 Tag 的回應無法確認，請確認已保存的 Tag 後再試。',
      );
    return { tag: created, taxonomy: parsed.data };
  } catch (error) {
    if (resultUnconfirmed(error)) {
      // A lost response may still have committed. Verify the full Tag without
      // replaying a write or overwriting taxonomy changes made by another tab.
      try {
        const response = await api.get<Taxonomy>('/api/v1/taxonomy');
        const confirmed = TaxonomySchema.parse(response.data);
        const created = matchingTag(confirmed, tag);
        if (created) return { tag: created, taxonomy: confirmed };
      } catch {
        // Keep the original failure if authoritative verification also fails.
      }
    }
    throw error;
  }
}
