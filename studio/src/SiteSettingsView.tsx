import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { SEO_PAGE_TYPES, SiteConfigSchema } from '@foliohaven/core';
import type {
  ArticleOption,
  ArticleOptions,
  Job,
  SeoPageType,
  SiteConfig,
} from '@foliohaven/core';
import type { ApiResponse, StudioApi } from './api.js';
import { ApiFailure, newKey, queryPath } from './api.js';
import { useCommand, useResource, useVersionedForm } from './hooks.js';
import {
  Conflict,
  ErrorNotice,
  Field,
  Pagination,
  RetryNotice,
  TextField,
} from './components.js';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { SeoSettingsPanel } from './SeoSettingsPanel.js';
import { SiteIconSettings } from './SiteIconSettings.js';
import { MediaJobProgress } from './MediaJobProgress.js';
import { firstMissingSiteIconSource } from './site-icon-preparation.js';
import { FormIssuesProvider } from './form-issues.js';
import { focusField, inputIssues } from './validation.js';
import { captureFocusOwner } from './focus.js';
import {
  siteSettingsFieldLabel,
  siteSettingsIssues,
} from './site-settings-validation.js';
import './taxonomy-settings.css';

type SettingsSection = 'general' | 'navigation' | 'seo' | 'home' | 'rss';
const settingsSections: readonly {
  id: SettingsSection;
  label: string;
  icon: IconName;
  fields: readonly string[];
}[] = [
  {
    id: 'general',
    label: '網站與作者',
    icon: 'user',
    fields: [
      'siteName',
      'siteDescription',
      'siteUrl',
      'favicon',
      'icons',
      'language',
      'timeZone',
      'author',
    ],
  },
  {
    id: 'navigation',
    label: '導覽',
    icon: 'navigation',
    fields: ['navigation'],
  },
  {
    id: 'seo',
    label: 'SEO 與社群分享',
    icon: 'globe',
    fields: ['defaultSEO', 'pageSEO', 'social', 'googleSiteVerification'],
  },
  {
    id: 'home',
    label: '首頁與列表',
    icon: 'layout',
    fields: ['pagination', 'home'],
  },
  { id: 'rss', label: 'RSS', icon: 'rss', fields: ['rss'] },
];

function sectionForField(path: readonly (string | number)[]) {
  return settingsSections.find((section) =>
    section.fields.some((field) => field === path[0]),
  )?.id;
}

