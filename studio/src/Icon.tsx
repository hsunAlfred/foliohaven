import type { CSSProperties } from 'react';

const paths = {
  save: 'M5 3h12l4 4v14H3V3h2 M7 3v6h10V3 M7 21v-8h10v8',
  plus: 'M12 5v14 M5 12h14',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  close: 'M6 6l12 12 M18 6 6 18',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 16v5h16v-5',
  image: 'M3 3h18v18H3z M3 16l6-6 6 6 3-3 3 3 M16 7h.01',
  video: 'M3 5h12v14H3z M15 10l6-4v12l-6-4',
  folder: 'M3 6V4h7l2 3h9v13H3V6',
  tag: 'M3 3h9l10 10-9 9L3 12z M7 7h.01',
  settings: 'M4 7h16 M4 17h16 M8 3v8 M16 13v8',
  article: 'M5 2h14v20H5z M8 7h8 M8 11h8 M8 15h5',
  calendar: 'M3 5h18v16H3z M7 2v6 M17 2v6 M3 10h18 M7 14h2 M15 14h2 M7 18h2',
  clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M12 6v6l4 2',
  monitor: 'M2 3h20v14H2z M12 17v5 M7 22h10',
  tablet: 'M4 2h16v20H4z M11 18h2',
  smartphone: 'M7 2h10v20H7z M11 18h2',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  refresh:
    'M20 7a9 9 0 0 0-15-2L2 8 M2 3v5h5 M4 17a9 9 0 0 0 15 2l3-3 M17 16h5v5',
  check: 'M4 12l5 5L20 6',
  alert: 'M12 3 1 21h22L12 3 M12 9v5 M12 17h.01',
  info: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M12 11v6 M12 7h.01',
  link: 'M10 13a5 5 0 0 0 7 0l4-4a5 5 0 0 0-7-7l-3 3 M14 11a5 5 0 0 0-7 0l-4 4a5 5 0 0 0 7 7l3-3',
  externalLink: 'M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  arrowLeft: 'M20 12H4 M10 6l-6 6 6 6',
  arrowRight: 'M4 12h16 M14 6l6 6-6 6',
  globe:
    'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M2 12h20 M12 2c5 6 5 14 0 20-5-6-5-14 0-20',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 22v-3a8 8 0 0 1 16 0v3',
  rss: 'M3 3a18 18 0 0 1 18 18 M3 10a11 11 0 0 1 11 11 M5 20a1 1 0 1 1-2 0 1 1 0 0 1 2 0',
  build: 'M6 3l14 9-14 9z',
  history: 'M3 7a10 10 0 1 1-1 7 M3 2v5h5 M12 6v6l4 2',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  edit: 'M3 21l1-6L17 2l5 5L9 20z M14 5l5 5',
  zoomIn: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0 M10 6v8 M6 10h8',
  zoomOut: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0 M6 10h8',
  layout: 'M3 3h18v18H3z M3 9h18 M9 9v12',
  copy: 'M8 8h13v13H8z M16 8V3H3v13h5',
  download: 'M12 3v14 M7 12l5 5 5-5 M3 17v5h18v-5',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  navigation: 'M3 5h18 M3 12h12 M3 19h18',
} as const;
export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 18,
  className = '',
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={`studio-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
