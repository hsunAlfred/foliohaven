import { Icon } from './Icon.js';
import { useCallback, useEffect, useState } from 'react';
import { MediaSourceUpdateSchema } from '@foliohaven/core';
import type { Job, MediaSourceResource } from '@foliohaven/core';
import { ApiFailure, newKey, queryPath } from './api.js';
import type { ApiResponse, StudioApi } from './api.js';
import { useCommand, useResource } from './hooks.js';
import { mediaMarkup } from './media-markup.js';
import { Dialog } from './Dialog.js';
import { MediaUploadDialog } from './MediaUpload.js';
import { MediaJobProgress } from './MediaJobProgress.js';
import {
  imageSizeLabel,
  mediaFileUrl,
  nativeImage,
  primaryImage,
} from './media-display.js';
import { MediaThumbnail } from './MediaThumbnail.js';
import { ResourceHeading } from './ResourceHeading.js';
import './media.css';
import {
  Conflict,
  ErrorNotice,
  Field,
  Pagination,
  RetryNotice,
  TextField,
} from './components.js';

interface Collection {
  items: MediaSourceResource[];
  total: number;
  page: number;
  pageSize: number;
}
export function MediaView({
  api,
  writable,
  onDirty,
  onChanged,
  onJob,
}: {
  api: StudioApi;
  writable: boolean;
  onDirty: (value: boolean) => void;
  onChanged: () => void;
  onJob: (job: Job) => void;
}) {
  const [filters, setFilters] = useState({ q: '', type: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadDirty, setUploadDirty] = useState(false);
  const [detailDirty, setDetailDirty] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailPending, setDetailPending] = useState(false);
  const [closeNotice, setCloseNotice] = useState('');
  useEffect(() => {
    onDirty(uploadDirty || detailDirty || detailBusy || detailPending);
  }, [uploadDirty, detailDirty, detailBusy, detailPending, onDirty]);
  const closeDetail = () => {
    if (detailBusy) return;
    if (detailPending) {
      setCloseNotice('操作結果尚未確認。請先重送原請求，或明確結束重送紀錄。');
      return;
    }
    if (
      detailDirty &&
      !window.confirm('媒體設定尚未保存。確認捨棄設定並關閉？')
    )
      return;
    setDetailDirty(false);
    setSelected(null);
    setCloseNotice('');
  };
  const select = (id: string) => {
    setDetailDirty(false);
    setCloseNotice('');
    setSelected(id);
  };
  const sources = useResource<Collection>(
    api,
    queryPath('media/sources', { ...applied, page, pageSize: 20 }),
  );
  return (
    <section>
      <div className="section-heading">
        <div>
          <ResourceHeading
            title="媒體庫"
            icon="image"
            loading={sources.loading}
            loadingLabel="讀取媒體中…"
          />
          <p className="muted">管理網站圖片與影片，點選縮圖查看設定和引用。</p>
        </div>
        <button
          className="primary"
          disabled={!writable}
          onClick={() => setUploadOpen(true)}
        >
          <Icon name="upload" />
          上傳媒體
        </button>
      </div>
      {uploadOpen && (
        <MediaUploadDialog
          api={api}
          writable={writable}
          onDirty={setUploadDirty}
          onClose={() => {
            setUploadOpen(false);
            setUploadDirty(false);
          }}
          onUploaded={(source) => {
            setUploadOpen(false);
            setUploadDirty(false);
            select(source.id);
            sources.reload();
            onChanged();
          }}
        />
      )}
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(filters);
          setPage(1);
        }}
      >
        <Field label="媒體關鍵字" width="medium">
          <input
            value={filters.q}
            maxLength={200}
            onChange={(event) =>
              setFilters({ ...filters, q: event.target.value })
            }
          />
        </Field>
        <Field label="媒體種類" width="short">
          <select
            value={filters.type}
            onChange={(event) =>
              setFilters({ ...filters, type: event.target.value })
            }
          >
            <option value="">全部</option>
            <option value="image">圖片</option>
            <option value="video">影片</option>
          </select>
        </Field>
        <button type="submit">
          <Icon name="search" />
          查詢媒體
        </button>
        <button type="button" onClick={sources.reload}>
          <Icon name="refresh" />
          重新讀取媒體
        </button>
      </form>
      <ErrorNotice error={sources.error} />
      {sources.response?.data.items.length === 0 && (
        <p>尚無符合條件的媒體，可上傳單一圖片或影片。</p>
      )}
      <ul className="media-grid">
        {sources.response?.data.items.map((source) => (
          <li key={source.id}>
            <button
              className="media-card"
              onClick={() => select(source.id)}
              aria-label={source.displayName}
            >
              <MediaThumbnail source={source} />
              <span className="media-card__body">
                <strong>{source.displayName}</strong>
                <span>
                  {source.width} × {source.height}{' '}
                  <span aria-hidden="true">·</span>{' '}
                  {(source.byteSize / 1024 / 1024).toFixed(2)} MiB
                </span>
                <span
                  className={`media-card__state ${source.asset ? 'is-ready' : ''}`}
                >
                  {source.asset ? '可引用' : '等待處理'}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {sources.response && (
        <Pagination {...sources.response.data} onPage={setPage} />
      )}
      {selected && (
        <MediaDetail
          key={selected}
          api={api}
          id={selected}
          writable={writable}
          onDirty={setDetailDirty}
          onBusy={setDetailBusy}
          onPending={setDetailPending}
          closeDisabled={detailBusy}
          closeNotice={closeNotice}
          onClose={closeDetail}
          onJob={onJob}
          onChanged={() => {
            sources.reload();
            onChanged();
          }}
          onRemoved={() => {
            setSelected(null);
            sources.reload();
            setDetailDirty(false);
            setDetailBusy(false);
            setDetailPending(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
function MediaDetail({
  api,
  id,
  writable,
  onDirty,
  onChanged,
  onRemoved,
  onJob,
  onBusy,
  onPending,
  onClose,
  closeDisabled,
  closeNotice,
}: {
  api: StudioApi;
  id: string;
  writable: boolean;
  onDirty: (value: boolean) => void;
  onChanged: () => void;
  onRemoved: () => void;
  onJob: (job: Job) => void;
  onBusy: (value: boolean) => void;
  onPending: (value: boolean) => void;
  onClose: () => void;
  closeDisabled: boolean;
  closeNotice: string;
}) {
  const resource = useResource<MediaSourceResource>(
    api,
    `/api/v1/media/sources/${id}`,
  );
  return (
    <Dialog
      open
      title="媒體設定與引用"
      className="media-detail-dialog"
      onClose={onClose}
      closeDisabled={closeDisabled}
    >
      {closeNotice && (
        <p className="notice" role="status">
          {closeNotice}
        </p>
      )}
      <ErrorNotice error={resource.error} />
      {Boolean(resource.error) && (
        <button onClick={resource.reload}>
          <Icon name="refresh" />
          重新讀取資料
        </button>
      )}
      {resource.response ? (
        <MediaForm
          api={api}
          initial={resource.response}
          writable={writable}
          onDirty={onDirty}
          onChanged={onChanged}
          onRemoved={onRemoved}
          onJob={onJob}
          onBusy={onBusy}
          onPending={onPending}
        />
      ) : (
        <p role="status">讀取媒體資料中…</p>
      )}
    </Dialog>
  );
}
function MediaForm({
  api,
  initial,
  writable,
  onDirty,
  onChanged,
  onRemoved,
  onJob,
  onBusy,
  onPending,
}: {
  api: StudioApi;
  initial: ApiResponse<MediaSourceResource>;
  writable: boolean;
  onDirty: (value: boolean) => void;
  onChanged: () => void;
  onRemoved: () => void;
  onJob: (job: Job) => void;
  onBusy: (value: boolean) => void;
  onPending: (value: boolean) => void;
}) {
  const [base, setBase] = useState(initial);
  const [name, setName] = useState(initial.data.displayName);
  const [poster, setPoster] = useState(
    initial.data.posterTimeSeconds?.toString() ?? '',
  );
  const [alt, setAlt] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [validation, setValidation] = useState<unknown>(null);
  const [conflict, setConflict] =
    useState<ApiResponse<MediaSourceResource> | null>(null);
  const command = useCommand(api);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobActive, setJobActive] = useState(false);
  const [jobBlocked, setJobBlocked] = useState(false);
  const [saved, setSaved] = useState('');
  const blockJob = useCallback((value: boolean) => setJobBlocked(value), []);
  useEffect(() => onBusy(command.busy), [command.busy, onBusy]);
  useEffect(
    () => onPending(command.pending !== null || jobBlocked),
    [command.pending, jobBlocked, onPending],
  );
  const source = base.data;
  const jobCompleted = useCallback(
    async (job: Job) => {
      setJobActive(false);
      if (job.status === 'succeeded') {
        const response = await api.get<MediaSourceResource>(
          `/api/v1/media/sources/${initial.data.id}`,
        );
        setBase(response);
        onChanged();
      }
    },
    [api, initial.data.id, onChanged],
  );
  const dirty =
    name !== source.displayName ||
    poster !== (source.posterTimeSeconds?.toString() ?? '');
  const adopt = (response: ApiResponse<MediaSourceResource>) => {
    setBase(response);
    setName(response.data.displayName);
    setPoster(response.data.posterTimeSeconds?.toString() ?? '');
    setConflict(null);
    onDirty(false);
  };
  const save = async () => {
    setValidation(null);
    let body;
    try {
      body = MediaSourceUpdateSchema.parse({
        displayName: name,
        ...(poster === '' ? {} : { posterTimeSeconds: Number(poster) }),
      });
    } catch (error) {
      setValidation(error);
      return;
    }
    try {
      await command.run<MediaSourceResource>(
        {
          label: '保存媒體設定',
          method: 'PUT',
          path: `/api/v1/media/sources/${source.id}`,
          body,
          ...(base.etag ? { etag: base.etag } : {}),
        },
        (response) => {
          adopt(response);
          setSaved('媒體設定已保存。');
          onChanged();
        },
      );
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 412) {
        try {
          setConflict(
            await api.get<MediaSourceResource>(
              `/api/v1/media/sources/${source.id}`,
            ),
          );
        } catch (current) {
          setValidation(current);
        }
      }
    }
  };
  const process = async () => {
    try {
      await command.run<Job>(
        {
          label: '處理媒體',
          method: 'POST',
          path: '/api/v1/media-jobs',
          body: {
            sourceId: source.id,
            preset: source.kind === 'image' ? 'article-image' : 'article-video',
          },
          idempotencyKey: newKey(),
        },
        (response) => {
          setJobActive(true);
          setJobId(response.data.id);
        },
      );
    } catch {
      /* Retain idempotency evidence and settings. */
    }
  };
  const remove = async () => {
    if (
      !window.confirm(
        '確定將這個媒體移至垃圾桶？仍被文章或頁面使用的媒體無法移除。',
      )
    )
      return;
    try {
      await command.run(
        {
          label: '刪除媒體',
          method: 'DELETE',
          path: `/api/v1/media/sources/${source.id}`,
          ...(base.etag ? { etag: base.etag } : {}),
        },
        () => onRemoved(),
      );
    } catch {
      /* Conflict or reference errors remain visible. */
    }
  };
  const markup = source.asset ? mediaMarkup(source.asset, alt) : '';
  const image = primaryImage(source);
  const native = nativeImage(source);
  const copy = (text: string, label: string) => {
    if (!navigator.clipboard) {
      setCopyStatus(`無法自動複製，請選取${label}手動複製。`);
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => setCopyStatus(`${label}已複製。`),
      () => setCopyStatus(`無法自動複製，請選取${label}手動複製。`),
    );
  };
  return (
    <>
      <ErrorNotice error={validation} />
      <RetryNotice api={api} command={command} />
      {conflict && (
        <Conflict
          base={base.data}
          local={{ displayName: name, posterTimeSeconds: poster }}
          current={conflict.data}
          onKeepLocal={() => {
            setBase(conflict);
            setConflict(null);
            command.clear();
            onDirty(true);
          }}
          onReload={() => {
            if (window.confirm('捨棄未保存的設定，改用目前已保存的版本？'))
              adopt(conflict);
          }}
        />
      )}
      <div className="media-detail">
        <div className="media-detail__visual">
          {source.kind === 'video' && source.asset ? (
            <video
              controls
              className="media-detail__preview"
              src={`/api/v1/media/files/${source.id}/video.webm`}
              poster={image ? mediaFileUrl(image.publicPath) : undefined}
            />
          ) : image ? (
            <img
              className="media-detail__preview"
              alt="媒體處理預覽"
              src={mediaFileUrl(image.publicPath)}
              width={image.width}
              height={image.height}
            />
          ) : (
            <div className="media-detail__empty">
              <span aria-hidden="true">
                {source.kind === 'video' ? '▷' : '▧'}
              </span>
              <strong>等待處理</strong>
              <p>處理後會產生網站使用的圖片、影片與預覽。</p>
            </div>
          )}
          <dl className="media-facts">
            <div>
              <dt>格式</dt>
              <dd>
                {
                  (
                    {
                      'image/jpeg': 'JPEG',
                      'image/png': 'PNG',
                      'image/webp': 'WebP',
                      'image/avif': 'AVIF',
                      'image/svg+xml': 'SVG',
                      'image/x-icon': 'ICO',
                      'video/mp4': 'MP4',
                      'video/quicktime': 'MOV',
                      'video/webm': 'WebM',
                    } as const
                  )[source.mimeType]
                }
              </dd>
            </div>
            <div>
              <dt>尺寸</dt>
              <dd>
                {source.width} × {source.height}
              </dd>
            </div>
            <div>
              <dt>原檔大小</dt>
              <dd>{(source.byteSize / 1024 / 1024).toFixed(2)} MiB</dd>
            </div>
            {source.durationSeconds !== null && (
              <div>
                <dt>片長</dt>
                <dd>{source.durationSeconds} 秒</dd>
              </div>
            )}
          </dl>
          <details>
            <summary>疑難排解資料</summary>
            <code>{source.id}</code>
          </details>
        </div>
        <div className="media-detail__controls">
          <fieldset
            disabled={
              !writable ||
              command.busy ||
              command.pending !== null ||
              jobBlocked ||
              jobActive
            }
          >
            <legend>媒體設定</legend>
            <TextField
              label="媒體顯示名稱"
              value={name}
              maxLength={200}
              width="full"
              onChange={(value) => {
                setName(value ?? '');
                setSaved('');
                onDirty(
                  (value ?? '') !== source.displayName ||
                    poster !== (source.posterTimeSeconds?.toString() ?? ''),
                );
              }}
            />
            {source.kind === 'video' && (
              <TextField
                label="Poster 秒數"
                hint={
                  source.durationSeconds === null
                    ? '讀取影片後會顯示預設封面時間。'
                    : `留白時預設在約 ${Math.min(1, source.durationSeconds / 2).toLocaleString('zh-TW', { maximumFractionDigits: 3 })} 秒擷取封面（以可用影格為準）。`
                }
                type="number"
                value={poster}
                width="short"
                onChange={(value) => {
                  setPoster(value ?? '');
                  setSaved('');
                  onDirty(
                    name !== source.displayName ||
                      (value ?? '') !==
                        (source.posterTimeSeconds?.toString() ?? ''),
                  );
                }}
              />
            )}
            <div className="actions">
              <button
                className="primary"
                disabled={!dirty}
                onClick={() => void save()}
              >
                <Icon name="save" />
                保存媒體設定
              </button>
              <button disabled={dirty} onClick={() => void process()}>
                <Icon name="image" />
                處理媒體
              </button>
            </div>
            <p className="muted">
              {dirty
                ? '請先保存設定，再處理成網站版本。'
                : '處理媒體會產生網站使用的格式與尺寸。'}
            </p>
          </fieldset>
          {saved && <p role="status">{saved}</p>}
          {jobId && (
            <MediaJobProgress
              key={jobId}
              api={api}
              id={jobId}
              onCompleted={jobCompleted}
              onBlocked={blockJob}
              onViewJob={(job) => {
                if (
                  dirty &&
                  !window.confirm('媒體設定尚未保存。確認捨棄並查看工作？')
                )
                  return;
                onDirty(false);
                onJob(job);
              }}
            />
          )}
          {source.asset ? (
            <section className="media-references">
              <h3>文章引用</h3>
              {source.kind === 'image' && (
                <>
                  <TextField
                    label="此次圖片引用的 Alt"
                    value={alt}
                    multiline
                    rows={2}
                    width="full"
                    onChange={(value) => setAlt(value ?? '')}
                  />
                  <p className="muted">
                    Alt
                    屬於每次引用；裝飾圖可留空。精選圖及分享圖請在對應欄位直接選擇。
                  </p>
                </>
              )}
              <Field label="可複製媒體 HTML">
                <textarea readOnly value={markup} rows={4} />
              </Field>
              <button onClick={() => copy(markup, 'HTML 引用')}>
                <Icon name="copy" />
                複製媒體 HTML
              </button>
              {image && (
                <div className="media-reference-path">
                  <span>
                    {source.kind === 'image' ? '圖片引用' : 'Poster 引用'}
                  </span>
                  <code>{image.publicPath}</code>
                  <button onClick={() => copy(image.publicPath, '圖片路徑')}>
                    <Icon name="link" />
                    複製圖片路徑
                  </button>
                </div>
              )}
              {native && (
                <div className="media-reference-path">
                  <span>{imageSizeLabel(native.publicPath)}</span>
                  <code>{native.publicPath}</code>
                  <button
                    onClick={() => copy(native.publicPath, '原生圖片路徑')}
                  >
                    <Icon name="link" />
                    複製原生圖片路徑
                  </button>
                </div>
              )}
              {copyStatus && <p role="status">{copyStatus}</p>}
            </section>
          ) : (
            <p className="notice">
              這個媒體還不能使用，或設定剛剛有變更。請按「處理媒體」取得可用版本。
            </p>
          )}
          <details className="media-danger">
            <summary>移除媒體</summary>
            <p className="muted">仍被文章、設定或頁面引用的媒體不能移除。</p>
            <button
              className="danger"
              disabled={
                !writable ||
                command.busy ||
                command.pending !== null ||
                jobBlocked ||
                jobActive
              }
              onClick={() => void remove()}
            >
              <Icon name="trash" />
              刪除媒體
            </button>
          </details>
        </div>
      </div>
    </>
  );
}