function SettingsPanel({
  section,
  active,
  idPrefix,
  disabled,
  children,
}: {
  section: SettingsSection;
  active: SettingsSection;
  idPrefix: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const visible = active === section;
  const [opened, setOpened] = useState(visible);
  if (visible && !opened) setOpened(true);
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-${section}-panel`}
      aria-labelledby={`${idPrefix}-${section}-tab`}
      hidden={!visible}
      tabIndex={0}
      className="settings-section-panel"
    >
      <fieldset disabled={disabled} className="settings-panel">
        {(opened || visible) && children}
      </fieldset>
    </div>
  );
}

export function SiteSettingsView({
  api,
  resource,
  writable,
  onDirty,
  onBlocked,
  onSaved,
}: {
  api: StudioApi;
  resource: ReturnType<typeof useResource<SiteConfig>>;
  writable: boolean;
  onDirty: (value: boolean) => void;
  onBlocked?: (blocked: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <section className="site-settings-view">
      <div className="view-heading">
        <div>
          <h2>
            <Icon name="settings" /> 全站設定
          </h2>
          <p className="muted">
            管理網站資訊、導覽與分享預設。切換區塊保留修改，完成後一併保存。
          </p>
        </div>
      </div>
      <ErrorNotice error={resource.error} />
      {Boolean(resource.error) && (
        <button onClick={resource.reload}>重新讀取資料</button>
      )}
      {resource.response ? (
        <SettingsForm
          api={api}
          initial={resource.response}
          writable={writable}
          onDirty={onDirty}
          {...(onBlocked ? { onBlocked } : {})}
          onSaved={onSaved}
        />
      ) : (
        <p role="status">讀取全站設定中…</p>
      )}
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min = 1,
  max = 10000,
  field,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  field: string;
}) {
  return (
    <div className="settings-number-field">
      <Field label={label}>
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          value={Number.isNaN(value) ? '' : value}
          data-field={field}
          onChange={(event) =>
            onChange(
              event.target.value === ''
                ? Number.NaN
                : Number(event.target.value),
            )
          }
        />
      </Field>
    </div>
  );
}

function FeaturedArticleRow({
  article,
  loading,
  error,
  onReload,
  id,
  index,
  total,
  onMove,
  onRemove,
}: {
  article: ArticleOption | undefined;
  loading: boolean;
  error: unknown;
  onReload: () => void;
  id: string;
  index: number;
  total: number;
  onMove: (offset: number) => void;
  onRemove: () => void;
}) {
  const title = article?.title ?? (loading ? '讀取文章中…' : '無法讀取的文章');
  return (
    <li
      className="featured-article-row"
      data-field={`home.featuredArticleIds.${index}`}
      tabIndex={-1}
    >
      <span className="featured-article-order" aria-hidden="true">
        {String(index + 1).padStart(2, '0')}
      </span>
      <div className="featured-article-name">
        <strong>{title}</strong>
        {loading && !article && <small>讀取文章名稱中…</small>}
        {!loading && !article && (
          <>
            <small role="alert">
              {error
                ? '無法讀取這篇文章，原選取已保留。'
                : `找不到文章 ${id}，原選取已保留。`}
            </small>
            <button className="text-button" onClick={onReload}>
              重新讀取文章名稱
            </button>
          </>
        )}
        {article?.status === 'draft' && (
          <small role="alert">此文章目前是草稿，請先發布或移出精選。</small>
        )}
      </div>
      <div className="featured-article-actions">
        <button
          className="text-button"
          aria-label={`將精選 ${title} 往上移`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <Icon name="arrowRight" className="move-up-icon" />
        </button>
        <button
          className="text-button"
          aria-label={`將精選 ${title} 往下移`}
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          <Icon name="arrowRight" className="move-down-icon" />
        </button>
        <button
          className="text-button"
          aria-label={`移除精選 ${title}`}
          onClick={onRemove}
        >
          <Icon name="trash" /> 移除
        </button>
      </div>
    </li>
  );
}

function FeaturedArticles({
  api,
  value,
  onChange,
}: {
  api: StudioApi;
  value: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [candidate, setCandidate] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [lastArticles, setLastArticles] = useState<ArticleOptions | null>(null);
  // Reordering changes presentation, not which article metadata is needed.
  const selectedKey = [...new Set(value)].sort().join(',');
  const resource = useResource<ArticleOptions>(
    api,
    queryPath('article-options', {
      selected: selectedKey,
      status: 'published',
      q: query,
      page,
      pageSize: 20,
      sort: 'published-desc',
    }),
  );
  const items = resource.response?.data.items ?? [];
  if (resource.response && resource.response.data !== lastArticles)
    setLastArticles(resource.response.data);
  // Keep selected titles visible while a different search/page is loading.
  const articles = resource.response?.data ?? lastArticles;
  const articleById = new Map(
    [...(articles?.items ?? []), ...(articles?.selected ?? [])].map(
      (article) => [article.id, article],
    ),
  );
  const move = (index: number, offset: number) => {
    const next = [...value];
    const other = index + offset;
    const current = next[index];
    const target = next[other];
    if (current === undefined || target === undefined) return;
    next[index] = target;
    next[other] = current;
    onChange(next);
  };
  return (
    <div
      className="featured-articles"
      data-field="home.featuredArticleIds"
      tabIndex={-1}
    >
      <div className="settings-subheading">
        <h4>首頁精選文章</h4>
        <p>依下列順序顯示，只能加入已發布文章，最多 20 篇。</p>
      </div>
      {value.length > 0 ? (
        <ol className="featured-article-list">
          {value.map((id, index) => (
            <FeaturedArticleRow
              key={id || `empty-${index}`}
              article={articleById.get(id)}
              loading={resource.loading}
              error={resource.error}
              onReload={resource.reload}
              id={id}
              index={index}
              total={value.length}
              onMove={(offset) => move(index, offset)}
              onRemove={() => onChange(value.filter((_, at) => at !== index))}
            />
          ))}
        </ol>
      ) : (
        <p className="field-note">尚未設定精選文章。</p>
      )}
      <form
        className="featured-article-search"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search);
          setPage(1);
        }}
      >
        <TextField
          label="搜尋已發布文章"
          value={search}
          width="medium"
          onChange={(next) => setSearch(next ?? '')}
        />
        <button type="submit">搜尋</button>
      </form>
      <ErrorNotice error={resource.error} />
      {Boolean(resource.error) && (
        <button onClick={resource.reload}>重新讀取文章選單</button>
      )}
      <div className="featured-article-picker">
        <Field label="選擇精選文章" hint="選擇要顯示在首頁的已發布文章。">
          <select
            value={candidate?.id ?? ''}
            disabled={resource.loading || Boolean(resource.error)}
            data-field={`home.featuredArticleIds.${value.length}`}
            onChange={(event) => {
              const article = items.find(
                (item) => item.id === event.target.value,
              );
              setCandidate(
                article ? { id: article.id, title: article.title } : null,
              );
            }}
          >
            <option value="">
              {resource.loading
                ? '讀取文章中…'
                : items.length === 0
                  ? '沒有符合條件的已發布文章'
                  : '請選擇文章'}
            </option>
            {candidate && !items.some((item) => item.id === candidate.id) && (
              <option value={candidate.id}>{candidate.title}</option>
            )}
            {items.map((item) => (
              <option
                key={item.id}
                value={item.id}
                disabled={value.includes(item.id)}
              >
                {item.title}
                {value.includes(item.id) ? '（已加入）' : ''}
              </option>
            ))}
          </select>
        </Field>
        <button
          disabled={
            !candidate ||
            value.includes(candidate.id) ||
            value.length >= 20 ||
            resource.loading ||
            Boolean(resource.error)
          }
          onClick={() => {
            if (candidate) {
              onChange([...value, candidate.id]);
              setCandidate(null);
            }
          }}
        >
          <Icon name="plus" /> 加入精選
        </button>
      </div>
      {resource.response && (
        <Pagination
          page={page}
          pageSize={resource.response.data.pageSize}
          total={resource.response.data.total}
          onPage={setPage}
        />
      )}
    </div>
  );
}

function SettingsForm({
  api,
  initial,
  writable,
  onDirty,
  onBlocked,
  onSaved,
}: {
  api: StudioApi;
  initial: ApiResponse<SiteConfig>;
  writable: boolean;
  onDirty: (value: boolean) => void;
  onBlocked?: (blocked: boolean) => void;
  onSaved: () => void;
}) {
  const form = useVersionedForm(api, '/api/v1/site-settings', initial, onDirty);
  const iconCommand = useCommand(api);
  const [preparingIcons, setPreparingIcons] = useState(false);
  const [iconJobId, setIconJobId] = useState<string | null>(null);
  const [iconJobBlocked, setIconJobBlocked] = useState(false);
  const [iconPreparationError, setIconPreparationError] =
    useState<unknown>(null);
  const iconSave = useRef<SiteConfig | null>(null);
  const attemptedIconSources = useRef(new Set<string>());
  const iconPreparing = useRef(false);
  const iconRead = useRef<AbortController | null>(null);
  const value = form.value;
  const change = form.change;
  const sectionId = useId();
  const [activeSection, setActiveSection] =
    useState<SettingsSection>('general');
  const [selectedSeoType, setSelectedSeoType] = useState<SeoPageType>('home');
  const [submittedValue, setSubmittedValue] = useState<SiteConfig | null>(null);
  const parsed = SiteConfigSchema.safeParse(value);
  const localIssues = parsed.success ? [] : siteSettingsIssues(parsed.error);
  const fieldApiError =
    form.command.error instanceof ApiFailure &&
    form.command.error.status === 422 &&
    inputIssues(form.command.error).length > 0;
  const serverIssues =
    fieldApiError && submittedValue === value
      ? siteSettingsIssues(form.command.error)
      : [];
  const issues = [...localIssues, ...serverIssues].filter(
    (issue, index, all) =>
      all.findIndex(
        (other) => other.path.join('.') === issue.path.join('.'),
      ) === index,
  );
  const blocked =
    form.command.busy ||
    Boolean(form.command.pending) ||
    preparingIcons ||
    iconCommand.busy ||
    Boolean(iconCommand.pending) ||
    iconJobBlocked;
  const disabled = !writable || blocked;
  const dirty = JSON.stringify(value) !== JSON.stringify(form.base.data);
  const stopIconPreparation = () => {
    iconPreparing.current = false;
    setPreparingIcons(false);
  };
  const prepareAndSaveIcons = async () => {
    const snapshot = iconSave.current;
    if (!snapshot) return;
    const controller = new AbortController();
    iconRead.current?.abort();
    iconRead.current = controller;
    let missing: Awaited<ReturnType<typeof firstMissingSiteIconSource>>;
    try {
      missing = await firstMissingSiteIconSource(
        api,
        snapshot,
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted && iconSave.current === snapshot) {
        setIconPreparationError(error);
        stopIconPreparation();
      }
      return;
    }
    if (iconSave.current !== snapshot || controller.signal.aborted) return;
    if (missing) {
      if (attemptedIconSources.current.has(missing.sourceId)) {
        setIconPreparationError(
          new ApiFailure(
            422,
            'SITE_ICONS_INCOMPLETE',
            '網站圖示處理完成後仍缺少必要尺寸，設定尚未保存。請檢查媒體處理結果後重試。',
          ),
        );
        stopIconPreparation();
        return;
      }
      attemptedIconSources.current.add(missing.sourceId);
      try {
        await iconCommand.run<Job>(
          {
            label: '準備完整網站圖示',
            method: 'POST',
            path: '/api/v1/media-jobs',
            body: { sourceId: missing.sourceId, preset: 'site-icons' },
            idempotencyKey: newKey(),
          },
          (response) => {
            if (iconSave.current !== snapshot) return;
            iconPreparing.current = true;
            setPreparingIcons(true);
            setIconJobId(response.data.id);
          },
        );
      } catch {
        // RetryNotice retains the exact request and resumes the same save snapshot.
        if (iconSave.current === snapshot) stopIconPreparation();
      }
      return;
    }
    await form.save(() => snapshot, onSaved);
    if (iconSave.current === snapshot) {
      iconSave.current = null;
      stopIconPreparation();
    }
  };
  const finishIconJob = async (job: Job) => {
    if (job.status === 'succeeded') await prepareAndSaveIcons();
    else stopIconPreparation();
  };
  useEffect(
    () => () => {
      iconSave.current = null;
      iconRead.current?.abort();
    },
    [],
  );
  const revealSection = (path: readonly (string | number)[]) => {
    const section = sectionForField(path);
    if (section) setActiveSection(section);
    if (
      path[0] === 'pageSEO' &&
      SEO_PAGE_TYPES.some((type) => type === path[1])
    )
      setSelectedSeoType(path[1] as SeoPageType);
  };
  const revealAndFocus = (path: readonly (string | number)[]) => {
    revealSection(path);
    requestAnimationFrame(() => focusField(path));
  };
  const navigateSections = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = settingsSections.findIndex(
      (section) => section.id === activeSection,
    );
    let nextIndex: number;
    if (event.key === 'ArrowRight')
      nextIndex = (index + 1) % settingsSections.length;
    else if (event.key === 'ArrowLeft')
      nextIndex =
        (index - 1 + settingsSections.length) % settingsSections.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = settingsSections.length - 1;
    else return;
    const next = settingsSections[nextIndex];
    if (!next) return;
    event.preventDefault();
    const ownsFocus = captureFocusOwner(event.currentTarget.ownerDocument);
    setActiveSection(next.id);
    requestAnimationFrame(() => {
      if (ownsFocus())
        document.getElementById(`${sectionId}-${next.id}-tab`)?.focus();
    });
  };
  useEffect(() => {
    onDirty(dirty || blocked);
    onBlocked?.(blocked);
  }, [blocked, dirty, onBlocked, onDirty]);
  useEffect(
    () => () => {
      onDirty(false);
      onBlocked?.(false);
    },
    [onBlocked, onDirty],
  );
  return (
    <FormIssuesProvider issues={issues}>
      {issues.length > 0 && (
        <section
          className="notice error settings-validation"
          role="region"
          aria-label={`設定有${issues.length}項需要修正`}
        >
          <h3 aria-live="polite">設定有{issues.length}項需要修正</h3>
          <p>內容尚未保存。請點選以下項目，修正後再保存。</p>
          <ul>
            {issues.map((issue) => (
              <li key={issue.path.join('.')}>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => revealAndFocus(issue.path)}
                >
                  {siteSettingsFieldLabel(issue.path)}：{issue.message}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ErrorNotice
        error={submittedValue === value ? form.validation : null}
        onBeforeFocus={revealSection}
      />
      <RetryNotice
        api={api}
        command={
          fieldApiError ? { ...form.command, error: null } : form.command
        }
        onBeforeFocus={revealSection}
      />
      <ErrorNotice error={iconPreparationError} onBeforeFocus={revealSection} />
      <RetryNotice
        api={api}
        command={iconCommand}
        onBeforeFocus={revealSection}
      />
      {iconJobId && (
        <MediaJobProgress
          key={iconJobId}
          api={api}
          id={iconJobId}
          onCompleted={finishIconJob}
          onBlocked={setIconJobBlocked}
        />
      )}
      {preparingIcons && (
        <p role="status">正在準備完整網站圖示，完成後自動保存設定…</p>
      )}
      {form.notice && (
        <p role="status">設定已保存，更新網站後會套用到公開頁面。</p>
      )}
      {form.conflict && (
        <Conflict
          base={form.base.data}
          local={value}
          current={form.conflict.data}
          onReload={form.adopt}
          onKeepLocal={form.rebase}
        />
      )}
      <div
        className="section-tabs settings-section-tabs"
        role="tablist"
        aria-label="全站設定區塊"
      >
        {settingsSections.map((section) => {
          const count = issues.filter(
            (issue) => sectionForField(issue.path) === section.id,
          ).length;
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              id={`${sectionId}-${section.id}-tab`}
              aria-label={section.label}
              aria-controls={`${sectionId}-${section.id}-panel`}
              aria-selected={activeSection === section.id}
              aria-describedby={
                count ? `${sectionId}-${section.id}-errors` : undefined
              }
              tabIndex={activeSection === section.id ? 0 : -1}
              onClick={() => setActiveSection(section.id)}
              onKeyDown={navigateSections}
            >
              <Icon name={section.icon} />
              {section.label}
              {count > 0 && (
                <span
                  className="settings-tab-error"
                  id={`${sectionId}-${section.id}-errors`}
                  aria-label={`${count}項需要修正`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="settings-section-select">
        <Field label="設定區塊">
          <select
            value={activeSection}
            onChange={(event) => {
              const section = settingsSections.find(
                (item) => item.id === event.target.value,
              );
              if (section) setActiveSection(section.id);
            }}
          >
            {settingsSections.map((section) => {
              const count = issues.filter(
                (issue) => sectionForField(issue.path) === section.id,
              ).length;
              return (
                <option key={section.id} value={section.id}>
                  {section.label}
                  {count ? `（${count}項需要修正）` : ''}
                </option>
              );
            })}
          </select>
        </Field>
      </div>
      <div className="settings-sections" aria-label="網站設定區塊">
        <SettingsPanel
          section="general"
          active={activeSection}
          idPrefix={sectionId}
          disabled={disabled}
        >
          <legend className="sr-only">網站與作者</legend>
          <header className="settings-panel-heading">
            <Icon name="user" size={22} />
            <h3>網站與作者</h3>
          </header>
          <p className="settings-section-description">
            網站名稱、簡介與主要作者資訊。
          </p>
          <div className="settings-field-grid">
            <TextField
              label="網站名稱"
              field="siteName"
              value={value.siteName}
              maxLength={120}
              width="medium"
              onChange={(next) => change({ ...value, siteName: next ?? '' })}
            />
            <TextField
              label="作者名稱"
              field="author.name"
              value={value.author.name}
              maxLength={120}
              width="medium"
              onChange={(next) =>
                change({
                  ...value,
                  author: { ...value.author, name: next ?? '' },
                })
              }
            />
          </div>
          <TextField
            label="網站描述"
            field="siteDescription"
            value={value.siteDescription}
            maxLength={300}
            multiline
            rows={3}
            width="wide"
            onChange={(next) =>
              change({ ...value, siteDescription: next ?? '' })
            }
          />
          <SiteIconSettings
            api={api}
            favicon={value.favicon}
            value={value.icons}
            disabled={disabled}
            onFaviconChange={(favicon) => change({ ...value, favicon })}
            onChange={(icons) => change({ ...value, icons })}
          />
          <div className="settings-field-grid">
            <TextField
              label="網站網址"
              field="siteUrl"
              value={value.siteUrl}
              width="medium"
              onChange={(next) => change({ ...value, siteUrl: next ?? '' })}
            />
            <TextField
              label="作者網址"
              field="author.url"
              value={value.author.url}
              nullable
              width="medium"
              onChange={(next) =>
                change({ ...value, author: { ...value.author, url: next } })
              }
            />
            <TextField
              label="語言"
              field="language"
              value={value.language}
              width="short"
              onChange={(next) => change({ ...value, language: next ?? '' })}
            />
            <TextField
              label="顯示時區"
              field="timeZone"
              value={value.timeZone}
              width="medium"
              onChange={(next) => change({ ...value, timeZone: next ?? '' })}
            />
          </div>
        </SettingsPanel>
        <SettingsPanel
          section="navigation"
          active={activeSection}
          idPrefix={sectionId}
          disabled={disabled}
        >
          <legend className="sr-only">導覽</legend>
          <header className="settings-panel-heading">
            <Icon name="navigation" size={22} />
            <h3>導覽</h3>
          </header>
          <p className="settings-section-description">
            網站主要導覽，依排列順序顯示。站內連結使用 / 開頭的路徑。
          </p>
          <div className="settings-navigation-list">
            {value.navigation.map((item, index) => (
              <div key={index} className="settings-navigation-row">
                <span className="settings-row-order" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <TextField
                  label={`導覽 ${index + 1} 名稱`}
                  field={`navigation.${index}.label`}
                  value={item.label}
                  maxLength={80}
                  width="short"
                  onChange={(label) =>
                    change({
                      ...value,
                      navigation: value.navigation.map((row, at) =>
                        at === index ? { ...row, label: label ?? '' } : row,
                      ),
                    })
                  }
                />
                <TextField
                  label={`導覽 ${index + 1} 連結`}
                  field={`navigation.${index}.href`}
                  value={item.href}
                  width="medium"
                  onChange={(href) =>
                    change({
                      ...value,
                      navigation: value.navigation.map((row, at) =>
                        at === index ? { ...row, href: href ?? '' } : row,
                      ),
                    })
                  }
                />
                <div className="settings-row-actions">
                  <button
                    className="text-button"
                    aria-label={`將導覽 ${index + 1} 往上移`}
                    disabled={index === 0}
                    onClick={() => {
                      const next = [...value.navigation];
                      const previous = next[index - 1];
                      if (!previous) return;
                      next[index - 1] = item;
                      next[index] = previous;
                      change({ ...value, navigation: next });
                    }}
                  >
                    <Icon name="arrowRight" className="move-up-icon" />
                  </button>
                  <button
                    className="text-button"
                    aria-label={`將導覽 ${index + 1} 往下移`}
                    disabled={index === value.navigation.length - 1}
                    onClick={() => {
                      const next = [...value.navigation];
                      const following = next[index + 1];
                      if (!following) return;
                      next[index + 1] = item;
                      next[index] = following;
                      change({ ...value, navigation: next });
                    }}
                  >
                    <Icon name="arrowRight" className="move-down-icon" />
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      change({
                        ...value,
                        navigation: value.navigation.filter(
                          (_, at) => at !== index,
                        ),
                      })
                    }
                  >
                    移除導覽 {index + 1}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {value.navigation.length === 0 && (
            <p className="field-note">尚未新增導覽連結。</p>
          )}
          <button
            disabled={value.navigation.length >= 20}
            onClick={() =>
              change({
                ...value,
                navigation: [...value.navigation, { label: '', href: '/' }],
              })
            }
          >
            <Icon name="plus" /> 新增導覽
          </button>
        </SettingsPanel>
        <SettingsPanel
          section="seo"
          active={activeSection}
          idPrefix={sectionId}
          disabled={disabled}
        >
          <legend className="sr-only">SEO 與社群分享</legend>
          <header className="settings-panel-heading">
            <Icon name="globe" size={22} />
            <h3>SEO 與社群分享</h3>
          </header>
          <SeoSettingsPanel
            api={api}
            value={value}
            onChange={change}
            pageType={selectedSeoType}
            onPageTypeChange={setSelectedSeoType}
            disabled={disabled}
          />
        </SettingsPanel>
        <SettingsPanel
          section="home"
          active={activeSection}
          idPrefix={sectionId}
          disabled={disabled}
        >
          <legend className="sr-only">首頁與列表</legend>
          <header className="settings-panel-heading">
            <Icon name="layout" size={22} />
            <h3>首頁與列表</h3>
          </header>
          <p className="settings-section-description">
            各列表的每頁文章數，以及首頁最新文章與精選順序。
          </p>
          <div className="settings-number-grid">
            <NumberField
              label="分類每頁篇數"
              field="pagination.category"
              value={value.pagination.category}
              max={100}
              onChange={(next) =>
                change({
                  ...value,
                  pagination: { ...value.pagination, category: next },
                })
              }
            />
            <NumberField
              label="Tag 每頁篇數"
              field="pagination.tag"
              value={value.pagination.tag}
              max={100}
              onChange={(next) =>
                change({
                  ...value,
                  pagination: { ...value.pagination, tag: next },
                })
              }
            />
            <NumberField
              label="文章總覽每頁篇數"
              field="pagination.articles"
              value={value.pagination.articles}
              max={100}
              onChange={(next) =>
                change({
                  ...value,
                  pagination: { ...value.pagination, articles: next },
                })
              }
            />
            <NumberField
              label="首頁最新文章篇數"
              field="home.latestCount"
              value={value.home.latestCount}
              max={20}
              onChange={(next) =>
                change({ ...value, home: { ...value.home, latestCount: next } })
              }
            />
          </div>
          <TextField
            label="精選文章小字"
            field="home.featuredCaption"
            value={value.home.featuredCaption}
            maxLength={120}
            width="wide"
            hint="顯示在首頁「精選文章」標題旁；留空即可隱藏。"
            onChange={(featuredCaption) =>
              change({
                ...value,
                home: { ...value.home, featuredCaption: featuredCaption ?? '' },
              })
            }
          />
          <FeaturedArticles
            api={api}
            value={value.home.featuredArticleIds}
            onChange={(ids) =>
              change({
                ...value,
                home: { ...value.home, featuredArticleIds: ids },
              })
            }
          />
        </SettingsPanel>
        <SettingsPanel
          section="rss"
          active={activeSection}
          idPrefix={sectionId}
          disabled={disabled}
        >
          <legend className="sr-only">RSS</legend>
          <header className="settings-panel-heading">
            <Icon name="rss" size={22} />
            <h3>RSS</h3>
          </header>
          <p className="settings-section-description">
            提供給訂閱閱讀器的名稱、說明與文章數。
          </p>
          <TextField
            label="RSS 標題"
            field="rss.title"
            value={value.rss.title}
            maxLength={120}
            width="medium"
            onChange={(next) =>
              change({ ...value, rss: { ...value.rss, title: next ?? '' } })
            }
          />
          <TextField
            label="RSS 描述"
            field="rss.description"
            value={value.rss.description}
            maxLength={300}
            multiline
            rows={3}
            width="wide"
            onChange={(next) =>
              change({
                ...value,
                rss: { ...value.rss, description: next ?? '' },
              })
            }
          />
          <NumberField
            label="RSS 最多篇數"
            field="rss.maxItems"
            value={value.rss.maxItems}
            onChange={(next) =>
              change({ ...value, rss: { ...value.rss, maxItems: next } })
            }
          />
        </SettingsPanel>
      </div>
      <div className="settings-save-bar">
        <span className="muted">
          {dirty ? '有尚未保存的變更' : '設定與已保存版本一致'}
        </span>
        <button
          className="primary"
          disabled={disabled}
          onClick={() => {
            setSubmittedValue(value);
            if (!parsed.success) {
              const first = localIssues[0];
              if (first) revealAndFocus(first.path);
              return;
            }
            if (iconPreparing.current || !iconCommand.clear()) return;
            setIconPreparationError(null);
            setIconJobId(null);
            if (!parsed.data.icons.enabled) {
              void form.save((input) => SiteConfigSchema.parse(input), onSaved);
              return;
            }
            iconSave.current = parsed.data;
            attemptedIconSources.current.clear();
            iconPreparing.current = true;
            setPreparingIcons(true);
            void prepareAndSaveIcons();
          }}
        >
          <Icon name="save" />{' '}
          {form.command.busy
            ? '保存中…'
            : preparingIcons
              ? '準備網站圖示…'
              : '保存全站設定'}
        </button>
      </div>
    </FormIssuesProvider>
  );
}
