import type { Taxonomy } from '@foliohaven/core';

// The UI helps stay within the existing ArticleMeta schema limit.
export const ARTICLE_TAG_LIMIT = 20;

const searchable = (value: string) =>
  value.normalize('NFKC').trim().toLocaleLowerCase();

export function articleTagSearchIndex(tags: Taxonomy['tags']) {
  return tags.map((tag) => ({
    tag,
    searchText: searchable(`${tag.name} ${tag.slug}`),
  }));
}

export function filterArticleTags(
  index: ReturnType<typeof articleTagSearchIndex>,
  query: string,
) {
  const terms = searchable(query).split(/\s+/u).filter(Boolean);
  return index
    .filter((entry) => terms.every((term) => entry.searchText.includes(term)))
    .map((entry) => entry.tag);
}

export function toggleArticleTag(
  selection: readonly string[],
  slug: string,
  checked: boolean,
): readonly string[] {
  if (!checked) return selection.filter((item) => item !== slug);
  if (selection.includes(slug) || selection.length >= ARTICLE_TAG_LIMIT)
    return selection;
  return [...selection, slug];
}
