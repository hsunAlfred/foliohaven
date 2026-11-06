import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { MediaSourceResource } from '@foliohaven/core';
import { isAborted, newKey } from './api.js';
import { Icon } from './Icon.js';
import type { StudioApi } from './api.js';
import { Dialog } from './Dialog.js';
import { ErrorNotice, Field, TextField } from './components.js';
import {
  canPreviewMediaUpload,
  matchesMediaUploadFormat,
  mediaUploadAccept,
  mediaUploadFile,
} from './media-display.js';
import type { MediaFileFormat } from './media-display.js';

interface UploadActivity {
  dirty: boolean;
  busy: boolean;
  pending: boolean;
}

export function MediaUploadDialog({
  api,
  writable,
  onClose,
  onUploaded,
  onDirty,
  imagesOnly = false,
  format,
}: {
  api: StudioApi;
  writable: boolean;
  onClose: () => void;
  onUploaded: (source: MediaSourceResource) => void;
  onDirty?: (value: boolean) => void;
  imagesOnly?: boolean;
  format?: MediaFileFormat;
}) {
  const [activity, setActivity] = useState<UploadActivity>({
    dirty: false,
    busy: false,
    pending: false,
  });
  const [notice, setNotice] = useState('');
  const activityChanged = useCallback((next: UploadActivity) => {
    setActivity(next);
  }, []);
  useEffect(() => {
    onDirty?.(activity.dirty || activity.busy || activity.pending);
  }, [activity.dirty, activity.busy, activity.pending, onDirty]);
  useEffect(() => {
    if (!activity.dirty && !activity.busy && !activity.pending) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [activity.dirty, activity.busy, activity.pending]);
  const close = () => {
    if (activity.busy) return;
    if (activity.pending) {
      setNotice('上傳結果尚未確認。請先重試上傳，或選擇結束重試後再關閉。');
      return;
    }
    if (
      activity.dirty &&
      !window.confirm('尚未上傳的檔案與設定將被捨棄。確認關閉？')
    )
      return;
    onDirty?.(false);
    onClose();
  };
  return (
    <Dialog
      open
      title="上傳媒體"
      onClose={close}
      closeDisabled={activity.busy}
      className="media-upload-dialog"
    >
      <p className="muted">
        {format
          ? `選擇一張 ${format.toUpperCase()} 圖片，上傳後就能準備網站使用的版本。`
          : imagesOnly
            ? '選擇一張圖片，上傳後就能準備網站使用的尺寸。'
            : '選擇一個圖片或影片，上傳後就能準備網站使用的版本。'}
      </p>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <MediaUpload
        api={api}
        writable={writable}
        imagesOnly={imagesOnly}
        format={format}
        onActivity={activityChanged}
        onUploaded={(source) => {
          onDirty?.(false);
          onUploaded(source);
        }}
      />
    </Dialog>
  );
}

function MediaUpload({
  api,
  writable,
  onActivity,
  onUploaded,
  imagesOnly,
  format,
}: {
  api: StudioApi;
  writable: boolean;
  onActivity: (activity: UploadActivity) => void;
  imagesOnly: boolean;
  format: MediaFileFormat | undefined;
  onUploaded: (source: MediaSourceResource) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const previewRef = useRef<string | null>(null);
  const [name, setName] = useState('');
  const [poster, setPoster] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState<{
    body: FormData;
    key: string;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // 關閉守門必須在上傳／重試介面可互動前同步，不能晚於畫面一個 effect。
  useLayoutEffect(() => {
    onActivity({ dirty: file !== null, busy, pending: attempt !== null });
  }, [file, busy, attempt, onActivity]);
  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );
  const clearPreview = () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
    setDuration(null);
  };
  const upload = async (retry = false) => {
    if (inFlight.current || (!file && !attempt)) return;
    let current = retry ? attempt : null;
    if (!current) {
      if (!file) return;
      const body = new FormData();
      body.set('file', mediaUploadFile(file));
      if (name) body.set('displayName', name);
      if (poster !== '') body.set('posterTimeSeconds', poster);
      current = { body, key: newKey() };
      setAttempt(current);
    }
    inFlight.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const result = await api.send<MediaSourceResource>(
        'POST',
        '/api/v1/media/sources',
        current.body,
        {
          idempotencyKey: current.key,
          signal: abort.signal,
        },
      );
      setAttempt(null);
      setFile(null);
      setName('');
      setPoster('');
      clearPreview();
      if (input.current) input.current.value = '';
      onUploaded(result.data);
    } catch (failure) {
      setError(failure);
      if (isAborted(failure))
        setMessage('上傳連線已取消。可先檢查媒體清單，或重試這次上傳。');
    } finally {
      inFlight.current = false;
      setBusy(false);
      controller.current = null;
    }
  };
  const isVideo =
    file !== null &&
    (file.type.startsWith('video/') || /\.(?:mp4|mov|webm)$/iu.test(file.name));
  const posterHint =
    duration === null
      ? '上傳並讀取片長後顯示預設擷取時間。'
      : `留白時預設在約 ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 3 }).format(Math.min(1, duration / 2))} 秒擷取封面（以可用影格為準）。`;
  return (
    <div className="media-upload">
      <fieldset disabled={!writable || busy || attempt !== null}>
        <legend>選擇檔案</legend>
        <Field label="選擇媒體檔案">
          <input
            ref={input}
            type="file"
            accept={mediaUploadAccept(imagesOnly, format)}
            onChange={(event) => {
              clearPreview();
              const selected = event.target.files?.[0] ?? null;
              if (selected && !matchesMediaUploadFormat(selected, format)) {
                setFile(null);
                setPoster('');
                setError(null);
                setMessage(`這裡只能上傳 ${format?.toUpperCase()} 圖片。`);
                event.target.value = '';
                return;
              }
              if (
                imagesOnly &&
                selected &&
                (selected.type.startsWith('video/') ||
                  /\.(?:mp4|mov|webm)$/iu.test(selected.name))
              ) {
                setFile(null);
                setPoster('');
                setError(null);
                setMessage(
                  '這裡只能上傳圖片，請選擇JPEG、PNG、WebP、AVIF、SVG或ICO檔案。',
                );
                event.target.value = '';
                return;
              }
              setFile(selected);
              if (selected && !selected.type.startsWith('video/'))
                setPoster('');
              setError(null);
              setMessage('');
              if (selected && canPreviewMediaUpload(selected)) {
                const url = URL.createObjectURL(selected);
                previewRef.current = url;
                setPreview(url);
              }
            }}
          />
        </Field>
        {file && !canPreviewMediaUpload(file) && (
          <p className="muted">SVG 與 ICO 會在上傳並通過檢查後提供預覽。</p>
        )}
        {preview && (
          <div className="media-upload__preview">
            {isVideo ? (
              <video
                src={preview}
                controls
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const value = event.currentTarget.duration;
                  setDuration(
                    Number.isFinite(value) && value > 0 ? value : null,
                  );
                }}
              />
            ) : (
              <img src={preview} alt="待上傳圖片預覽" />
            )}
          </div>
        )}
        <div className="form-grid">
          <TextField
            label="上傳顯示名稱（選填）"
            value={name}
            maxLength={200}
            width="wide"
            onChange={(value) => setName(value ?? '')}
          />
          {!imagesOnly && (
            <TextField
              label="Poster 秒數（選填）"
              hint={posterHint}
              value={poster}
              type="number"
              width="short"
              disabled={file !== null && !isVideo}
              onChange={(value) => setPoster(value ?? '')}
            />
          )}
        </div>
        <p className="muted media-upload__limits">
          圖片：
          {format ? format.toUpperCase() : 'JPEG、PNG、WebP、AVIF、SVG、ICO'}
          ，最多25 MiB。
          {!imagesOnly && '影片：MP4、MOV、WebM，最多512 MiB，長度10分鐘。'}
        </p>
        <button
          className="primary"
          disabled={!file}
          onClick={() => void upload()}
        >
          <Icon name="upload" />
          上傳媒體
        </button>
      </fieldset>
      {busy && (
        <div className="notice">
          <p role="status">上傳與檔案檢查中…</p>
          <progress aria-label="上傳與檢測進度" />
          <button onClick={() => controller.current?.abort()}>
            <Icon name="close" />
            取消上傳
          </button>
        </div>
      )}
      <ErrorNotice error={isAborted(error) ? null : error} />
      {message && <p role="status">{message}</p>}
      {attempt && !busy && (
        <section className="notice">
          <p>會保留原始檔案繼續這次上傳，避免建立重複媒體。</p>
          <details>
            <summary>操作詳細資料</summary>
            <code>{attempt.key}</code>
          </details>
          <div className="actions">
            <button disabled={!writable} onClick={() => void upload(true)}>
              重試上傳
            </button>
            <button
              onClick={() => {
                if (
                  window.confirm(
                    '結束重試不會撤銷可能已完成的上傳。請先檢查媒體清單；確定結束重試？',
                  )
                )
                  setAttempt(null);
              }}
            >
              結束上傳重試
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
