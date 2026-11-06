import type { SiteViewModel } from '@foliohaven/core';
import { Navigation } from './Navigation.js';

export interface SiteHeaderProps {
  readonly site: SiteViewModel;
  readonly currentPath?: string;
}
export function SiteHeader({ site, currentPath }: SiteHeaderProps) {
  return (
    <>
      <a className="skip-link" href="#ui-main">
        跳到主要內容
      </a>
      <header className="site-header">
        <div className="site-header-inner">
          <a
            className="site-brand"
            href="/"
            aria-label={`${site.siteName}首頁`}
          >
            {site.siteName}
          </a>
          <Navigation
            items={site.navigation}
            {...(currentPath === undefined ? {} : { currentPath })}
          />
        </div>
      </header>
    </>
  );
}
