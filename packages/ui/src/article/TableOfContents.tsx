import type { TocEntry } from '@foliohaven/core';

export interface TableOfContentsProps {
  readonly entries: readonly TocEntry[];
}
export function TableOfContents({ entries }: TableOfContentsProps) {
  if (entries.length === 0) return null;
  return (
    <nav className="table-of-contents" aria-labelledby="ui-toc-title">
      <details open data-reading-toc data-reading-toc-state="ready">
        <summary id="ui-toc-title">文章目錄</summary>
        <ol data-reading-toc-list>
          {entries.map((entry) => (
            <li
              key={entry.id}
              className={entry.level === 3 ? 'toc-level-three' : undefined}
            >
              <a
                data-reading-toc-link
                href={`#${encodeURIComponent(entry.id)}`}
              >
                {entry.text}
              </a>
            </li>
          ))}
        </ol>
      </details>
    </nav>
  );
}
