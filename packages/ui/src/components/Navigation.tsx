import type { SiteViewModel } from '@foliohaven/core';

export interface NavigationProps {
  readonly items: SiteViewModel['navigation'];
  readonly currentPath?: string;
  readonly label?: string;
}
export function Navigation({
  items,
  currentPath,
  label = '主要導覽',
}: NavigationProps) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={label} className="site-navigation">
      <ul>
        {items.map((item, index) => (
          <li key={`${item.href}:${index}`}>
            <a
              href={item.href}
              aria-current={item.href === currentPath ? 'page' : undefined}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
