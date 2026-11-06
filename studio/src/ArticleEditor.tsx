import { useCallback, useEffect, useRef, useState } from 'react';
import { ArticleWriteSchema, DraftArticleMetaSchema } from '@foliohaven/core';
import type {
  ArticleResource,
  ArticleWrite,
  DraftArticleMeta,
  PreviewResponse,
  SiteConfig,
  Taxonomy,
} from '@foliohaven/core';
import { ApiFailure, isAborted, newKey } from './api.js';
import type { ApiResponse, StudioApi } from './api.js';
import { useCommand, useResource } from './hooks.js';
import {
  Conflict,
  Diagnostics,
  ErrorNotice,
  Field,
  RetryNotice,
  SeoFields,
  TextField,
} from './components.js';
import { HtmlEditor } from './HtmlEditor.js';
import { ImageSelect } from './ImageSelect.js';
import { PreviewViewport } from './PreviewViewport.js';
import { Icon } from './Icon.js';
import { getSeoFieldDefaults } from './seo-defaults.js';
import { DateTimeField } from './DateTimeField.js';
import { RelatedReadingEditor } from './RelatedReadingEditor.js';
import { ArticleTagsEditor } from './ArticleTagsEditor.js';
import { ArticlePageLinks } from './ArticlePageLinks.js';
import type { ArticleWorkspaceStatus } from './ArticlePageLinks.js';
import {
  formatLocalDateTime,
  getLocalDateTime,
  parseDateTimeInput,
} from './date-time.js';

