import type { SiteViewModel } from '@foliohaven/core';

export interface SiteFooterProps {
  readonly site: SiteViewModel;
}
export function SiteFooter({ site }: SiteFooterProps) {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div>
          <p>
            {site.siteName} · {site.author.name}
          </p>
          <p className="site-description">{site.siteDescription}</p>
        </div>
        <a href={site.rssUrl}>訂閱 RSS</a>
      </div>
    </footer>
  );
}
