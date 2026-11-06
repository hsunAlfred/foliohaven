import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  absoluteSiteUrl,
  categoryUrl,
  tagUrl,
  CategoryPathSchema,
  SlugSchema,
  TaxonomySchema,
} from '@foliohaven/core';
import type {
  Category,
  Job,
  SiteConfig,
  Tag,
  Taxonomy,
  TaxonomyMigrationPlan,
  Workspace,
} from '@foliohaven/core';
import type { ApiResponse, StudioApi } from './api.js';
import type { TaxonomyRetry } from './retry.js';
import { newKey } from './api.js';
import { useCommand, useResource, useVersionedForm } from './hooks.js';
import {
  Conflict,
  ErrorNotice,
  Field,
  RetryNotice,
  SeoFields,
  TextField,
} from './components.js';
import { Dialog } from './Dialog.js';
import { Icon } from './Icon.js';
import { getSeoFieldDefaults, seoSourceLabel } from './seo-defaults.js';
import './taxonomy-settings.css';

function taxonomyPageUrl(
  kind: TaxonomyKind,
  value: string,
  site: SiteConfig | null,
) {
  const valid =
    kind === 'category'
      ? CategoryPathSchema.safeParse(value).success
      : SlugSchema.safeParse(value).success;
  if (!valid) return null;
  const path = kind === 'category' ? categoryUrl(value) : tagUrl(value);
  return site ? absoluteSiteUrl(site, path) : path;
}
const emptySeo = { title: null, description: null, index: null, ogImage: null };
type TaxonomyKind = 'category' | 'tag';
function taxonomyIndexLabel(
  site: SiteConfig | null,
  kind: TaxonomyKind,
  item: Category | Tag,
) {
  const resolved = getSeoFieldDefaults(site, {
    kind: 'website',
    pageType: kind,
    title: item.name,
    description: item.description,
    seo: item.seo,
  });
  return resolved
    ? `設定：${seoSourceLabel(resolved.sources.index, 'index', kind, resolved.sourceLayers.index)} · ${resolved.index ? '允許索引' : '不允許索引'}`
    : '目前無法確認預設值';
}
interface TaxonomyEditor {
  readonly kind: TaxonomyKind;
  readonly index: number;
  readonly isNew: boolean;
  readonly baseline: ApiResponse<Taxonomy>;
  readonly removed?: boolean;
}

export function TaxonomyView({
  api,
  writable,
  onDirty,
  onBlocked,
  onSaved,
  onJob,
  retry,
  site = null,
}: {
  api: StudioApi;
  writable: boolean;
  onDirty: (value: boolean) => void;
  onBlocked?: (blocked: boolean) => void;
  onSaved: () => void;
  onJob: (job: Job) => void;
  retry: TaxonomyRetry | null;
  site?: SiteConfig | null;
}) {
  const resource = useResource<Taxonomy>(api, '/api/v1/taxonomy');
  return (
    <section className="taxonomy-view">
      <div className="view-heading">
        <div>
          <h2>
            <Icon name="folder" /> 分類與 Tag
          </h2>
          <p className="muted">整理內容的歸屬與主題，點選一筆即可編輯。</p>
        </div>
      </div>
      <ErrorNotice error={resource.error} />
      {Boolean(resource.error) && (
        <button onClick={resource.reload}>重新讀取資料</button>
      )}
      {resource.response ? (
        <TaxonomyForm
          api={api}
          initial={resource.response}
          writable={writable}
          onDirty={onDirty}
          {...(onBlocked ? { onBlocked } : {})}
          onSaved={onSaved}
          onJob={onJob}
          retry={retry}
          site={site}
        />
      ) : (
        <p role="status">讀取分類中…</p>
      )}
    </section>
  );
}

