import { describe, expect, it } from 'vitest';
import { uiModels } from '../fixtures/ui-models.js';
import { searchPageViewModel } from '../../packages/core/src/search/page.js';

describe('public search page projection', () => {
  it('keeps static SEO and presents real shared cards, images, taxonomy links and query pagination', () => {
    const { model } = uiModels();
    const initial = model.listPages.find((page) => page.kind === 'articles');
    if (!initial) throw new Error('Missing article list fixture');
    const result = searchPageViewModel(
      initial,
      model.searchIndex.articles,
      '?page=2',
    );
    expect(result.validPage).toBe(true);
    expect(result.model.articles.map((card) => card.articleId)).toEqual([
      'ui-third',
    ]);
    expect(result.model.seo).toBe(initial.seo);
    expect(result.model.pagination.previousUrl).toBe('/articles/');
    const image = searchPageViewModel(
      initial,
      model.searchIndex.articles,
      '?q=script',
    );
    expect(image.model.articles[0]?.featuredImage).toEqual(
      model.searchIndex.articles[0]?.featuredImage,
    );
    expect(image.model.articles[0]?.category.url).toBe('/category/notes/');
    expect(image.model.articles[0]?.tags[0]?.url).toBe('/tag/example/');
  });
  it.each([
    '?page=0',
    '?page=99',
    '?page=1.5',
    '?page=1e2',
    '?q=' + '字'.repeat(201),
  ])(
    'exposes invalid query empty state and a valid first-page URL: %s',
    (query) => {
      const { model } = uiModels();
      const initial = model.listPages.find((page) => page.kind === 'articles');
      if (!initial) throw new Error('Missing article list fixture');
      const result = searchPageViewModel(
        initial,
        model.searchIndex.articles,
        query,
      );
      expect(result.validPage).toBe(false);
      expect(result.model.articles).toEqual([]);
      expect(result.firstPageUrl).toBe('/articles/');
    },
  );
});
