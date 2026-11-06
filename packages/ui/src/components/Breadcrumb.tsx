import type { BreadcrumbItem } from '@foliohaven/core';

export interface BreadcrumbProps {
  readonly items: readonly BreadcrumbItem[];
}
export function Breadcrumb({ items }: BreadcrumbProps) {
  if (items.length === 0) return null;
  return (
    <nav className="breadcrumb" aria-label="所在位置">
      <ol>
        {items.map((item, index) => (
          <li key={`${item.name}:${index}`}>
            {item.url === null ? (
              <span
                aria-current={index === items.length - 1 ? 'page' : undefined}
              >
                {item.name}
              </span>
            ) : (
              <a
                href={item.url}
                aria-current={index === items.length - 1 ? 'page' : undefined}
              >
                {item.name}
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
