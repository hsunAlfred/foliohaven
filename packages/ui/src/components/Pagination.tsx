import type { PaginationViewModel } from '@foliohaven/core';

export interface PaginationProps {
  readonly pagination: PaginationViewModel;
  readonly label?: string;
}
export function Pagination({
  pagination,
  label = '文章分頁',
}: PaginationProps) {
  if (pagination.totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label={label}>
      <ul>
        {pagination.previousUrl !== null && (
          <li>
            <a href={pagination.previousUrl} rel="prev">
              上一頁
            </a>
          </li>
        )}
        {pagination.links.map((link) => (
          <li key={link.page}>
            {link.current ? (
              <span
                className="pagination-current"
                aria-current="page"
                aria-label={`目前為第 ${link.page} 頁`}
              >
                {link.page}
              </span>
            ) : (
              <a href={link.url} aria-label={`第 ${link.page} 頁`}>
                {link.page}
              </a>
            )}
          </li>
        ))}
        {pagination.nextUrl !== null && (
          <li>
            <a href={pagination.nextUrl} rel="next">
              下一頁
            </a>
          </li>
        )}
      </ul>
      <p>
        第 {pagination.page} 頁，共 {pagination.totalPages} 頁
      </p>
    </nav>
  );
}
