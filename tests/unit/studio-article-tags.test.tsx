import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TagSchema } from '@foliohaven/core';
import { ArticleTagsEditor } from '../../studio/src/ArticleTagsEditor.js';
import { StudioApi } from '../../studio/src/api.js';
import {
  ARTICLE_TAG_LIMIT,
  articleTagSearchIndex,
  filterArticleTags,
  toggleArticleTag,
} from '../../studio/src/article-tag-selection.js';

const tag = (slug: string, name: string) =>
  TagSchema.parse({ slug, name, description: '測試 Tag 說明' });
const tags = [
  tag('openai-api', 'OpenAI API'),
  tag('django-channels', 'Django Channels'),
  tag('web-security', '網站安全'),
];

describe('Studio article Tag selection', () => {
  it('searches display names and slugs using case-insensitive normalized terms', () => {
    const index = articleTagSearchIndex(tags);
    for (const query of [
      'OpenAI',
      ' OPENAI-API ',
      'ＯｐｅｎＡＩ',
      'api openai',
    ])
      expect(
        filterArticleTags(index, query).map((value) => value.slug),
      ).toEqual(['openai-api']);
    expect(filterArticleTags(index, '網站')).toEqual([tags[2]]);
    expect(filterArticleTags(index, 'channels django')).toEqual([tags[1]]);
    expect(filterArticleTags(index, '')).toEqual(tags);
    expect(filterArticleTags(index, '不存在')).toEqual([]);
  });

  it('keeps the schema limit of twenty while allowing removal at the limit', () => {
    const original = Object.freeze(
      Array.from({ length: 20 }, (_, i) => `tag-${i}`),
    );
    expect(ARTICLE_TAG_LIMIT).toBe(20);
    expect(toggleArticleTag(original, 'new-tag', true)).toBe(original);
    expect(toggleArticleTag(original, 'tag-0', true)).toBe(original);
    const removed = toggleArticleTag(original, 'tag-3', false);
    expect(removed).toHaveLength(19);
    expect(removed).not.toContain('tag-3');
    expect(toggleArticleTag(removed, 'new-tag', true)).toHaveLength(20);
    expect(original).toHaveLength(20);
  });

  it('preserves unavailable selected slugs and their order until explicitly removed', () => {
    const original = Object.freeze(['missing-tag', 'openai-api']);
    expect(toggleArticleTag(original, 'django-channels', true)).toEqual([
      'missing-tag',
      'openai-api',
      'django-channels',
    ]);
    expect(toggleArticleTag(original, 'missing-tag', false)).toEqual([
      'openai-api',
    ]);
    expect(original).toEqual(['missing-tag', 'openai-api']);
  });

  it('shows selected chips, counts, individual removal, and missing-tag feedback without a checkbox wall', () => {
    const changed = vi.fn();
    const value = Object.freeze(['openai-api', 'missing-tag']);
    const html = renderToStaticMarkup(
      <ArticleTagsEditor
        api={new StudioApi()}
        tags={tags}
        value={value}
        disabled={false}
        onChange={changed}
        onTaxonomySaved={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    expect(html).toContain('aria-label="文章已選 Tag"');
    expect(html).toContain('已選 2 / 20');
    expect(html).toContain('OpenAI API');
    expect(html).toContain('aria-label="移除 Tag：OpenAI API"');
    expect(html).toContain('missing-tag');
    expect(html).toContain('（已失效）');
    expect(html).toContain('原選擇仍保留');
    expect(html).toContain('data-field="meta.tags"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('Django Channels');
    expect(changed).not.toHaveBeenCalled();
    expect(value).toEqual(['openai-api', 'missing-tag']);
  });

  it('keeps an empty/read-only article legible without initializing tags or a picker', () => {
    const changed = vi.fn();
    const html = renderToStaticMarkup(
      <ArticleTagsEditor
        api={new StudioApi()}
        tags={[]}
        value={[]}
        disabled
        onChange={changed}
        onTaxonomySaved={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    expect(html).toContain('尚未選擇 Tag。');
    expect(html).toContain('已選 0 / 20');
    expect(html).toContain('disabled=""');
    expect(html).toContain('套用後仍需保存文章');
    expect(html).not.toContain('<dialog');
    expect(changed).not.toHaveBeenCalled();
  });
});
