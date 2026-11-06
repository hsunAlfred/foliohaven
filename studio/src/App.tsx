import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ArticleResource,
  Job,
  SiteConfig,
  Taxonomy,
  Workspace,
} from '@foliohaven/core';
import { StudioApi } from './api.js';
import { useCommand, usePolling, useResource } from './hooks.js';
import { Diagnostics, ErrorNotice, RetryNotice } from './components.js';
import { ArticlesView } from './ArticlesView.js';
import { ArticleEditor } from './ArticleEditor.js';
import { TaxonomyView } from './TaxonomyView.js';
import { SiteSettingsView } from './SiteSettingsView.js';
import { MediaView } from './MediaView.js';
import { JobsView } from './JobsView.js';
import { RecoveriesView } from './RecoveriesView.js';
import type { TaxonomyRetry } from './retry.js';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';

type Screen =
  | 'articles'
  | 'editor'
  | 'taxonomy'
  | 'settings'
  | 'media'
  | 'jobs'
  | 'recoveries';
const navigation: readonly [Screen, string][] = [
  ['articles', '文章'],
  ['taxonomy', '分類與 Tag'],
  ['settings', '全站設定'],
  ['media', '媒體庫'],
  ['jobs', '網站更新與工作'],
  ['recoveries', '衝突與復原'],
];
interface Route {
  screen: Screen;
  articleId: string | null;
  jobId: string | null;
}
function readRoute(): Route {
  const parts = window.location.hash.slice(2).split('/');
  const section = parts[0] ?? 'articles';
  let id: string | null = null;
  try {
    id = parts[1] ? decodeURIComponent(parts[1]) : null;
  } catch {
    /* Invalid route returns to collection. */
  }
  if (section === 'articles' && id)
    return {
      screen: 'editor',
      articleId: id === 'new' ? null : id,
      jobId: null,
    };
  const screen = navigation.some(([key]) => key === section)
    ? (section as Screen)
    : 'articles';
  return { screen, articleId: null, jobId: screen === 'jobs' ? id : null };
}
function routeHash(
  screen: Screen,
  articleId: string | null,
  jobId: string | null,
) {
  return screen === 'editor'
    ? `#/articles/${articleId ? encodeURIComponent(articleId) : 'new'}`
    : `#/${screen}${screen === 'jobs' && jobId ? `/${encodeURIComponent(jobId)}` : ''}`;
}
const navIcons: Partial<Record<Screen, IconName>> = {
  articles: 'article',
  taxonomy: 'tag',
  settings: 'settings',
  media: 'image',
  jobs: 'globe',
  recoveries: 'history',
};
const idle = () => false;
export function App() {
  const [api] = useState(() => new StudioApi());
  const [initialRoute] = useState(readRoute);
  const [screen, setScreen] = useState<Screen>(initialRoute.screen);
  const [articleId, setArticleId] = useState<string | null>(
    initialRoute.articleId,
  );
  const [jobId, setJobId] = useState<string | null>(initialRoute.jobId);
  const [menuOpen, setMenuOpen] = useState(false);
  const restoringNavigation = useRef(false);
  const acceptedHash = useRef(
    routeHash(initialRoute.screen, initialRoute.articleId, initialRoute.jobId),
  );
  const [dirty, setDirty] = useState(false);
  const [navigationBlocked, setNavigationBlocked] = useState(false);
  const [navigationNotice, setNavigationNotice] = useState('');
  const [taxonomyRetry, setTaxonomyRetry] = useState<TaxonomyRetry | null>(
    null,
  );
  // A workspace revision hashes every source byte; explicit saves refresh it
  // immediately, while passive checks should leave the authoring queue free.
  const workspace = usePolling<Workspace>(
    api,
    '/api/v1/workspace',
    idle,
    30_000,
    dirty || navigationBlocked,
  );
  const taxonomy = useResource<Taxonomy>(api, '/api/v1/taxonomy');
  const site = useResource<SiteConfig>(api, '/api/v1/site-settings');
  const mode = useCommand(api);
  const [modePreparing, setModePreparing] = useState(false);
  const [modeError, setModeError] = useState<unknown>(null);
  const onDirty = useCallback((value: boolean) => setDirty(value), []);
  const changed = () => {
    workspace.reload();
    taxonomy.reload();
    site.reload();
  };
  const onBlocked = useCallback((value: boolean) => {
    setNavigationBlocked(value);
    if (!value) setNavigationNotice('');
  }, []);
  const navigate = (
    next: Screen,
    nextArticle: string | null = null,
    nextJob: string | null = null,
  ) => {
    if (navigationBlocked) {
      setNavigationNotice('操作尚未完成，請先確認結果，再離開目前頁面。');
      return false;
    }
    if (
      dirty &&
      !window.confirm('有尚未保存的編輯內容。確認離開並捨棄這些變更？')
    )
      return false;
    setDirty(false);
    setArticleId(nextArticle);
    setJobId(nextJob);
    setScreen(next);
    setMenuOpen(false);
    if (next === 'taxonomy') setTaxonomyRetry(null);
    acceptedHash.current = routeHash(next, nextArticle, nextJob);
    window.history.pushState(null, '', acceptedHash.current);
    window.scrollTo({ top: 0 });
    return true;
  };
  const openArticle = (id: string) => navigate('editor', id);
  const saved = (article: ArticleResource) => {
    setArticleId(article.id);
    acceptedHash.current = routeHash('editor', article.id, null);
    window.history.replaceState(null, '', acceptedHash.current);
    workspace.reload();
  };
  const openJob = (job: Job) => navigate('jobs', null, job.id);
  useEffect(() => {
    const routeChanged = () => {
      if (navigationBlocked) {
        setNavigationNotice('操作尚未完成，請先確認結果，再離開目前頁面。');
        window.history.pushState(null, '', acceptedHash.current);
        return;
      }
      const dialog = Array.from(
        document.querySelectorAll<HTMLDialogElement>('dialog[open]'),
      ).at(-1);
      if (dialog) {
        restoringNavigation.current = true;
        try {
          dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
        } finally {
          restoringNavigation.current = false;
        }
        window.history.pushState(null, '', acceptedHash.current);
        return;
      }
      if (
        dirty &&
        !window.confirm('有尚未保存的編輯內容。確認離開並捨棄這些變更？')
      ) {
        window.history.pushState(null, '', acceptedHash.current);
        return;
      }
      const route = readRoute();
      setDirty(false);
      setScreen(route.screen);
      setArticleId(route.articleId);
      setJobId(route.jobId);
      setMenuOpen(false);
      setTaxonomyRetry(null);
      acceptedHash.current = routeHash(
        route.screen,
        route.articleId,
        route.jobId,
      );
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', routeChanged);
    return () => window.removeEventListener('hashchange', routeChanged);
  }, [dirty, navigationBlocked]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        document
          .querySelector<HTMLButtonElement>('.mobile-menu-toggle')
          ?.focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);
  const writable =
    !workspace.error &&
    workspace.response?.data.editMode === 'studio' &&
    workspace.response.data.recoveryState === 'ready';
  const changeMode = async () => {
    if (modePreparing || mode.busy || navigationBlocked) return;
    const desiredMode =
      workspace.response?.data.editMode === 'studio' ? 'ide' : 'studio';
    setModePreparing(true);
    setModeError(null);
    try {
      // 全站 revision 會隨保存而改變，操作前取得當前表示版本，再以 If-Match 防止競爭。
      const current = await api.get<Workspace>('/api/v1/workspace');
      if (current.data.editMode === desiredMode) {
        changed();
        return;
      }
      if (!current.etag)
        throw new Error('工作區資料已變更，請重新檢查後再切換模式。');
      await mode.run<Workspace>(
        {
          label: '切換編輯模式',
          method: 'PUT',
          path: '/api/v1/workspace/edit-mode',
          body: { mode: desiredMode },
          etag: current.etag,
        },
        changed,
      );
    } catch (error) {
      setModeError(error);
      workspace.reload();
    } finally {
      setModePreparing(false);
    }
  };
  return (
    <div className={`app-shell${menuOpen ? ' menu-open' : ''}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        跳至主要內容
      </a>
      {menuOpen && (
        <button
          className="mobile-backdrop"
          aria-label="關閉導覽"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <header className="app-header" id="studio-navigation">
        <div className="brand">
          <h1>文章工作室</h1>
          <span>內容與媒體管理</span>
        </div>
        <nav aria-label="工作室功能">
          {navigation.map(([key, label]) => (
            <button
              key={key}
              aria-current={
                screen === key || (key === 'articles' && screen === 'editor')
                  ? 'page'
                  : undefined
              }
              onClick={() => {
                if (screen === key) {
                  setMenuOpen(false);
                  return;
                }
                navigate(key);
              }}
            >
              <Icon name={navIcons[key] ?? 'article'} className="nav-icon" />
              {label}
            </button>
          ))}
        </nav>
        <p className="sidebar-note">文章、圖片與網站設定。</p>
      </header>
      <div className="main-frame">
        <div className="topbar">
          <button
            className="mobile-menu-toggle"
            aria-label="開啟導覽"
            aria-controls="studio-navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Icon name="menu" />
          </button>
          <div className="breadcrumb">
            工作室 /{' '}
            <strong>
              {
                navigation.find(
                  ([key]) =>
                    key === (screen === 'editor' ? 'articles' : screen),
                )?.[1]
              }
            </strong>
          </div>
          <section className="workspace-bar" aria-label="工作區狀態">
            <span
              className={`workspace-mode${workspace.error ? ' is-error' : !writable ? ' is-readonly' : ''}`}
            >
              {workspace.error
                ? '連線異常 · 暫停寫入'
                : !workspace.response
                  ? '確認工作區中'
                  : workspace.response.data.editMode === 'ide'
                    ? 'IDE 模式・Studio 唯讀'
                    : 'Studio 模式'}
            </span>
            {dirty && <span className="badge dirty">未保存</span>}
            <details className="workspace-extra">
              <summary>工作區</summary>
              <div className="actions">
                <button
                  disabled={
                    !workspace.response ||
                    Boolean(workspace.error) ||
                    mode.busy ||
                    modePreparing ||
                    navigationBlocked
                  }
                  onClick={() => void changeMode()}
                >
                  <Icon name="edit" />
                  {workspace.response?.data.editMode === 'ide'
                    ? '切換 Studio 模式'
                    : '切換 IDE 模式'}
                </button>
                <button onClick={workspace.reload}>
                  <Icon name="refresh" />
                  重新檢查工作區
                </button>
                <span className="muted">
                  IDE 模式供外部編輯，Studio 保持唯讀。
                </span>
              </div>
            </details>
          </section>
        </div>
        <main id="main-content" tabIndex={-1}>
          {navigationNotice && (
            <p className="notice" role="status">
              {navigationNotice}
            </p>
          )}
          <ErrorNotice error={workspace.error} />
          <ErrorNotice error={modeError} />
          <RetryNotice api={api} command={mode} />
          {workspace.response?.data.recoveryState === 'recovery-required' && (
            <p className="notice error">
              有內容需要先還原或保留。請到「衝突與復原」選擇處理方式，完成後即可繼續編輯與更新網站。
            </p>
          )}
          {workspace.response?.data.diagnostics.length ? (
            <details>
              <summary>
                <Icon name="alert" size={16} />
                檢查內容問題
              </summary>
              <Diagnostics items={workspace.response.data.diagnostics} />
            </details>
          ) : null}
          {(screen === 'articles' || screen === 'editor') &&
          !taxonomy.response ? (
            <>
              <ErrorNotice error={taxonomy.error} />
              <p role="status">讀取文章所需分類設定中…</p>
              <button onClick={taxonomy.reload}>重新讀取分類</button>
            </>
          ) : null}
          {screen === 'articles' && taxonomy.response && (
            <ArticlesView
              api={api}
              taxonomy={taxonomy.response.data}
              writable={writable}
              onOpen={openArticle}
              onCreate={() => navigate('editor')}
            />
          )}
          {screen === 'editor' && taxonomy.response && (
            <ArticleEditor
              key={articleId ?? 'new'}
              api={api}
              id={articleId}
              taxonomy={taxonomy.response.data}
              site={site.response?.data ?? null}
              writable={writable}
              onDirty={onDirty}
              workspace={{
                value: workspace.response?.data ?? null,
                loading: workspace.loading,
                error: workspace.error,
                reload: workspace.reload,
              }}
              onBlocked={onBlocked}
              onSaved={saved}
              onTaxonomySaved={() => {
                taxonomy.reload();
                workspace.reload();
              }}
              onBack={() => navigate('articles')}
            />
          )}
          {screen === 'taxonomy' && (
            <TaxonomyView
              site={site.response?.data ?? null}
              onBlocked={onBlocked}
              key={taxonomyRetry?.retryOf ?? 'taxonomy'}
              api={api}
              writable={writable}
              onDirty={onDirty}
              onSaved={changed}
              onJob={openJob}
              retry={taxonomyRetry}
            />
          )}
          {screen === 'settings' && (
            <SiteSettingsView
              api={api}
              resource={site}
              onBlocked={onBlocked}
              writable={writable}
              onDirty={onDirty}
              onSaved={changed}
            />
          )}
          {screen === 'media' && (
            <MediaView
              api={api}
              writable={writable}
              onDirty={onDirty}
              onChanged={changed}
              onJob={openJob}
            />
          )}
          {screen === 'jobs' && (
            <JobsView
              onDirty={onDirty}
              onSelected={(selected) => {
                acceptedHash.current = routeHash('jobs', null, selected);
                if (!restoringNavigation.current)
                  window.history.replaceState(null, '', acceptedHash.current);
              }}
              key={jobId ?? 'all'}
              api={api}
              workspace={
                workspace.error || workspace.loading
                  ? null
                  : (workspace.response?.data ?? null)
              }
              initialId={jobId}
              onChanged={changed}
              onRetryTaxonomy={(input) => {
                if (navigate('taxonomy')) setTaxonomyRetry(input);
              }}
            />
          )}
          {screen === 'recoveries' && (
            <RecoveriesView api={api} onDirty={onDirty} onChanged={changed} />
          )}
        </main>
      </div>
    </div>
  );
}
