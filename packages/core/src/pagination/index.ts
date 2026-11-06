import type { Article, PaginationViewModel } from '../models/index.js';
import { PageSchema, PageSizeSchema } from '../schemas/common.js';

export function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function sortArticles<T extends Article>(
  articles: readonly T[],
): readonly T[] {
  return [...articles].sort((left, right) => {
    const leftTime =
      left.meta.publishedAt === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(left.meta.publishedAt);
    const rightTime =
      right.meta.publishedAt === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(right.meta.publishedAt);
    return (
      (rightTime > leftTime ? 1 : rightTime < leftTime ? -1 : 0) ||
      asciiCompare(left.articleId, right.articleId)
    );
  });
}
export interface Paginated<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly validPage: boolean;
}
export function paginate<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): Paginated<T> {
  PageSchema.parse(page);
  PageSizeSchema.parse(pageSize);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  return Object.freeze({
    items: Object.freeze(
      page <= totalPages
        ? items.slice((page - 1) * pageSize, page * pageSize)
        : [],
    ),
    page,
    pageSize,
    total: items.length,
    totalPages,
    validPage: page <= totalPages,
  });
}
export function paginationViewModel(
  total: number,
  page: number,
  pageSize: number,
  urlForPage: (page: number) => string,
): PaginationViewModel {
  if (!Number.isSafeInteger(total) || total < 0)
    throw new RangeError('分頁總數必須是非負整數。');
  PageSchema.parse(page);
  PageSizeSchema.parse(pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return Object.freeze({
    page,
    pageSize,
    totalItems: total,
    totalPages,
    links: Object.freeze(
      Array.from({ length: totalPages }, (_, index) =>
        Object.freeze({
          page: index + 1,
          url: urlForPage(index + 1),
          current: index + 1 === page,
        }),
      ),
    ),
    previousUrl: page > 1 && page <= totalPages ? urlForPage(page - 1) : null,
    nextUrl: page < totalPages ? urlForPage(page + 1) : null,
  });
}
