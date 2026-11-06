import { cloneElement, isValidElement, useId, useState } from 'react';
import type { AriaAttributes, ReactNode } from 'react';
import type { Diagnostic, SeoOverride } from '@foliohaven/core';
import { ApiFailure, messageOf } from './api.js';
import type { StudioApi } from './api.js';
import type { useCommand } from './hooks.js';
import { ImageSelect } from './ImageSelect.js';
import { Icon } from './Icon.js';
import type { SeoFieldDefaults } from './seo-defaults.js';
import { seoSourceLabel } from './seo-defaults.js';
import { SeoEffectivePreview } from './SeoEffectivePreview.js';
import { useFormFieldIssues } from './form-issues.js';
import {
  focusField,
  inputIssues,
  isCurrentHtmlDiagnostic,
} from './validation.js';

export function Field({
  label,
  children,
  hint,
  width = 'full',
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  width?: 'short' | 'medium' | 'wide' | 'full';
}) {
  const id = useId();
  const child = isValidElement<
    { id?: string; 'data-field'?: string } & Pick<
      AriaAttributes,
      'aria-describedby' | 'aria-invalid'
    >
  >(children)
    ? children
    : null;
  const issues = useFormFieldIssues(child?.props['data-field']);
  const describedBy = [
    child?.props['aria-describedby'],
    hint ? `${id}-hint` : null,
    issues.length ? `${id}-error` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const control = child
    ? cloneElement(child, {
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(issues.length ? { 'aria-invalid': true } : {}),
      })
    : children;
  return (
    <div className={`field field--${width}`}>
      <label htmlFor={id}>{label}</label>
      {control}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {issues.length > 0 && (
        <small id={`${id}-error`} className="field-error">
          {issues.map((issue) => issue.message).join('；')}
        </small>
      )}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  maxLength,
  nullable = false,
  disabled = false,
  field,
  multiline = false,
  rows = 3,
  width = 'medium',
  hint,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  type?: string;
  maxLength?: number;
  nullable?: boolean;
  disabled?: boolean;
  field?: string;
  multiline?: boolean;
  rows?: number;
  width?: 'short' | 'medium' | 'wide' | 'full';
  hint?: string;
}) {
  const change = (next: string) =>
    onChange(nullable && next === '' ? null : next);
  return (
    <Field label={label} width={width} {...(hint ? { hint } : {})}>
      {multiline ? (
        <textarea
          value={value ?? ''}
          rows={rows}
          maxLength={maxLength}
          disabled={disabled}
          data-field={field ?? label}
          onChange={(event) => change(event.target.value)}
        />
      ) : (
        <input
          type={type}
          value={value ?? ''}
          maxLength={maxLength}
          disabled={disabled}
          data-field={field ?? label}
          onChange={(event) => change(event.target.value)}
        />
      )}
    </Field>
  );
}
export function ErrorNotice({
  error,
  currentArticleId,
  onBeforeFocus,
}: {
  error: unknown;
  currentArticleId?: string | null;
  onBeforeFocus?: (path: readonly (string | number)[]) => void;
}) {
  if (!error) return null;
  const issues = inputIssues(error);
  return (
    <section className="notice error" role="alert">
      <p>{messageOf(error)}</p>
      {error instanceof ApiFailure && (
        <details className="error-support-details">
          <summary>錯誤詳細資訊</summary>
          <p>
            代碼：{error.code}
            {error.requestId && ` · 查詢編號 ${error.requestId}`}
          </p>
        </details>
      )}
      {issues.length > 0 && (
        <ul>
          {issues.map((issue, index) => (
            <li key={index}>
              <button
                className="text-button"
                onClick={() => {
                  onBeforeFocus?.(issue.path);
                  requestAnimationFrame(() =>
                    focusField(issue.path, currentArticleId),
                  );
                }}
              >
                {issue.path.join('.') || '設定'}：{issue.message}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
export function Diagnostics({
  items,
  onLocate,
  currentArticleId,
}: {
  items: readonly Diagnostic[];
  onLocate?: (line: number, column: number) => void;
  currentArticleId?: string | null;
}) {
  return items.length ? (
    <ul className="diagnostics">
      {items.map((item, index) => (
        <li key={index} className={item.severity}>
          <strong>
            {item.severity === 'error' ? '錯誤' : '提醒'} {item.code}
          </strong>
          ：{item.message}
          {item.articleId && <span> · 文章：{item.articleId}</span>}
          {item.resource && <span> · 來源：{item.resource}</span>}
          {item.field && `（${item.field}）`}
          {item.line &&
            ` 第 ${item.line} 行${item.column ? `，第 ${item.column} 欄` : ''}`}
          {onLocate && isCurrentHtmlDiagnostic(item, currentArticleId) && (
            <button
              className="text-button"
              onClick={() => onLocate(item.line ?? 1, item.column ?? 1)}
            >
              定位正文
            </button>
          )}
        </li>
      ))}
    </ul>
  ) : (
    <p className="muted">沒有診斷問題。</p>
  );
}
export function SeoFields({
  api,
  value,
  onChange,
  prefix = 'seo',
  imageInheritLabel = '繼承頁面類型／全域預設圖片',
  defaults = null,
  resolved = null,
  previewTitle = '目前生效結果',
}: {
  api: StudioApi;
  value: SeoOverride;
  onChange: (value: SeoOverride) => void;
  prefix?: string;
  imageInheritLabel?: string;
  defaults?: SeoFieldDefaults | null;
  resolved?: SeoFieldDefaults | null;
  previewTitle?: string;
}) {
  const imageSource =
    value.imageSource ?? (value.ogImage === null ? 'inherit' : 'custom');
  const imageSourceLabel = defaults
    ? seoSourceLabel(
        defaults.sources.image,
        'image',
        defaults.pageType,
        defaults.sourceLayers.image,
      )
    : '目前無法讀取全站預設值';
  const globalIndex = defaults?.sources.index === 'global';
  return (
    <fieldset className="seo-fields">
      <legend>
        <Icon name="globe" /> SEO 與社群分享
      </legend>
      <p className="muted">
        每個欄位獨立繼承：單筆覆寫優先，再使用頁面類型預設，最後回退全域預設。文字欄位留白即為繼承；自訂標題會作為完整
        Meta Title 使用。
      </p>
      <TextField
        label="SEO Title"
        hint={
          defaults
            ? `預設：${defaults.title || '未設定'}`
            : '目前無法讀取全站預設值，請至「全站設定」確認。'
        }
        field={`${prefix}.title`}
        value={value.title}
        nullable
        maxLength={200}
        width="wide"
        onChange={(title) => onChange({ ...value, title })}
      />
      <TextField
        label="Meta Description"
        hint={
          defaults
            ? `預設：${defaults.description || '未設定'}`
            : '目前無法讀取全站預設值。'
        }
        field={`${prefix}.description`}
        value={value.description}
        nullable
        maxLength={300}
        multiline
        rows={3}
        width="wide"
        onChange={(description) => onChange({ ...value, description })}
      />
      <Field
        label="分享圖片設定"
        hint="不使用圖片會停止繼承，並且不輸出分享圖片標籤；文章內的封面仍照常顯示。"
        width="wide"
      >
        <select
          data-field={`${prefix}.imageSource`}
          value={imageSource}
          onChange={(event) => {
            const next = event.target.value as 'inherit' | 'custom' | 'none';
            onChange({
              ...value,
              imageSource: next,
              ogImage: next === 'custom' ? value.ogImage : null,
            });
          }}
        >
          <option value="inherit">繼承頁面類型／全域預設</option>
          <option value="custom">指定圖片</option>
          <option value="none">不使用分享圖片</option>
        </select>
      </Field>
      <ImageSelect
        api={api}
        label="OG Image"
        field={`${prefix}.ogImage`}
        value={imageSource === 'custom' ? value.ogImage : null}
        emptyLabel={
          imageSource === 'none' ? '不使用分享圖片' : imageInheritLabel
        }
        {...(imageSource === 'inherit'
          ? {
              inheritanceKnown: defaults !== null,
              inheritedValue: defaults?.ogImage ?? null,
              inheritedLabel: `繼承自${imageSourceLabel}`,
            }
          : {})}
        preference="social"
        hint="可選1200 × 630分享尺寸，提供完整補邊與裁切填滿兩種版本。"
        onChange={(ogImage) =>
          onChange({
            ...value,
            ogImage,
            imageSource: ogImage === null ? 'inherit' : 'custom',
          })
        }
      />
      <Field
        label="Indexing"
        width="medium"
        hint={
          defaults
            ? `${seoSourceLabel(defaults.sources.index, 'index', defaults.pageType, defaults.sourceLayers.index)}：${defaults.index ? '允許索引，搜尋引擎可收錄此頁' : '不允許索引，頁面仍會公開'}`
            : '目前無法讀取全站預設值。'
        }
      >
        <select
          data-field={`${prefix}.index`}
          value={value.index === null ? 'inherit' : String(value.index)}
          onChange={(event) =>
            onChange({
              ...value,
              index:
                event.target.value === 'inherit'
                  ? null
                  : event.target.value === 'true',
            })
          }
        >
          <option value="inherit">
            {defaults
              ? `使用${globalIndex ? '全站' : '頁面類型'}預設值 · ${defaults.index ? '允許索引' : '不允許索引'}`
              : '使用全站預設值 · 目前無法確認預設值'}
          </option>
          <option value="true">允許索引</option>
          <option value="false">不允許索引</option>
        </select>
      </Field>
      <SeoEffectivePreview value={resolved ?? defaults} title={previewTitle} />
    </fieldset>
  );
}
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label="分頁">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        上一頁
      </button>
      <span>
        第 {page}／{pages} 頁，共 {total} 筆
      </span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}>
        下一頁
      </button>
    </nav>
  );
}
export function RetryNotice({
  command,
  api,
  currentArticleId = null,
  onBeforeFocus,
}: {
  command: ReturnType<typeof useCommand>;
  api: StudioApi;
  currentArticleId?: string | null;
  onBeforeFocus?: (path: readonly (string | number)[]) => void;
}) {
  const [operation, setOperation] = useState<unknown>(null);
  const [operationError, setOperationError] = useState<unknown>(null);
  return (
    <>
      <ErrorNotice
        error={command.error}
        currentArticleId={currentArticleId}
        {...(onBeforeFocus ? { onBeforeFocus } : {})}
      />
      {command.pending && (
        <section className="notice">
          <p>
            「{command.pending.command.label}
            」的回覆尚未確認。重新嘗試會繼續這一次操作，請勿重複新增。
          </p>
          <details className="error-support-details">
            <summary>查看操作紀錄</summary>
            <code>操作編號：{command.pending.command.idempotencyKey}</code>
          </details>
          <div className="actions">
            <button
              disabled={command.busy}
              onClick={() => void command.retry().catch(() => undefined)}
            >
              重試這次操作
            </button>
            {command.error instanceof ApiFailure &&
              command.error.location?.startsWith('/api/v1/operations/') && (
                <button
                  onClick={() => {
                    const location = (command.error as ApiFailure).location;
                    if (location)
                      void api
                        .get(location)
                        .then((result) => setOperation(result.data))
                        .catch(setOperationError);
                  }}
                >
                  查詢操作結果
                </button>
              )}
            <button
              disabled={command.busy}
              onClick={() => {
                if (
                  window.confirm(
                    '結束重試不會取消可能已完成的變更，請先查看資料是否更新。確認結束？',
                  )
                )
                  command.clear({ discardPending: true });
              }}
            >
              結束重試
            </button>
          </div>
          <ErrorNotice
            error={operationError}
            currentArticleId={currentArticleId}
          />
          {operation !== null && (
            <pre>{JSON.stringify(operation, null, 2)}</pre>
          )}
        </section>
      )}
    </>
  );
}
export function Conflict({
  base,
  local,
  current,
  onReload,
  onKeepLocal,
}: {
  base: unknown;
  local: unknown;
  current: unknown;
  onReload: () => void;
  onKeepLocal?: () => void;
}) {
  return (
    <section className="notice error" aria-label="版本衝突">
      <h3>版本已變更，未保存內容仍保留</h3>
      <p>
        比較後選擇保留自己的編輯，或載入已保存的版本。請先整理要保留的修改，再保存。
      </p>
      <div className="compare">
        {[
          ['開始編輯時', base],
          ['尚未保存', local],
          ['已保存版本', current],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <h4>{String(label)}</h4>
            <pre>{JSON.stringify(value, null, 2)}</pre>
          </div>
        ))}
      </div>
      <button onClick={onReload}>採用已保存版本</button>
      {onKeepLocal && (
        <button
          onClick={() => {
            if (
              window.confirm(
                '確認已比較三個版本？將保留自己的編輯。再次保存前，請先整理要保留的外部修改。',
              )
            )
              onKeepLocal();
          }}
        >
          保留我的內容繼續編輯
        </button>
      )}
    </section>
  );
}
