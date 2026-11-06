import type {
  Article,
  BreadcrumbItem,
  Category,
  CategoryTreeNode,
  CategoryViewModel,
  SiteConfig,
  Tag,
  TagViewModel,
} from '../models/index.js';
import {
  ArticleMetaSchema,
  CategoriesSchema,
  TagsSchema,
} from '../schemas/content.js';
import { CategoryPathSchema, SlugSchema } from '../schemas/common.js';
import {
  articleUrl,
  categoryUrl,
  tagUrl,
  siteRelativePath,
} from '../routing/index.js';
import { asciiCompare } from '../pagination/index.js';

export function categoryContains(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}
export function categoryView(category: Category): CategoryViewModel {
  return Object.freeze({
    path: category.path,
    name: category.name,
    description: category.description,
    url: categoryUrl(category.path),
  });
}
export function tagView(tag: Tag): TagViewModel {
  return Object.freeze({
    slug: tag.slug,
    name: tag.name,
    description: tag.description,
    url: tagUrl(tag.slug),
  });
}
export function categoryArticles<T extends Article>(
  path: string,
  articles: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  return articles.filter(
    (article) =>
      article.meta.category !== null &&
      categoryContains(path, article.meta.category) &&
      !seen.has(article.articleId) &&
      Boolean(seen.add(article.articleId)),
  );
}
export function tagArticles<T extends Article>(
  slug: string,
  articles: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  return articles.filter(
    (article) =>
      article.meta.tags.includes(slug) &&
      !seen.has(article.articleId) &&
      Boolean(seen.add(article.articleId)),
  );
}
export function categoryBreadcrumb(
  path: string | null,
  categories: readonly Category[],
  article?: { readonly title: string; readonly url: string | null },
): readonly BreadcrumbItem[] {
  const result: BreadcrumbItem[] = [{ name: '首頁', url: '/' }];
  if (path !== null) {
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length += 1) {
      const current = parts.slice(0, length).join('/');
      const category = categories.find((item) => item.path === current);
      if (category !== undefined)
        result.push({ name: category.name, url: categoryUrl(current) });
    }
  }
  if (article !== undefined)
    result.push({ name: article.title, url: article.url });
  return Object.freeze(result.map((item) => Object.freeze(item)));
}
export function buildCategoryTree(
  categories: readonly Category[],
  articles: readonly Article[],
): readonly CategoryTreeNode[] {
  CategoriesSchema.parse(categories);
  // Sibling order follows the author-declared category array.
  const childrenOf = (parent: string | null): readonly CategoryTreeNode[] =>
    Object.freeze(
      categories
        .filter((category) => {
          const slash = category.path.lastIndexOf('/');
          return (
            (slash === -1 ? null : category.path.slice(0, slash)) === parent
          );
        })
        .map((category) =>
          Object.freeze({
            ...categoryView(category),
            articleCount: categoryArticles(category.path, articles).length,
            children: childrenOf(category.path),
          }),
        ),
    );
  return childrenOf(null);
}
export interface TaxonomyReferenceInput {
  readonly kind: 'category' | 'tag';
  readonly key: string;
  readonly articles: readonly Article[];
  readonly categories: readonly Category[];
  readonly site: SiteConfig;
}
function navigationPath(href: string, site: SiteConfig): string | null {
  return siteRelativePath(href, site.siteUrl);
}
export function scanTaxonomyReferences(input: TaxonomyReferenceInput) {
  const articleIds = input.articles
    .filter((article) =>
      input.kind === 'category'
        ? article.meta.category !== null &&
          categoryContains(input.key, article.meta.category)
        : article.meta.tags.includes(input.key),
    )
    .map((article) => article.articleId)
    .sort(asciiCompare);
  const childCategoryPaths =
    input.kind === 'category'
      ? input.categories
          .filter(
            (category) =>
              category.path !== input.key &&
              categoryContains(input.key, category.path),
          )
          .map((category) => category.path)
          .sort(asciiCompare)
      : [];
  const base =
    input.kind === 'category' ? categoryUrl(input.key) : tagUrl(input.key);
  const navigationReferences = input.site.navigation.flatMap((item, index) => {
    const path = navigationPath(item.href, input.site);
    if (path === null) return [];
    return path === base ||
      path.startsWith(base) ||
      input.articles.some(
        (article) =>
          articleIds.includes(article.articleId) &&
          article.meta.category !== null &&
          CategoryPathSchema.safeParse(article.meta.category).success &&
          SlugSchema.safeParse(article.meta.slug).success &&
          articleUrl(article.meta.category, article.meta.slug) === path,
      )
      ? [index]
      : [];
  });
  return Object.freeze({
    articleIds: Object.freeze(articleIds),
    articleCount: articleIds.length,
    childCategoryPaths: Object.freeze(childCategoryPaths),
    navigationReferences: Object.freeze(navigationReferences),
    referenced:
      articleIds.length > 0 ||
      childCategoryPaths.length > 0 ||
      navigationReferences.length > 0,
  });
}
export interface TaxonomyMigrationInput {
  readonly kind: 'category' | 'tag';
  readonly from: string;
  readonly to: string;
  readonly site: SiteConfig;
  readonly categories: readonly Category[];
  readonly tags: readonly Tag[];
  readonly articles: readonly Article[];
}
export function planTaxonomyMigration(input: TaxonomyMigrationInput) {
  const schema = input.kind === 'category' ? CategoryPathSchema : SlugSchema;
  schema.parse(input.from);
  schema.parse(input.to);
  if (input.from === input.to) throw new Error('新舊分類或 Tag 識別不可相同。');
  const exists =
    input.kind === 'category'
      ? input.categories.some((item) => item.path === input.from)
      : input.tags.some((item) => item.slug === input.from);
  const occupied =
    input.kind === 'category'
      ? input.categories.some((item) => item.path === input.to)
      : input.tags.some((item) => item.slug === input.to);
  if (!exists) throw new Error('要改名的分類或 Tag 不存在。');
  if (occupied) throw new Error('新分類或 Tag 識別已存在。');
  if (input.kind === 'category' && categoryContains(input.from, input.to))
    throw new Error('分類不可搬移至自身後代。');
  const renameCategory = (path: string) =>
    input.kind === 'category' && categoryContains(input.from, path)
      ? `${input.to}${path.slice(input.from.length)}`
      : path;
  const categories = CategoriesSchema.parse(
    input.categories.map((category) => ({
      ...category,
      path: renameCategory(category.path),
    })),
  );
  const tags = TagsSchema.parse(
    input.tags.map((tag) => ({
      ...tag,
      slug:
        input.kind === 'tag' && tag.slug === input.from ? input.to : tag.slug,
    })),
  );
  const changedUrls: { articleId: string; from: string; to: string }[] = [];
  const affectedArticleIds: string[] = [];
  const articles: Article[] = input.articles.map((article) => {
    const category =
      article.meta.category === null
        ? null
        : renameCategory(article.meta.category);
    const nextTags = [
      ...new Set(
        article.meta.tags.map((slug) =>
          input.kind === 'tag' && slug === input.from ? input.to : slug,
        ),
      ),
    ];
    if (
      category !== article.meta.category ||
      nextTags.length !== article.meta.tags.length ||
      nextTags.some((slug, index) => slug !== article.meta.tags[index])
    )
      affectedArticleIds.push(article.articleId);
    if (
      category !== article.meta.category &&
      category !== null &&
      article.meta.category !== null &&
      SlugSchema.safeParse(article.meta.slug).success &&
      CategoryPathSchema.safeParse(article.meta.category).success
    )
      changedUrls.push({
        articleId: article.articleId,
        from: articleUrl(article.meta.category, article.meta.slug),
        to: articleUrl(category, article.meta.slug),
      });
    const meta = ArticleMetaSchema.parse({
      ...article.meta,
      category,
      tags: nextTags,
    });
    return { ...article, meta };
  });
  const navigationReferences: number[] = [];
  const navigation = input.site.navigation.map((item, index) => {
    const path = navigationPath(item.href, input.site);
    if (path === null) return { ...item };
    const articleChange = changedUrls.find((change) => change.from === path);
    const oldBase =
      input.kind === 'category' ? categoryUrl(input.from) : tagUrl(input.from);
    const newBase =
      input.kind === 'category' ? categoryUrl(input.to) : tagUrl(input.to);
    const replacement =
      articleChange?.to ??
      (path === oldBase || path.startsWith(oldBase)
        ? `${newBase}${path.slice(oldBase.length)}`
        : path);
    if (replacement === path) return { ...item };
    navigationReferences.push(index);
    if (item.href.startsWith('/')) return { ...item, href: replacement };
    const absolute = new URL(item.href);
    absolute.pathname = replacement;
    return { ...item, href: absolute.href };
  });
  return Object.freeze({
    kind: input.kind,
    from: input.from,
    to: input.to,
    affectedArticleIds: Object.freeze(affectedArticleIds.sort(asciiCompare)),
    affectedCategoryPaths: Object.freeze(
      input.kind === 'category'
        ? input.categories
            .filter((category) => categoryContains(input.from, category.path))
            .map((category) => category.path)
            .sort(asciiCompare)
        : [],
    ),
    navigationReferences: Object.freeze(navigationReferences),
    changedUrls: Object.freeze(changedUrls),
    next: { categories, tags, articles, site: { ...input.site, navigation } },
  });
}