function TaxonomyForm({
  api,
  initial,
  writable,
  onDirty,
  onBlocked,
  onSaved,
  onJob,
  retry,
  site = null,
}: {
  api: StudioApi;
  initial: ApiResponse<Taxonomy>;
  writable: boolean;
  onDirty: (value: boolean) => void;
  onBlocked?: (blocked: boolean) => void;
  onSaved: () => void;
  onJob: (job: Job) => void;
  retry: TaxonomyRetry | null;
  site?: SiteConfig | null;
}) {
  const form = useVersionedForm(api, '/api/v1/taxonomy', initial, onDirty);
  const [tab, setTab] = useState<TaxonomyKind>(retry?.kind ?? 'category');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<TaxonomyEditor | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [kind, setKind] = useState<TaxonomyKind>(retry?.kind ?? 'category');
  const [from, setFrom] = useState(retry?.from ?? '');
  const [to, setTo] = useState(retry?.to ?? '');
  const [plan, setPlan] = useState<TaxonomyMigrationPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<unknown>(null);
  const migrationFocusRequested = useRef(false);
  const migration = useCommand(api);
  const dirty = JSON.stringify(form.value) !== JSON.stringify(form.base.data);
  const operationBlocked =
    form.command.busy ||
    Boolean(form.command.pending) ||
    migration.busy ||
    Boolean(migration.pending);
  useEffect(() => {
    onDirty(dirty || operationBlocked);
    onBlocked?.(operationBlocked);
  }, [dirty, onBlocked, onDirty, operationBlocked]);
  useEffect(
    () => () => {
      onDirty(false);
      onBlocked?.(false);
    },
    [onBlocked, onDirty],
  );
  const blocked = !writable || operationBlocked;
  // Adopting a 412 disk version replaces both references. Rebase retains the
  // local collection, so its open editor remains available for review.
  const activeEditor =
    editor && editor.baseline !== form.base && form.value === form.base.data
      ? null
      : editor;
  const category =
    activeEditor?.kind === 'category' && !activeEditor.removed
      ? form.value.categories[activeEditor.index]
      : undefined;
  const tag =
    activeEditor?.kind === 'tag' && !activeEditor.removed
      ? form.value.tags[activeEditor.index]
      : undefined;
  useEffect(() => {
    if (activeEditor || !migrationFocusRequested.current) return;
    migrationFocusRequested.current = false;
    document
      .getElementById('taxonomy-url-change')
      ?.scrollIntoView({ block: 'start' });
    document
      .querySelector<HTMLInputElement>('#taxonomy-url-change input')
      ?.focus();
  }, [activeEditor]);
  const changeCategory = (index: number, value: Category) =>
    form.change({
      ...form.value,
      categories: form.value.categories.map((item, at) =>
        at === index ? value : item,
      ),
    });
  const changeTag = (index: number, value: Tag) =>
    form.change({
      ...form.value,
      tags: form.value.tags.map((item, at) => (at === index ? value : item)),
    });
  const closeEditor = () => {
    if (form.command.busy || form.command.pending) return;
    if (form.conflict) {
      // Cancel a conflicted edit by adopting the authoritative disk version.
      // The hook asks for confirmation and keeps this dialog open if declined.
      form.adopt();
      return;
    }
    if (dirty && !window.confirm('放棄這筆尚未保存的變更？')) return;
    form.change(form.base.data);
    form.command.clear();
    setShowFeedback(false);
    setEditor(null);
  };
  const editUrl = (nextKind: TaxonomyKind, identifier: string) => {
    if (blocked || form.conflict) return;
    if (
      dirty &&
      !window.confirm('目前有尚未保存的內容。放棄這筆編輯並修改網址？')
    )
      return;
    form.change(form.base.data);
    form.command.clear();
    setShowFeedback(false);
    migrationFocusRequested.current = true;
    setEditor(null);
    setKind(nextKind);
    setFrom(identifier);
    setTo(identifier);
    setPlan(null);
    setPlanError(null);
  };
  const saved = () => {
    setEditor(null);
    setPlan(null);
    onSaved();
  };
  const openEditor = (index: number) => {
    setShowFeedback(false);
    setEditor({ kind: tab, index, isNew: false, baseline: form.base });
  };
  const switchTab = (next: TaxonomyKind) => {
    setTab(next);
    setSearch('');
  };
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'category'
        : event.key === 'End'
          ? 'tag'
          : tab === 'category'
            ? 'tag'
            : 'category';
    switchTab(next);
    document.getElementById(`taxonomy-${next}-tab`)?.focus();
  };
  const add = () => {
    if (blocked) return;
    setShowFeedback(false);
    if (tab === 'category') {
      const row: Category = {
        path: '',
        name: '',
        description: '',
        seo: emptySeo,
      };
      setEditor({
        kind: tab,
        index: form.value.categories.length,
        isNew: true,
        baseline: form.base,
      });
      form.change({
        ...form.value,
        categories: [...form.value.categories, row],
      });
    } else {
      const row: Tag = { slug: '', name: '', description: '', seo: emptySeo };
      setEditor({
        kind: tab,
        index: form.value.tags.length,
        isNew: true,
        baseline: form.base,
      });
      form.change({ ...form.value, tags: [...form.value.tags, row] });
    }
  };
  const remove = () => {
    if (!activeEditor || blocked) return;
    if (
      !window.confirm(
        activeEditor.kind === 'category'
          ? '移除此分類並保存？系統會檢查所有文章、子分類與導覽引用；仍被引用時將拒絕移除。'
          : '移除此 Tag 並保存？系統會檢查文章引用；仍被引用時將拒絕移除。',
      )
    )
      return;
    const next: Taxonomy =
      activeEditor.kind === 'category'
        ? {
            ...form.value,
            categories: form.value.categories.filter(
              (_, index) => index !== activeEditor.index,
            ),
          }
        : {
            ...form.value,
            tags: form.value.tags.filter(
              (_, index) => index !== activeEditor.index,
            ),
          };
    form.change(next);
    setEditor({ ...activeEditor, removed: true });
    setShowFeedback(true);
    // Parse the exact candidate, rather than the previous render's value.
    void form.save(() => TaxonomySchema.parse(next), saved);
  };
  const preview = async () => {
    setPlanning(true);
    setPlanError(null);
    setPlan(null);
    try {
      const workspace = await api.get<Workspace>('/api/v1/workspace');
      const result = await api.send<TaxonomyMigrationPlan>(
        'POST',
        '/api/v1/taxonomy-migrations',
        {
          kind,
          from,
          to,
          workspaceRevision: workspace.data.revision,
          confirmed: false,
        },
      );
      setPlan(result.data);
    } catch (error) {
      setPlanError(error);
    } finally {
      setPlanning(false);
    }
  };
  const submit = async () => {
    if (
      !plan ||
      !window.confirm(
        `確認將 ${taxonomyPageUrl(plan.kind, plan.from, site) ?? plan.from} 改為 ${taxonomyPageUrl(plan.kind, plan.to, site) ?? plan.to}？文章與導覽會同步更新，原網址不會自動轉址。`,
      )
    )
      return;
    try {
      await migration.run<Job>(
        {
          label: '變更分類／Tag網址',
          method: 'POST',
          path: '/api/v1/taxonomy-migrations',
          body: {
            kind: plan.kind,
            from: plan.from,
            to: plan.to,
            workspaceRevision: plan.workspaceRevision,
            confirmed: true,
            planId: plan.planId,
            ...(retry === null ? {} : { retryOf: retry.retryOf }),
          },
          idempotencyKey: newKey(),
        },
        (response) => {
          onDirty(false);
          onJob(response.data);
        },
      );
    } catch {
      /* Retain the plan and original idempotent request. */
    }
  };
  const feedback = (
    <>
      {showFeedback && <ErrorNotice error={form.validation} />}
      {showFeedback && <RetryNotice api={api} command={form.command} />}
      {form.conflict && (
        <Conflict
          base={form.base.data}
          local={form.value}
          current={form.conflict.data}
          onReload={form.adopt}
          onKeepLocal={form.rebase}
        />
      )}
    </>
  );
  const query = search.trim().toLocaleLowerCase();
  const rows =
    tab === 'category'
      ? form.value.categories.map((item, index) => ({
          item,
          index,
          identifier: item.path,
        }))
      : form.value.tags.map((item, index) => ({
          item,
          index,
          identifier: item.slug,
        }));
  const visibleRows = rows.filter(({ item, identifier }) =>
    `${item.name} ${identifier} ${item.description}`
      .toLocaleLowerCase()
      .includes(query),
  );
  return (
    <>
      {retry && (
        <p className="notice">
          請重新選擇要變更的分類或 Tag，再查看目前受影響的文章與網址。
        </p>
      )}
      {!activeEditor && feedback}
      {form.notice && <p role="status">分類與 Tag 已保存。</p>}
      <div className="taxonomy-toolbar">
        <div className="tabs" role="tablist" aria-label="內容分類種類">
          <button
            role="tab"
            id="taxonomy-category-tab"
            aria-controls="taxonomy-list"
            aria-selected={tab === 'category'}
            tabIndex={tab === 'category' ? 0 : -1}
            onClick={() => switchTab('category')}
            onKeyDown={navigateTabs}
          >
            分類 <span>{form.value.categories.length}</span>
          </button>
          <button
            role="tab"
            id="taxonomy-tag-tab"
            aria-controls="taxonomy-list"
            aria-selected={tab === 'tag'}
            tabIndex={tab === 'tag' ? 0 : -1}
            onClick={() => switchTab('tag')}
            onKeyDown={navigateTabs}
          >
            Tag <span>{form.value.tags.length}</span>
          </button>
        </div>
        <button className="primary" disabled={blocked} onClick={add}>
          <Icon name="plus" /> {tab === 'category' ? '新增分類' : '新增 Tag'}
        </button>
      </div>
      <div className="taxonomy-search">
        <TextField
          label={tab === 'category' ? '搜尋分類' : '搜尋 Tag'}
          value={search}
          onChange={(value) => setSearch(value ?? '')}
          width="medium"
        />
        <span className="muted">{visibleRows.length} 筆</span>
      </div>
      <div
        className="taxonomy-table-wrap"
        role="tabpanel"
        id="taxonomy-list"
        aria-labelledby={
          tab === 'category' ? 'taxonomy-category-tab' : 'taxonomy-tag-tab'
        }
      >
        {visibleRows.length ? (
          <table className="taxonomy-table">
            <thead>
              <tr>
                <th scope="col">名稱</th>
                <th scope="col">網址名稱</th>
                <th scope="col">描述</th>
                <th scope="col">Indexing</th>
                <th scope="col">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(({ item, index, identifier }) => (
                <tr key={identifier || `new-${index}`}>
                  <td data-label="名稱">
                    <button
                      className="text-button taxonomy-name"
                      disabled={blocked}
                      onClick={() => openEditor(index)}
                    >
                      {item.name || '未命名'}
                    </button>
                  </td>
                  <td data-label="網址名稱">
                    <code>{identifier || '—'}</code>
                  </td>
                  <td className="taxonomy-description" data-label="描述">
                    <span title={item.description}>
                      {item.description || '—'}
                    </span>
                  </td>
                  <td data-label="SEO">
                    <span className="taxonomy-seo">
                      {taxonomyIndexLabel(site, tab, item)}
                    </span>
                  </td>
                  <td>
                    <button
                      className="text-button"
                      aria-label={`編輯${tab === 'category' ? '分類' : ' Tag'} ${item.name || identifier}`}
                      disabled={blocked}
                      onClick={() => openEditor(index)}
                    >
                      <Icon name="edit" /> 編輯
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="taxonomy-empty">
            {query ? '沒有符合條件的項目。' : '尚無項目，請新增一筆。'}
          </p>
        )}
      </div>
      <Dialog
        open={activeEditor !== null}
        title={`${activeEditor?.isNew ? '新增' : '編輯'}${activeEditor?.kind === 'category' ? '分類' : ' Tag'}`}
        onClose={closeEditor}
        closeDisabled={form.command.busy || Boolean(form.command.pending)}
        className="taxonomy-editor"
        actions={
          <>
            {activeEditor && !activeEditor.isNew && !activeEditor.removed && (
              <button
                className="danger text-button"
                disabled={blocked}
                onClick={remove}
              >
                {activeEditor.kind === 'category' ? '移除此分類' : '移除此 Tag'}
              </button>
            )}
            <span className="dialog-action-spacer" />
            <button
              disabled={form.command.busy || Boolean(form.command.pending)}
              onClick={closeEditor}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={blocked}
              onClick={() => {
                setShowFeedback(true);
                void form.save((value) => TaxonomySchema.parse(value), saved);
              }}
            >
              <Icon name="save" />{' '}
              {form.command.busy
                ? '保存中…'
                : activeEditor?.removed
                  ? '再次嘗試移除'
                  : activeEditor?.kind === 'category'
                    ? '保存分類'
                    : '保存 Tag'}
            </button>
          </>
        }
      >
        {activeEditor && (
          <>
            {feedback}
            {activeEditor.removed ? (
              <p className="notice">
                移除尚未完成。請依錯誤訊息處理引用或版本差異，再重試；取消可還原這筆變更。
              </p>
            ) : (
              <fieldset disabled={blocked} className="taxonomy-editor-fields">
                <legend className="sr-only">
                  {activeEditor.kind === 'category' ? '分類設定' : 'Tag 設定'}
                </legend>
                {category && (
                  <>
                    <div className="settings-field-grid">
                      <TextField
                        label="分類名稱"
                        field={`categories.${activeEditor.index}.name`}
                        value={category.name}
                        maxLength={120}
                        width="medium"
                        onChange={(name) =>
                          changeCategory(activeEditor.index, {
                            ...category,
                            name: name ?? '',
                          })
                        }
                      />
                      <TextField
                        label="分類網址名稱"
                        field={`categories.${activeEditor.index}.path`}
                        value={category.path}
                        disabled={!activeEditor.isNew}
                        width="medium"
                        onChange={(path) =>
                          changeCategory(activeEditor.index, {
                            ...category,
                            path: path ?? '',
                          })
                        }
                      />
                    </div>
                    {!activeEditor.isNew && (
                      <p className="field-note">
                        目前網址：
                        <code>
                          {taxonomyPageUrl('category', category.path, site)}
                        </code>
                        <button
                          type="button"
                          className="text-button"
                          disabled={Boolean(form.conflict)}
                          onClick={() => editUrl('category', category.path)}
                        >
                          <Icon name="link" /> 修改網址
                        </button>
                      </p>
                    )}
                    <TextField
                      label="分類描述"
                      field={`categories.${activeEditor.index}.description`}
                      value={category.description}
                      maxLength={300}
                      multiline
                      rows={3}
                      width="full"
                      onChange={(description) =>
                        changeCategory(activeEditor.index, {
                          ...category,
                          description: description ?? '',
                        })
                      }
                    />
                    <p className="field-note">
                      以下顯示繼承與覆寫設定，尚未計入文章數。公開分類頁若沒有已發布文章，仍固定不允許索引。
                    </p>
                    <SeoFields
                      api={api}
                      prefix={`categories.${activeEditor.index}.seo`}
                      previewTitle="SEO 繼承與覆寫設定"
                      value={category.seo}
                      defaults={getSeoFieldDefaults(site, {
                        kind: 'website',
                        pageType: 'category',
                        title: category.name,
                        description: category.description,
                      })}
                      resolved={getSeoFieldDefaults(site, {
                        kind: 'website',
                        pageType: 'category',
                        title: category.name,
                        description: category.description,
                        seo: category.seo,
                      })}
                      onChange={(seo) =>
                        changeCategory(activeEditor.index, { ...category, seo })
                      }
                    />
                  </>
                )}
                {tag && (
                  <>
                    <div className="settings-field-grid">
                      <TextField
                        label="Tag 名稱"
                        field={`tags.${activeEditor.index}.name`}
                        value={tag.name}
                        maxLength={120}
                        width="medium"
                        onChange={(name) =>
                          changeTag(activeEditor.index, {
                            ...tag,
                            name: name ?? '',
                          })
                        }
                      />
                      <TextField
                        label="Tag 網址名稱"
                        field={`tags.${activeEditor.index}.slug`}
                        value={tag.slug}
                        disabled={!activeEditor.isNew}
                        width="medium"
                        onChange={(slug) =>
                          changeTag(activeEditor.index, {
                            ...tag,
                            slug: slug ?? '',
                          })
                        }
                      />
                    </div>
                    {!activeEditor.isNew && (
                      <p className="field-note">
                        目前網址：
                        <code>{taxonomyPageUrl('tag', tag.slug, site)}</code>
                        <button
                          type="button"
                          className="text-button"
                          disabled={Boolean(form.conflict)}
                          onClick={() => editUrl('tag', tag.slug)}
                        >
                          <Icon name="link" /> 修改網址
                        </button>
                      </p>
                    )}
                    <TextField
                      label="Tag 描述"
                      field={`tags.${activeEditor.index}.description`}
                      value={tag.description}
                      maxLength={300}
                      multiline
                      rows={3}
                      width="full"
                      onChange={(description) =>
                        changeTag(activeEditor.index, {
                          ...tag,
                          description: description ?? '',
                        })
                      }
                    />
                    <p className="field-note">
                      以下顯示繼承與覆寫設定，尚未計入文章數。公開 Tag
                      頁若沒有已發布文章，仍固定不允許索引。
                    </p>
                    <SeoFields
                      api={api}
                      prefix={`tags.${activeEditor.index}.seo`}
                      previewTitle="SEO 繼承與覆寫設定"
                      value={tag.seo}
                      defaults={getSeoFieldDefaults(site, {
                        kind: 'website',
                        pageType: 'tag',
                        title: tag.name,
                        description: tag.description,
                      })}
                      resolved={getSeoFieldDefaults(site, {
                        kind: 'website',
                        pageType: 'tag',
                        title: tag.name,
                        description: tag.description,
                        seo: tag.seo,
                      })}
                      onChange={(seo) =>
                        changeTag(activeEditor.index, { ...tag, seo })
                      }
                    />
                  </>
                )}
              </fieldset>
            )}
          </>
        )}
      </Dialog>
      <section
        className="taxonomy-migration settings-panel"
        id="taxonomy-url-change"
        aria-labelledby="taxonomy-url-title"
      >
        <div className="settings-section-heading">
          <h3 id="taxonomy-url-title">
            <Icon name="link" /> 修改分類或 Tag 網址
          </h3>
          <p>
            只想改顯示名稱，請直接編輯上方項目；只有要修改連結中的網址名稱時，才使用這裡。
          </p>
        </div>
        <ol className="url-change-steps" aria-label="網址變更步驟">
          <li>
            <span>1</span> 選擇項目
          </li>
          <li>
            <span>2</span> 填寫新網址
          </li>
          <li>
            <span>3</span> 查看影響並確認
          </li>
        </ol>
        <fieldset
          disabled={blocked || dirty || planning}
          className="taxonomy-migration-fields"
        >
          <legend className="sr-only">網址變更設定</legend>
          <Field label="項目類型">
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as TaxonomyKind);
                setFrom('');
                setTo('');
                setPlan(null);
              }}
            >
              <option value="category">分類</option>
              <option value="tag">Tag</option>
            </select>
          </Field>
          <Field label="要變更的項目">
            <select
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setTo(event.target.value);
                setPlan(null);
              }}
            >
              <option value="">請選擇分類或 Tag</option>
              {(kind === 'category'
                ? form.value.categories.map((item) => ({
                    id: item.path,
                    name: item.name,
                  }))
                : form.value.tags.map((item) => ({
                    id: item.slug,
                    name: item.name,
                  }))
              ).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.id}
                </option>
              ))}
            </select>
          </Field>
          <TextField
            label="新的網址名稱"
            value={to}
            width="medium"
            hint={
              kind === 'category'
                ? '例如 journal 或 notes/development，不需貼完整網址。'
                : '例如 tutorial，只填網址最後一段，不需貼完整網址。'
            }
            onChange={(value) => {
              setTo(value ?? '');
              setPlan(null);
            }}
          />
          <button
            disabled={!from || from === to || !taxonomyPageUrl(kind, to, site)}
            onClick={() => void preview()}
          >
            <Icon name="search" /> {planning ? '檢查中…' : '查看變更影響'}
          </button>
        </fieldset>
        {from && (
          <div className="url-change-preview" aria-label="新舊網址預覽">
            <div>
              <span>目前網址</span>
              <code>{taxonomyPageUrl(kind, from, site)}</code>
            </div>
            <Icon name="arrowRight" />
            <div>
              <span>變更後網址</span>
              <code>
                {taxonomyPageUrl(kind, to, site) ??
                  '填寫有效的網址名稱後，這裡會顯示完整連結。'}
              </code>
            </div>
          </div>
        )}
        <p className="url-change-explanation">
          <Icon name="info" />{' '}
          會同步更新受影響文章、子分類與網站導覽。原網址不會自動轉址，外部連結需自行更新。
        </p>
        {dirty && (
          <p className="field-note">請先保存或取消目前的編輯，再變更網址。</p>
        )}
        <ErrorNotice error={planError} />
        <RetryNotice api={api} command={migration} />
        {plan && (
          <section
            className="notice migration-plan"
            aria-labelledby="migration-confirm-title"
          >
            <h4 id="migration-confirm-title">確認網址變更</h4>
            <div className="url-change-preview">
              <div>
                <span>目前網址</span>
                <code>{taxonomyPageUrl(plan.kind, plan.from, site)}</code>
              </div>
              <Icon name="arrowRight" />
              <div>
                <span>變更後網址</span>
                <code>{taxonomyPageUrl(plan.kind, plan.to, site)}</code>
              </div>
            </div>
            <p>
              將更新文章 {plan.affectedArticleIds.length} 篇、分類{' '}
              {plan.affectedCategoryPaths.length} 筆、導覽連結{' '}
              {plan.navigationReferences.length} 筆。
            </p>
            {plan.changedUrls.length > 0 && (
              <details className="url-change-details" open>
                <summary>受影響的文章網址（{plan.changedUrls.length}）</summary>
                <ul>
                  {plan.changedUrls.map((item) => (
                    <li key={item.articleId}>
                      <code>{item.from}</code>
                      <Icon name="arrowRight" />
                      <code>{item.to}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p>
              確認後才會修改已保存的資料。完成後請更新網站，讓公開連結一併生效。
            </p>
            <details className="url-change-details">
              <summary>這次確認的有效時間</summary>
              <p>
                {new Intl.DateTimeFormat('zh-TW', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(plan.expiresAt))}{' '}
                前有效；修改資料或逾時後，請重新查看影響。
              </p>
            </details>
            <button
              className="primary"
              disabled={blocked || dirty}
              onClick={() => void submit()}
            >
              <Icon name="check" /> 確認變更網址
            </button>
          </section>
        )}
      </section>
    </>
  );
}
