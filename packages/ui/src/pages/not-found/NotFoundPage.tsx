import type { SiteViewModel } from '@foliohaven/core';

export interface NotFoundPageProps {
  readonly site: SiteViewModel;
}
export function NotFoundPage({ site }: NotFoundPageProps) {
  return (
    <main id="ui-main" className="page-container not-found-page" tabIndex={-1}>
      <p className="eyebrow">404</p>
      <h1>找不到這個頁面</h1>
      <p>網址可能已變更，或這個頁面目前不存在。</p>
      <p>
        <a className="button-link" href="/">
          回到 {site.siteName} 首頁
        </a>
      </p>
      <p>
        <a href="/articles/">瀏覽所有文章</a>
      </p>
    </main>
  );
}
