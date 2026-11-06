import { describe, expect, it, vi } from 'vitest';
import { TagSchema, TaxonomySchema } from '@foliohaven/core';
import type { Taxonomy } from '@foliohaven/core';
import { ApiFailure, StudioApi } from '../../studio/src/api.js';
import { createArticleTag } from '../../studio/src/article-tag-creation.js';

const etag = `"${'a'.repeat(64)}"`;
const value = {
  name: 'New topic',
  slug: 'new-topic',
  description: 'A focused technical topic.',
};
const tag = TagSchema.parse(value);
const taxonomy = TaxonomySchema.parse({
  categories: [
    { path: 'notes', name: 'Notes', description: 'Technical notes.' },
    { path: 'tools', name: 'Tools', description: 'Tooling notes.' },
  ],
  tags: [
    { slug: 'example', name: 'Example', description: 'Existing topic.' },
    { slug: 'another', name: 'Another', description: 'A recent addition.' },
  ],
});
const response = (data: Taxonomy, version: string | null = etag) => ({
  data,
  etag: version,
  location: null,
  requestId: null,
});
function fixture() {
  const api = new StudioApi();
  const get = vi.spyOn(api, 'get').mockResolvedValue(response(taxonomy));
  const saved = { ...taxonomy, tags: [...taxonomy.tags, tag] };
  const send = vi.spyOn(api, 'send').mockResolvedValue(response(saved));
  return { api, get, send, saved };
}

describe('creating a Tag from an article', () => {
  it('validates names, descriptions and canonical slugs before contacting the service', async () => {
    const { api, get, send } = fixture();
    for (const invalid of [
      { ...value, name: ' ' },
      { ...value, description: '' },
      { ...value, slug: '123' },
      { ...value, slug: 'Invalid Slug' },
    ])
      await expect(createArticleTag(api, invalid)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('appends to fresh taxonomy with its exact ETag and preserves every existing category and Tag', async () => {
    const { api, get, send, saved } = fixture();
    const result = await createArticleTag(api, value);
    expect(get).toHaveBeenCalledExactlyOnceWith('/api/v1/taxonomy');
    expect(send).toHaveBeenCalledExactlyOnceWith(
      'PUT',
      '/api/v1/taxonomy',
      saved,
      { etag },
    );
    expect(result).toEqual({ tag, taxonomy: saved });
    expect(taxonomy.tags).toHaveLength(2);
  });

  it('does not save without the taxonomy version', async () => {
    const { api, get, send } = fixture();
    get.mockResolvedValueOnce(response(taxonomy, null));
    await expect(createArticleTag(api, value)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an existing slug and a normalized duplicate display name without overwriting either', async () => {
    const { api, send } = fixture();
    for (const duplicate of [
      { ...value, slug: 'example' },
      { ...value, name: ' ＥＸＡＭＰＬＥ ' },
    ])
      await expect(createArticleTag(api, duplicate)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves a concurrent-write conflict and never automatically resubmits the old taxonomy', async () => {
    const { api, get, send } = fixture();
    const conflict = new ApiFailure(412, 'PRECONDITION_FAILED', '版本已變動');
    send.mockRejectedValueOnce(conflict);
    await expect(createArticleTag(api, value)).rejects.toBe(conflict);
    expect(send).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  });

  it('keeps a rejected write as an error instead of treating an existing matching Tag as a successful new save', async () => {
    const { api, get, send } = fixture();
    const rejected = new ApiFailure(422, 'CONTENT_INVALID', '內容驗證失敗');
    send.mockRejectedValueOnce(rejected);
    await expect(createArticleTag(api, value)).rejects.toBe(rejected);
    expect(send).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  });

  it('verifies a successful-looking response that does not actually contain the created Tag', async () => {
    const { api, get, send, saved } = fixture();
    send.mockResolvedValueOnce(response(taxonomy));
    get.mockResolvedValueOnce(response(taxonomy));
    get.mockResolvedValueOnce(response(saved));
    await expect(createArticleTag(api, value)).resolves.toEqual({
      tag,
      taxonomy: saved,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    new ApiFailure(0, 'SERVICE_UNAVAILABLE', '連線中斷'),
    new ApiFailure(503, 'SERVICE_UNAVAILABLE', '服務回應遺失'),
    new ApiFailure(200, 'INVALID_API_RESPONSE', '回應不是 JSON'),
  ])(
    'confirms an uncertain write using fresh server data rather than repeating the write: %s',
    async (failure) => {
      const { api, get, send, saved } = fixture();
      const current = {
        ...saved,
        tags: [
          ...saved.tags,
          TagSchema.parse({
            slug: 'concurrent',
            name: 'Concurrent',
            description: 'Another author added this after the write.',
          }),
        ],
      };
      send.mockRejectedValueOnce(failure);
      get.mockResolvedValueOnce(response(taxonomy));
      get.mockResolvedValueOnce(response(current));
      await expect(createArticleTag(api, value)).resolves.toEqual({
        tag,
        taxonomy: current,
      });
      expect(send).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledTimes(2);
    },
  );

  it('does not claim success for an absent Tag or a same-slug Tag with different data after an uncertain write', async () => {
    for (const current of [
      taxonomy,
      {
        ...taxonomy,
        tags: [
          ...taxonomy.tags,
          { ...tag, description: 'Different author data.' },
        ],
      },
    ]) {
      const { api, get, send } = fixture();
      const failure = new ApiFailure(0, 'SERVICE_UNAVAILABLE', '連線中斷');
      send.mockRejectedValueOnce(failure);
      get.mockResolvedValueOnce(response(taxonomy));
      get.mockResolvedValueOnce(response(current));
      await expect(createArticleTag(api, value)).rejects.toBe(failure);
      expect(send).toHaveBeenCalledOnce();
    }
  });

  it('keeps the original uncertain-write error if verification also fails', async () => {
    const { api, get, send } = fixture();
    const failure = new ApiFailure(0, 'SERVICE_UNAVAILABLE', '連線中斷');
    send.mockRejectedValueOnce(failure);
    get.mockResolvedValueOnce(response(taxonomy));
    get.mockRejectedValueOnce(new ApiFailure(503, 'UNAVAILABLE', '仍無法讀取'));
    await expect(createArticleTag(api, value)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledOnce();
  });
});
