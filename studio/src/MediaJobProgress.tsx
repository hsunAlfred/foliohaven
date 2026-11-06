import { Icon } from './Icon.js';
import { useEffect, useRef, useState } from 'react';
import type { Job } from '@foliohaven/core';
import type { StudioApi } from './api.js';
import { useCommand, usePolling } from './hooks.js';
import { ErrorNotice, RetryNotice } from './components.js';

const activeJob = (job: Job) =>
  job.status === 'queued' || job.status === 'running';
const statuses: Record<Job['status'], string> = {
  queued: '排隊中',
  running: '處理中',
  succeeded: '處理完成',
  failed: '處理失敗',
  cancelled: '已取消',
  interrupted: '已中斷',
};

export function MediaJobProgress({
  api,
  id,
  onCompleted,
  onBlocked,
  onViewJob,
}: {
  api: StudioApi;
  id: string;
  onCompleted: (job: Job) => void | Promise<void>;
  onBlocked: (blocked: boolean) => void;
  onViewJob?: (job: Job) => void;
}) {
  const resource = usePolling<Job>(api, `/api/v1/jobs/${id}`, activeJob);
  const command = useCommand(api);
  const [completionError, setCompletionError] = useState<unknown>(null);
  const completed = useRef<string | null>(null);
  const job = resource.response?.data;
  useEffect(() => {
    onBlocked(command.busy || command.pending !== null);
  }, [command.busy, command.pending, onBlocked]);
  useEffect(() => {
    if (
      !job ||
      activeJob(job) ||
      completed.current === `${job.id}:${job.status}`
    )
      return;
    completed.current = `${job.id}:${job.status}`;
    void Promise.resolve(onCompleted(job)).catch(setCompletionError);
  }, [job, onCompleted]);
  const cancel = async () => {
    if (!window.confirm('確定取消處理？已完成的圖片或影片會保留。')) return;
    try {
      await command.run<Job>(
        {
          label: '取消媒體處理',
          method: 'PUT',
          path: `/api/v1/jobs/${id}/cancellation`,
          body: { requested: true },
        },
        () => resource.reload(),
      );
    } catch {
      /* The original request and error remain visible. */
    }
  };
  return (
    <section className="media-job notice" aria-label="媒體處理進度">
      <ErrorNotice error={resource.error} />
      <ErrorNotice error={completionError} />
      <RetryNotice command={command} api={api} />
      {job ? (
        <>
          <strong role="status">{statuses[job.status]}</strong>
          {activeJob(job) && (
            <span className="muted">
              {job.stage === 'images'
                ? '產生圖片尺寸'
                : job.stage === 'encoding-video'
                  ? '轉換影片'
                  : job.stage === 'video'
                    ? '產生影片與封面'
                    : '準備媒體'}
            </span>
          )}
          {activeJob(job) && (
            <progress
              aria-label="媒體處理進度"
              {...(job.progress.total === null
                ? {}
                : {
                    value: job.progress.completed,
                    max: Math.max(1, job.progress.total),
                  })}
            />
          )}
          {job.error && (
            <div role="alert">
              <p>{job.error.message}</p>
              <details>
                <summary>查看錯誤詳情</summary>
                <code>{job.error.code}</code>
              </details>
              {job.error.issues.length > 0 && (
                <ul>
                  {job.error.issues.map((issue, index) => (
                    <li key={index}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="actions">
            {activeJob(job) && (
              <button
                disabled={command.busy || command.pending !== null}
                onClick={() => void cancel()}
              >
                <Icon name="close" />
                取消媒體處理
              </button>
            )}
            {onViewJob && (
              <button
                disabled={command.busy || command.pending !== null}
                onClick={() => onViewJob(job)}
              >
                <Icon name="eye" />
                查看工作
              </button>
            )}
            {job.status === 'succeeded' && completionError !== null && (
              <button
                onClick={() => {
                  setCompletionError(null);
                  void Promise.resolve(onCompleted(job)).catch(
                    setCompletionError,
                  );
                }}
              >
                <Icon name="refresh" />
                重新載入處理結果
              </button>
            )}
          </div>
          <details>
            <summary>疑難排解資料</summary>
            <code>{job.id}</code>
          </details>
        </>
      ) : (
        <p role="status">讀取處理進度中…</p>
      )}
    </section>
  );
}
