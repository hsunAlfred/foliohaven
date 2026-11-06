import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { captureFocusOwner } from './focus.js';
import { ManagedImagePathSchema } from '@foliohaven/core';
import type { Job, MediaSourceResource } from '@foliohaven/core';
import type { StudioApi } from './api.js';
import { ApiFailure, newKey, queryPath } from './api.js';
import { useCommand, useResource } from './hooks.js';
import { Dialog } from './Dialog.js';
import { ErrorNotice, Pagination, RetryNotice } from './components.js';
import { MediaUploadDialog } from './MediaUpload.js';
import { MediaJobProgress } from './MediaJobProgress.js';
import {
  imageOutputs,
  imageSizeLabel,
  mediaFileUrl,
  needsPreferredImages,
  preferredImage,
  selectableImageOutputs,
} from './media-display.js';
import type { ImagePreference } from './media-display.js';
import { MediaThumbnail } from './MediaThumbnail.js';
import { Icon } from './Icon.js';
import { useFormFieldIssues } from './form-issues.js';
import './media.css';

interface Collection {
  items: MediaSourceResource[];
  total: number;
  page: number;
  pageSize: number;
}

export function ImageSelect({
  api,
  label,
  value,
  onChange,
  field,
  disabled = false,
  emptyLabel = '不設定圖片',
  hint,
  imagesOnly = false,
  inheritedValue = null,
  inheritedLabel,
  inheritanceKnown = true,
  preference,
}: {
  api: StudioApi;
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  field: string;
  disabled?: boolean;
  emptyLabel?: string;
  hint?: string;
  imagesOnly?: boolean;
  inheritedValue?: string | null;
  inheritedLabel?: string;
  inheritanceKnown?: boolean;
  preference?: ImagePreference;
}) {
  const fallbackLabel = inheritedLabel ?? '目前預設圖片';
  const hasInheritance =
    inheritedLabel !== undefined || inheritedValue !== null;
  const id = useId();
  const fieldIssues = useFormFieldIssues(field);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [upload, setUpload] = useState(false);
  const [prepare, setPrepare] = useState<MediaSourceResource | null>(null);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const displayPath = value ?? inheritedValue;
  const inherited = value === null && inheritedValue !== null;
  const isManaged =
    displayPath !== null &&
    ManagedImagePathSchema.safeParse(displayPath).success;
  const selected = useImageSource(api, displayPath, revision);
  const fallback = useImageSource(
    api,
    inheritedValue === displayPath ? null : inheritedValue,
    revision,
  );
  const currentSource = selected.source;
  const currentOutput =
    currentSource &&
    imageOutputs(currentSource).find(
      (output) => output.publicPath === displayPath,
    );
  const inheritedSource =
    inheritedValue === displayPath ? currentSource : fallback.source;
  const inheritedOutput =
    inheritedSource &&
    imageOutputs(inheritedSource).find(
      (output) => output.publicPath === inheritedValue,
    );
  const inheritedDescription = !inheritanceKnown
    ? '目前無法確認預設圖片'
    : inheritedValue === null
      ? '未設定圖片'
      : inheritedSource && inheritedOutput
        ? `${inheritedSource.displayName} · ${inheritedOutput.width} × ${inheritedOutput.height}`
        : (inheritedValue === displayPath ? selected.error : fallback.error)
          ? '目前預設圖片無法讀取，原設定仍保留'
          : '正在讀取預設圖片…';
  const choose = (path: string | null) => {
    const ownsFocus = captureFocusOwner(
      trigger.current?.ownerDocument ?? document,
    );
    onChange(path);
    setOpen(false);
    setPrepare(null);
    requestAnimationFrame(() => {
      if (ownsFocus()) trigger.current?.focus();
    });
  };
  const missing = Boolean(
    displayPath &&
    ((selected.error instanceof ApiFailure && selected.error.status === 404) ||
      (currentSource && !currentOutput)),
  );
  const incompatible =
    (imagesOnly && currentSource?.kind === 'video') ||
    (preference === 'mask' &&
      currentSource !== null &&
      (currentSource.mimeType !== 'image/svg+xml' ||
        !currentOutput?.publicPath.endsWith('.svg')));
  const selectionLabel = displayPath
    ? (currentSource?.displayName ??
      (missing ? '找不到這張圖片' : '讀取目前圖片中…'))
    : emptyLabel;
  return (
    <div className="field field--wide image-select">
      <label htmlFor={id}>{label}</label>
      <button
        ref={trigger}
        id={id}
        type="button"
        className="image-select__trigger"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={`${id}-picker`}
        aria-describedby={
          [hint ? `${id}-hint` : '', fieldIssues.length ? `${id}-error` : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
        aria-invalid={fieldIssues.length > 0 || undefined}
        disabled={disabled}
        data-field={field}
        title={
          inherited ? `${fallbackLabel}：${selectionLabel}` : selectionLabel
        }
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {currentSource && currentOutput && !incompatible ? (
          <MediaThumbnail
            source={currentSource}
            path={currentOutput.publicPath}
          />
        ) : (
          <span className="image-select__placeholder">
            <Icon name="image" size={24} />
          </span>
        )}
        <span className="image-select__selection">
          <strong>{selectionLabel}</strong>
          <small>
            {inherited && `${fallbackLabel} · `}
            {currentOutput
              ? `${currentOutput.width} × ${currentOutput.height}`
              : displayPath
                ? '目前選擇已保留'
                : '開啟圖片選擇視窗'}
          </small>
        </span>
        <Icon name="image" />
      </button>
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {fieldIssues.length > 0 && (
        <small id={`${id}-error`} className="field-error">
          {fieldIssues.map((issue) => issue.message).join('；')}
        </small>
      )}
      {hasInheritance && (
        <small className="image-select__default">
          {fallbackLabel}：{inheritedDescription}
        </small>
      )}
      {displayPath && !isManaged && (
        <p className="field-warning">
          目前的圖片位置無法辨識，原選擇仍保留；請重新選擇圖片。
        </p>
      )}
      {missing && (
        <p className="field-warning" role="status">
          這張圖片已不存在或還不能使用。原選擇仍保留，請重新選擇。
        </p>
      )}
      {incompatible && (
        <p className="field-warning" role="status">
          {preference === 'mask'
            ? '這個欄位需要 SVG 圖形，請重新選擇；目前設定仍保留。'
            : '目前選用的是影片封面。精選圖片只接受圖片，請選擇另一張；保存前不會自動變更。'}
        </p>
      )}
      {selected.error !== null && !missing && (
        <ErrorNotice error={selected.error} />
      )}
      {open && !disabled && (
        <Dialog
          id={`${id}-picker`}
          open
          title={`選擇${label}`}
          onClose={() => setOpen(false)}
          className="image-picker-dialog"
        >
          {notice && (
            <p role="status" className="notice">
              {notice}
            </p>
          )}
          <ImagePicker
            api={api}
            label={label}
            value={value}
            imagesOnly={imagesOnly}
            preference={preference}
            emptyLabel={emptyLabel}
            inheritedValue={inheritedValue}
            inheritedLabel={fallbackLabel}
            hasInheritance={hasInheritance}
            inheritedDescription={inheritedDescription}
            {...(hint ? { hint } : {})}
            onChoose={choose}
            onUpload={() => setUpload(true)}
            onPrepare={(source) => setPrepare(source)}
            onRefresh={() => setRevision((version) => version + 1)}
          />
        </Dialog>
      )}
      {upload && (
        <MediaUploadDialog
          api={api}
          writable={!disabled}
          imagesOnly={imagesOnly}
          {...(preference === 'mask' ? { format: 'svg' as const } : {})}
          onClose={() => setUpload(false)}
          onUploaded={(source) => {
            setUpload(false);
            if (preference === 'mask' && source.mimeType !== 'image/svg+xml') {
              setNotice('這個欄位只能選擇 SVG；媒體已保存，目前圖示沒有變更。');
              return;
            }
            if (imagesOnly && source.kind !== 'image') {
              setNotice(
                '這個欄位只能選擇圖片，影片已保存在媒體庫；目前圖片沒有變更。',
              );
              return;
            }
            setPrepare(source);
          }}
        />
      )}
      {prepare && (
        <ImagePreparationDialog
          api={api}
          source={prepare}
          preference={preference}
          onClose={() => {
            setPrepare(null);
            setRevision((version) => version + 1);
          }}
          onChoose={(path) => {
            setRevision((version) => version + 1);
            choose(path);
          }}
        />
      )}
    </div>
  );
}

function useImageSource(api: StudioApi, path: string | null, revision: number) {
  const [known, setKnown] = useState<{
    path: string;
    source: MediaSourceResource | null;
    error: unknown;
  } | null>(null);
  useEffect(() => {
    if (!path || !ManagedImagePathSchema.safeParse(path).success) return;
    const controller = new AbortController();
    void api
      .get<MediaSourceResource>(
        `/api/v1/media/sources/${path.split('/')[2] ?? ''}`,
        { signal: controller.signal },
      )
      .then(
        (response) => {
          if (!controller.signal.aborted)
            setKnown({ path, source: response.data, error: null });
        },
        (error) => {
          if (!controller.signal.aborted)
            setKnown((previous) => ({
              path,
              source: previous?.path === path ? previous.source : null,
              error,
            }));
        },
      );
    return () => controller.abort();
  }, [api, path, revision]);
  return known?.path === path ? known : { source: null, error: null };
}

function ImagePicker({
  api,
  label,
  value,
  imagesOnly,
  preference,
  emptyLabel,
  inheritedValue,
  inheritedLabel,
  inheritedDescription,
  hasInheritance,
  hint,
  onChoose,
  onUpload,
  onPrepare,
  onRefresh,
}: {
  api: StudioApi;
  label: string;
  value: string | null;
  imagesOnly: boolean;
  preference: ImagePreference | undefined;
  emptyLabel: string;
  inheritedValue: string | null;
  inheritedLabel: string;
  inheritedDescription: string;
  hasInheritance: boolean;
  hint?: string;
  onChoose: (value: string | null) => void;
  onUpload: () => void;
  onPrepare: (source: MediaSourceResource) => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const [candidate, setCandidate] = useState<MediaSourceResource | null>(null);
  const sources = useResource<Collection>(
    api,
    queryPath('media/sources', {
      q: applied,
      page,
      pageSize: 12,
      ...(imagesOnly ? { type: 'image' } : {}),
      ...(preference === 'mask' ? { format: 'svg' } : {}),
    }),
  );
  const items = (sources.response?.data.items ?? []).filter(
    (source) =>
      (!imagesOnly || source.kind === 'image') &&
      (preference !== 'mask' || source.mimeType === 'image/svg+xml'),
  );
  return (
    <div className="image-picker">
      {candidate ? (
        <>
          <button
            type="button"
            className="quiet image-picker__back"
            onClick={() => setCandidate(null)}
          >
            <Icon name="chevronLeft" />
            返回圖片列表
          </button>
          <ImageSizes
            source={candidate}
            value={value}
            preference={preference}
            onPrepare={() => onPrepare(candidate)}
            onChoose={onChoose}
            {...(hint ? { hint } : {})}
          />
        </>
      ) : (
        <>
          <p className="image-picker__intro">
            先選擇一張{imagesOnly ? '圖片' : '圖片或影片封面'}
            ，再選擇適合的尺寸。
          </p>
          {hint && <p className="muted image-picker__recommendation">{hint}</p>}
          <form
            className="image-select__search"
            onSubmit={(event) => {
              event.preventDefault();
              setApplied(query);
              setPage(1);
            }}
          >
            <input
              aria-label={`搜尋${label}`}
              type="search"
              value={query}
              maxLength={200}
              placeholder="搜尋圖片名稱"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit">
              <Icon name="search" />
              搜尋
            </button>
            <button
              type="button"
              onClick={() => {
                sources.reload();
                onRefresh();
              }}
            >
              <Icon name="refresh" />
              重新整理
            </button>
          </form>
          <ErrorNotice error={sources.error} />
          <div className="image-picker__status" role="status">
            {sources.loading ? '讀取圖片中…' : ''}
          </div>
          <button
            type="button"
            className="image-picker__default"
            disabled={sources.loading}
            onClick={() => onChoose(null)}
          >
            <Icon name={inheritedValue ? 'image' : 'close'} />
            <span>
              <strong>{emptyLabel}</strong>
              <small>
                {hasInheritance
                  ? `${inheritedLabel}：${inheritedDescription}`
                  : '不另外指定圖片'}
              </small>
            </span>
            {value === null && <Icon name="check" />}
          </button>
          <ul className="image-picker__grid" aria-label="圖片列表">
            {items.map((source) => {
              const outputs = selectableImageOutputs(source, preference);
              return (
                <li key={source.id}>
                  <button
                    type="button"
                    className="image-picker__card"
                    disabled={sources.loading}
                    aria-label={`${source.displayName}${source.kind === 'video' ? ' · 影片封面' : ''}`}
                    onClick={() =>
                      outputs.length ? setCandidate(source) : onPrepare(source)
                    }
                  >
                    <MediaThumbnail source={source} />
                    <span className="image-picker__card-body">
                      <strong>{source.displayName}</strong>
                      <small>
                        {outputs.length
                          ? `${outputs.length} 個尺寸${source.kind === 'video' ? ' · 影片封面' : ''}`
                          : '尚未產生網站圖片'}
                      </small>
                    </span>
                    {value?.split('/')[2] === source.id && (
                      <span className="image-picker__current">
                        <Icon name="check" />
                        目前使用
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {sources.response?.data.items.length === 0 && (
            <p className="empty-state">
              找不到符合條件的圖片，可以調整搜尋或上傳一張。
            </p>
          )}
          {sources.response && (
            <Pagination {...sources.response.data} onPage={setPage} />
          )}
          <div className="image-select__footer">
            <span className="muted">
              {imagesOnly ? '只顯示圖片' : '可使用圖片與影片封面'}
            </span>
            <button type="button" onClick={onUpload}>
              <Icon name="upload" />
              上傳新媒體
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ImageSizes({
  source,
  value,
  onChoose,
  hint,
  disabled = false,
  preference,
  onPrepare,
}: {
  source: MediaSourceResource;
  value: string | null;
  onChoose: (path: string) => void;
  hint?: string;
  disabled?: boolean;
  preference: ImagePreference | undefined;
  onPrepare: (() => void) | undefined;
}) {
  const groupId = useId();
  const outputs = [...selectableImageOutputs(source, preference)].sort(
    (left, right) => right.width - left.width || right.height - left.height,
  );
  const defaultPath =
    outputs.find((output) => output.publicPath === value)?.publicPath ??
    preferredImage(source, preference)?.publicPath ??
    outputs[0]?.publicPath ??
    '';
  const [chosen, setChosen] = useState(defaultPath);
  const active =
    outputs.find((output) => output.publicPath === chosen) ??
    outputs.find((output) => output.publicPath === defaultPath);
  return (
    <div className="image-picker__sizes">
      <div className="image-picker__large-preview">
        {active && (
          <img
            src={mediaFileUrl(active.publicPath)}
            alt={source.displayName}
            width={active.width}
            height={active.height}
          />
        )}
      </div>
      <div className="image-picker__size-controls">
        <h3>{source.displayName}</h3>
        {hint && <p className="muted">{hint}</p>}
        <p className="muted">
          {active?.publicPath.endsWith('/image-social-crop.webp')
            ? '裁切邊緣以填滿1200 × 630；較小原圖可能放大。'
            : active?.publicPath.endsWith('/image-social.webp')
              ? '完整保留原圖，以白色留白補齊1200 × 630。'
              : active?.publicPath.endsWith('/mask-icon.svg')
                ? '以單色剪影顯示，色彩由 Safari 圖示色彩設定決定。'
                : active?.publicPath.endsWith('/image.svg')
                  ? '保留向量圖形，可隨顯示尺寸縮放。'
                  : active?.publicPath.endsWith('/favicon.ico')
                    ? '使用已驗證的原生 ICO 圖示。'
                    : '保留圖片原比例，選擇一般尺寸不會裁切內容。'}
        </p>
        {onPrepare && needsPreferredImages(source, preference) && (
          <button type="button" onClick={onPrepare}>
            <Icon name="refresh" />
            {preference === 'mask'
              ? '產生 Safari pinned tab 圖示'
              : preference === 'favicon'
                ? '產生32 × 32圖示'
                : '產生1200 × 630分享尺寸'}
          </button>
        )}
        <fieldset disabled={disabled}>
          <legend>選擇圖片尺寸</legend>
          <div className="image-picker__radios">
            {outputs.map((output) => (
              <label key={output.publicPath}>
                <input
                  type="radio"
                  name={groupId}
                  value={output.publicPath}
                  checked={active?.publicPath === output.publicPath}
                  onChange={() => setChosen(output.publicPath)}
                />
                <span>
                  <strong>
                    {output.width} × {output.height}
                  </strong>
                  <small>
                    {imageSizeLabel(output.publicPath)} ·{' '}
                    {output.byteSize < 1024
                      ? `${output.byteSize} B`
                      : `${(output.byteSize / 1024).toFixed(1)} KB`}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <button
          type="button"
          className="primary"
          disabled={disabled || !active}
          onClick={() => {
            if (active) onChoose(active.publicPath);
          }}
        >
          <Icon name="check" />
          使用這個尺寸
        </button>
      </div>
    </div>
  );
}

function ImagePreparationDialog({
  api,
  source,
  onClose,
  onChoose,
  preference,
}: {
  api: StudioApi;
  source: MediaSourceResource;
  onClose: () => void;
  onChoose: (path: string) => void;
  preference: ImagePreference | undefined;
}) {
  const command = useCommand(api);
  const [jobId, setJobId] = useState<string | null>(null);
  const [ready, setReady] = useState<MediaSourceResource | null>(
    source.asset && !needsPreferredImages(source, preference) ? source : null,
  );
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState('');
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const setProcessingBlocked = useCallback(
    (value: boolean) => setBlocked(value),
    [],
  );
  const completed = useCallback(
    async (job: Job) => {
      if (job.status !== 'succeeded') return;
      try {
        setReady(
          (
            await api.get<MediaSourceResource>(
              `/api/v1/media/sources/${source.id}`,
            )
          ).data,
        );
        setRefreshError(null);
      } catch (error) {
        setRefreshError(error);
        throw error;
      }
    },
    [api, source.id],
  );
  const pending = command.pending !== null || blocked;
  useEffect(() => {
    if (!pending && !command.busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending, command.busy]);
  const process = async () => {
    try {
      await command.run<Job>(
        {
          label: '準備圖片',
          method: 'POST',
          path: '/api/v1/media-jobs',
          body: {
            sourceId: source.id,
            preset:
              preference === 'mask'
                ? 'site-icons'
                : source.kind === 'image'
                  ? 'article-image'
                  : 'article-video',
          },
          idempotencyKey: newKey(),
        },
        (response) => setJobId(response.data.id),
      );
    } catch {
      /* Preserve the same request for an explicit retry. */
    }
  };
  return (
    <Dialog
      open
      title="處理與選擇圖片"
      className="image-prepare-dialog"
      closeDisabled={command.busy}
      onClose={() => {
        if (pending) {
          setNotice('操作結果尚未確認，請先完成重送或結束重送紀錄。');
          return;
        }
        onClose();
      }}
    >
      <p>
        <strong>{source.displayName}</strong> · {source.width} × {source.height}
      </p>
      <p className="muted">
        準備完成後就能選擇尺寸，這裡的操作不會關閉正在編輯的文章。
      </p>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <RetryNotice api={api} command={command} />
      <ErrorNotice error={refreshError} />
      {!ready && !jobId && (
        <button
          className="primary"
          disabled={command.busy || pending}
          onClick={() => void process()}
        >
          <Icon name="refresh" />
          處理媒體
        </button>
      )}
      {jobId && (
        <MediaJobProgress
          key={jobId}
          api={api}
          id={jobId}
          onCompleted={completed}
          onBlocked={setProcessingBlocked}
        />
      )}
      {ready && (
        <ImageSizes
          source={ready}
          value={null}
          preference={preference}
          onPrepare={undefined}
          disabled={pending || command.busy}
          onChoose={onChoose}
        />
      )}
      {jobId && !ready && (
        <p className="muted">
          若準備失敗，可關閉視窗後再次嘗試；詳細紀錄會保留在「網站更新與工作」。
        </p>
      )}
    </Dialog>
  );
}