interface EditorValue {
  readonly contentHtml: string;
  readonly meta: DraftArticleMeta;
}
const editable = (resource: ArticleResource | null): EditorValue => ({
  contentHtml: resource?.contentHtml ?? '',
  meta: DraftArticleMetaSchema.parse({ ...resource?.meta, status: 'draft' }),
});
function dateLabel(value: string | null, site: SiteConfig | null) {
  if (!value) return '尚未填寫';
  const parts = site ? getLocalDateTime(value, site.timeZone) : null;
  const resolved = site ? parseDateTimeInput(value, site.timeZone) : null;
  return parts && resolved?.status === 'valid'
    ? `${formatLocalDateTime(parts)}（${site?.timeZone} · ${resolved.candidate.offsetLabel}）`
    : value;
}
interface Props {
  readonly api: StudioApi;
  readonly id: string | null;
  readonly taxonomy: Taxonomy;
  readonly site: SiteConfig | null;
  readonly writable: boolean;
  readonly workspace: ArticleWorkspaceStatus;
  readonly onDirty: (dirty: boolean) => void;
  readonly onBlocked: (blocked: boolean) => void;
  readonly onSaved: (article: ArticleResource) => void;
  readonly onTaxonomySaved: () => void;
  readonly onBack: () => void;
}
export function ArticleEditor(props: Props) {
  return props.id === null ? (
    <EditorForm {...props} initial={null} />
  ) : (
    <ExistingEditor {...props} />
  );
}
function ExistingEditor(props: Props) {
  const resource = useResource<ArticleResource>(
    props.api,
    `/api/v1/articles/${props.id ?? ''}`,
  );
  if (!resource.response)
    return (
      <section>
        <h2>文章編輯</h2>
        <ErrorNotice error={resource.error} currentArticleId={props.id} />
        {resource.error ? (
          <button onClick={resource.reload}>重新讀取文章</button>
        ) : (
          <p role="status">讀取文章中…</p>
        )}
        <button onClick={props.onBack}>返回文章清單</button>
      </section>
    );
  return (
    <EditorForm
      key={props.id ?? 'new'}
      {...props}
      initial={resource.response}
    />
  );
}
function EditorForm({
  api,
  id,
  initial,
  taxonomy,
  site,
  writable,
  workspace,
  onDirty,
  onBlocked,
  onSaved,
  onTaxonomySaved,
  onBack,
}: Props & { readonly initial: ApiResponse<ArticleResource> | null }) {
  const [base, setBase] = useState(initial);
  const [value, setValue] = useState(() => editable(initial?.data ?? null));
  const [validation, setValidation] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState<ApiResponse<ArticleResource> | null>(
    null,
  );
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [mobileView, setMobileView] = useState('write');
  const [editorId] = useState(newKey);
  const [datePending, setDatePending] = useState({
    publishedAt: false,
    updatedAt: false,
  });
  const [dateReset, setDateReset] = useState(0);
  const datesRef = useRef<HTMLDetailsElement>(null);
  const datesIncomplete = datePending.publishedAt || datePending.updatedAt;
  const publishedPendingChanged = useCallback((pending: boolean) => {
    setDatePending((previous) =>
      previous.publishedAt === pending
        ? previous
        : { ...previous, publishedAt: pending },
    );
  }, []);
  const updatedPendingChanged = useCallback((pending: boolean) => {
    setDatePending((previous) =>
      previous.updatedAt === pending
        ? previous
        : { ...previous, updatedAt: pending },
    );
  }, []);
  const previewArticleId = id ?? `preview-${editorId}`;
  const sequence = useRef(0);
  const [location, setLocation] = useState<{
    line: number;
    column: number;
    version: number;
  } | null>(null);
  const command = useCommand(api);
  const [tagBusy, setTagBusy] = useState(false);
  const bufferDirty =
    JSON.stringify(value) !== JSON.stringify(editable(base?.data ?? null));
  useEffect(() => {
    onDirty(
      bufferDirty ||
        datesIncomplete ||
        tagBusy ||
        command.busy ||
        Boolean(command.pending),
    );
    onBlocked(tagBusy || command.busy || Boolean(command.pending));
  }, [
    bufferDirty,
    datesIncomplete,
    tagBusy,
    command.busy,
    command.pending,
    onBlocked,
    onDirty,
  ]);
  useEffect(
    () => () => {
      onBlocked(false);
    },
    [onBlocked],
  );
  const change = useCallback(
    (next: EditorValue) => {
      setValue(next);
      onDirty(
        datesIncomplete ||
          JSON.stringify(next) !== JSON.stringify(editable(base?.data ?? null)),
      );
      setNotice('');
    },
    [base, datesIncomplete, onDirty],
  );
  const meta = (next: Partial<DraftArticleMeta>) =>
    change({ ...value, meta: { ...value.meta, ...next } });
  const htmlChange = useCallback(
    (contentHtml: string) => change({ ...value, contentHtml }),
    [change, value],
  );
  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPreviewBusy(true);
      void api
        .send<PreviewResponse>(
          'POST',
          '/api/v1/previews',
          { articleId: previewArticleId, ...value },
          { editorId, signal: controller.signal },
        )
        .then(
          (result) => {
            if (current === sequence.current) {
              setPreview(result.data);
              setPreviewError(null);
            }
          },
          (error) => {
            if (current === sequence.current && !isAborted(error))
              setPreviewError(error);
          },
        )
        .finally(() => {
          if (current === sequence.current) setPreviewBusy(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, editorId, previewArticleId, previewRetry, value]);
  const save = useCallback(
    async (status: 'draft' | 'published', confirmPublication = false) => {
      if (!writable || tagBusy || command.busy || Boolean(command.pending))
        return;
      if (datesIncomplete) {
        setMobileView('settings');
        if (datesRef.current) datesRef.current.open = true;
        requestAnimationFrame(() => {
          const field = datePending.publishedAt
            ? 'meta.publishedAt'
            : 'meta.updatedAt';
          datesRef.current
            ?.querySelector<HTMLInputElement>(`input[data-field="${field}"]`)
            ?.focus();
        });
        return;
      }
      if (
        status === 'published' &&
        (confirmPublication || base?.data.meta.status !== 'published') &&
        !window.confirm(
          `確認發布這份編輯內容？\n發布：${dateLabel(value.meta.publishedAt, site)}\n更新：${dateLabel(value.meta.updatedAt, site)}\n保存後，請到「網站更新與工作」更新網站。`,
        )
      )
        return;
      if (
        status === 'draft' &&
        base?.data.meta.status === 'published' &&
        !window.confirm(
          '確認撤回公開狀態並保存目前完整內容為草稿？更新網站後，公開網站才會移除這篇文章。',
        )
      )
        return;
      setValidation(null);
      setNotice('');
      let body: ArticleWrite;
      try {
        body = ArticleWriteSchema.parse({
          ...value,
          meta: { ...value.meta, status },
        });
      } catch (error) {
        setValidation(error);
        return;
      }
      try {
        await command.run<ArticleResource>(
          {
            label: id === null ? '建立草稿' : '保存文章',
            method: id === null ? 'POST' : 'PUT',
            path: id === null ? '/api/v1/articles' : `/api/v1/articles/${id}`,
            body,
            ...(base?.etag ? { etag: base.etag } : {}),
            ...(id === null ? { idempotencyKey: newKey() } : {}),
          },
          (response) => {
            setBase(response);
            setValue(editable(response.data));
            setDateReset((count) => count + 1);
            setConflict(null);
            onDirty(false);
            setNotice('文章已保存。更新網站後，讀者才會看到這次變更。');
            onSaved(response.data);
          },
        );
      } catch (error) {
        if (
          error instanceof ApiFailure &&
          error.status === 412 &&
          id !== null
        ) {
          try {
            setConflict(
              await api.get<ArticleResource>(`/api/v1/articles/${id}`),
            );
          } catch (currentError) {
            setValidation(currentError);
          }
        }
      }
    },
    [
      api,
      base,
      command,
      datePending.publishedAt,
      datesIncomplete,
      id,
      onDirty,
      onSaved,
      site,
      tagBusy,
      value,
      writable,
    ],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (document.querySelector('dialog[open]')) return;
        void save(base?.data.meta.status ?? 'draft');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [base, save]);
  const revealField = (path: readonly (string | number)[]) => {
    setMobileView(path.includes('contentHtml') ? 'write' : 'settings');
    if (
      (path.includes('publishedAt') || path.includes('updatedAt')) &&
      datesRef.current
    )
      datesRef.current.open = true;
  };
  return (
    <section aria-labelledby="editor-title">
      <div className="section-heading">
        <h2 id="editor-title" className="editor-title-heading">
          <Icon name="article" />
          {id === null
            ? '建立文章'
            : `編輯文章：${base?.data.meta.title || '未命名文章'}`}
        </h2>
        <button onClick={onBack}>
          <Icon name="arrowLeft" size={18} />
          返回清單
        </button>
      </div>
      <p className="editor-summary">
        狀態：{base?.data.meta.status === 'published' ? '已發布' : '草稿'}·
        Ctrl／Cmd + S 保存目前狀態
      </p>
      {!writable && (
        <p className="notice">
          目前為唯讀模式；目前編輯的內容仍會保留。切換 Studio 模式後才能保存。
        </p>
      )}
      <ErrorNotice
        error={validation}
        currentArticleId={id}
        onBeforeFocus={revealField}
      />
      <RetryNotice
        api={api}
        command={command}
        currentArticleId={id}
        onBeforeFocus={revealField}
      />
      {notice && (
        <p role="status" className="notice success">
          {notice}
        </p>
      )}
      {conflict && (
        <Conflict
          base={base?.data}
          local={{
            ...value,
            meta: { ...value.meta, status: base?.data.meta.status ?? 'draft' },
          }}
          current={conflict.data}
          onKeepLocal={() => {
            setBase(conflict);
            setConflict(null);
            onDirty(true);
            command.clear();
          }}
          onReload={() => {
            if (window.confirm('以已保存版本取代目前尚未保存內容？')) {
              setBase(conflict);
              setValue(editable(conflict.data));
              setDateReset((count) => count + 1);
              setConflict(null);
              command.clear();
              onDirty(false);
            }
          }}
        />
      )}
      <div
        className="tabs editor-mobile-tabs"
        role="tablist"
        aria-label="編輯工作區"
        onKeyDown={(event) => {
          const views = ['write', 'preview', 'settings'];
          const index = views.indexOf(mobileView);
          const next =
            event.key === 'ArrowRight'
              ? (index + 1) % 3
              : event.key === 'ArrowLeft'
                ? (index + 2) % 3
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? 2
                    : -1;
          if (next < 0) return;
          event.preventDefault();
          setMobileView(views[next] ?? 'write');
          event.currentTarget
            .querySelectorAll<HTMLButtonElement>('button')
            [next]?.focus();
        }}
      >
        {(
          [
            ['write', '正文'],
            ['preview', '預覽'],
            ['settings', '文章設定'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={mobileView === key}
            onClick={() => setMobileView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="editor-layout" data-view={mobileView}>
        <div className="editor-workspace">
          <div className="editor-columns">
            <section className="editor-code">
              <div className="editor-panel-heading">
                <h3>
                  <Icon name="edit" size={18} />
                  文章正文
                </h3>
                <span className="muted">不會自動保存</span>
              </div>
              <p className="editor-help">
                在這裡撰寫文章內容與章節。文章標題會自動顯示，不需要在正文重複加入。
              </p>
              <HtmlEditor
                value={value.contentHtml}
                onChange={htmlChange}
                location={location}
                readOnly={!writable || command.busy || Boolean(command.pending)}
              />
            </section>
            <section className="editor-preview" aria-busy={previewBusy}>
              <div className="editor-panel-heading">
                <h3>
                  <Icon name="eye" size={18} />
                  即時預覽
                </h3>
                {previewBusy && (
                  <span className="muted" role="status">
                    更新中…
                  </span>
                )}
              </div>
              <p className="editor-help">
                選擇裝置檢查閱讀效果；預覽不會保存文章。
              </p>
              <PreviewViewport
                documentUrl={preview?.documentUrl ?? null}
                layoutKey={mobileView}
                placeholder={
                  previewBusy
                    ? '正在產生預覽…'
                    : previewError
                      ? '預覽尚未完成，請查看下方檢查結果。'
                      : '輸入標題與正文，這裡會顯示文章。'
                }
              />
              <section
                className="preview-feedback"
                aria-label="預覽檢查結果"
                tabIndex={0}
              >
                <h4>預覽檢查結果</h4>
                <ErrorNotice error={previewError} currentArticleId={id} />
                {previewError ? (
                  <div className="actions">
                    <span className="muted">
                      {preview
                        ? '目前顯示上一次成功的預覽。'
                        : '本次預覽未完成。'}
                    </span>
                    <button
                      onClick={() => setPreviewRetry((count) => count + 1)}
                    >
                      重新產生預覽
                    </button>
                  </div>
                ) : preview ? (
                  <Diagnostics
                    currentArticleId={previewArticleId}
                    onLocate={(line, column) => {
                      setMobileView('write');
                      setLocation((previous) => ({
                        line,
                        column,
                        version: (previous?.version ?? 0) + 1,
                      }));
                    }}
                    items={preview.diagnostics}
                  />
                ) : (
                  <p className="muted">預覽完成後會顯示檢查結果。</p>
                )}
              </section>
            </section>
          </div>
        </div>
        <aside className="editor-settings" aria-label="文章設定">
          <fieldset
            disabled={
              !writable || tagBusy || command.busy || Boolean(command.pending)
            }
          >
            <legend>文章設定</legend>
            <TextField
              label="文章標題"
              field="meta.title"
              value={value.meta.title}
              maxLength={200}
              multiline
              rows={2}
              hint="顯示為文章頁主標題（H1）；SEO Title 可另外設定。"
              onChange={(title) => meta({ title: title ?? '' })}
            />
            <TextField
              label="文章摘要"
              field="meta.excerpt"
              value={value.meta.excerpt}
              maxLength={300}
              multiline
              rows={4}
              width="full"
              hint="用於文章列表、搜尋與延伸閱讀；未覆寫的 SEO 描述可由文章類型設定沿用這份摘要。"
              onChange={(excerpt) => meta({ excerpt: excerpt ?? '' })}
            />
            <TextField
              label="文章網址名稱"
              field="meta.slug"
              value={value.meta.slug}
              maxLength={80}
              hint="這段文字會出現在文章網址中，例如 first-note。"
              width="medium"
              onChange={(slug) => meta({ slug: slug ?? '' })}
            />
            <Field label="分類">
              <select
                value={value.meta.category ?? ''}
                data-field="meta.category"
                onChange={(event) =>
                  meta({ category: event.target.value || null })
                }
              >
                <option value="">尚未選擇</option>
                {taxonomy.categories.map((item) => (
                  <option key={item.path} value={item.path}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
            <ArticleTagsEditor
              api={api}
              tags={taxonomy.tags}
              value={value.meta.tags}
              disabled={!writable || command.busy || Boolean(command.pending)}
              onChange={(tags) => meta({ tags })}
              onTaxonomySaved={onTaxonomySaved}
              onBusy={setTagBusy}
            />
            <details className="editor-dates" ref={datesRef}>
              <summary>發布與更新時間</summary>
              <DateTimeField
                label="發布時間"
                field="meta.publishedAt"
                value={value.meta.publishedAt}
                timeZone={site?.timeZone ?? null}
                disabled={!writable || command.busy || Boolean(command.pending)}
                resetKey={dateReset}
                onPendingChange={publishedPendingChanged}
                onChange={(publishedAt) => meta({ publishedAt })}
              />
              <DateTimeField
                label="更新時間"
                field="meta.updatedAt"
                value={value.meta.updatedAt}
                timeZone={site?.timeZone ?? null}
                disabled={!writable || command.busy || Boolean(command.pending)}
                resetKey={dateReset}
                onPendingChange={updatedPendingChanged}
                onChange={(updatedAt) => meta({ updatedAt })}
              />
              <button
                disabled={datesIncomplete || !site}
                onClick={() => {
                  const now = new Date().toISOString();
                  meta({
                    publishedAt: value.meta.publishedAt ?? now,
                    updatedAt: now,
                  });
                }}
              >
                填入目前時間
              </button>
              {datesIncomplete && (
                <p className="date-time-error" role="alert">
                  請完成或清除尚未設定完成的日期時間，才能保存文章。
                </p>
              )}
            </details>
            <ImageSelect
              api={api}
              label="精選圖片"
              field="meta.featuredImage"
              value={value.meta.featuredImage}
              onChange={(featuredImage) => meta({ featuredImage })}
              emptyLabel="不使用精選圖片"
              imagesOnly
              hint="建議使用1280 × 720以上的橫式圖片（16:9）。會保留原比例，不會自動裁切。"
            />
            <TextField
              label="精選圖片 Alt（空白可作裝飾）"
              field="meta.featuredImageAlt"
              value={value.meta.featuredImageAlt}
              maxLength={300}
              multiline
              rows={2}
              onChange={(featuredImageAlt) =>
                meta({ featuredImageAlt: featuredImageAlt ?? '' })
              }
            />
            <SeoFields
              api={api}
              prefix="meta.seo"
              value={value.meta.seo}
              imageInheritLabel="沿用文章頁類型設定，未設定時使用全域分享圖片"
              defaults={getSeoFieldDefaults(site, {
                kind: 'article',
                pageType: 'article',
                title: value.meta.title,
                excerpt: value.meta.excerpt,
                featuredImage: value.meta.featuredImage,
              })}
              resolved={getSeoFieldDefaults(site, {
                kind: 'article',
                pageType: 'article',
                title: value.meta.title,
                excerpt: value.meta.excerpt,
                featuredImage: value.meta.featuredImage,
                seo: value.meta.seo,
              })}
              onChange={(seo) => meta({ seo })}
            />
            <RelatedReadingEditor
              api={api}
              articleId={previewArticleId}
              value={value.meta.relatedReading}
              disabled={!writable || command.busy || Boolean(command.pending)}
              onChange={(relatedReading) => meta({ relatedReading })}
            />
          </fieldset>
        </aside>
      </div>
      <ArticlePageLinks
        key={base?.etag ?? 'new'}
        api={api}
        article={base?.data ?? null}
        site={site}
        dirty={bufferDirty}
        workspace={workspace}
      />
      <div className="actions sticky-actions">
        <button
          className="primary"
          disabled={
            !writable ||
            tagBusy ||
            datesIncomplete ||
            command.busy ||
            Boolean(command.pending)
          }
          onClick={() => void save(base?.data.meta.status ?? 'draft')}
        >
          <Icon name="save" size={18} />
          {id === null ? '建立草稿' : '保存目前內容'}
        </button>
        <button
          disabled={
            !writable ||
            tagBusy ||
            datesIncomplete ||
            command.busy ||
            Boolean(command.pending) ||
            id === null
          }
          onClick={() => void save('published', true)}
        >
          <Icon name="check" size={18} />
          發布目前內容
        </button>
        {base?.data.meta.status === 'published' && (
          <button
            disabled={
              !writable ||
              tagBusy ||
              datesIncomplete ||
              command.busy ||
              Boolean(command.pending)
            }
            onClick={() => void save('draft')}
          >
            <Icon name="edit" size={18} />
            撤回為草稿
          </button>
        )}
      </div>
    </section>
  );
}
