import { Icon } from './Icon.js';
import { ResourceHeading } from './ResourceHeading.js';
import { useEffect, useRef, useState } from 'react';
import { CurrentArtifactSchema, JobRetryInputSchema } from '@foliohaven/core';
import type { CurrentArtifact, Job, Workspace } from '@foliohaven/core';
import type { TaxonomyRetry } from './retry.js';
import type { StudioApi } from './api.js';
import { newKey, queryPath } from './api.js';
import { useCommand, usePolling } from './hooks.js';
import {
  Diagnostics,
  ErrorNotice,
  Field,
  Pagination,
  RetryNotice,
} from './components.js';
import { Dialog } from './Dialog.js';
import './jobs-recoveries.css';

interface Collection {
  items: Job[];
  total: number;
  page: number;
  pageSize: number;
}
const activeJob = (job: Job) =>
  job.status === 'running' || job.status === 'queued';
const activeCollection = (value: Collection) => value.items.some(activeJob);
const artifactNeedsAttention = (value: CurrentArtifact) =>
  value.recoveryState === 'recovery-required';
const statuses: Readonly<Record<Job['status'], string>> = {
  queued: '排隊中',
  running: '執行中',
  succeeded: '成功',
  failed: '失敗',
  cancelled: '已取消',
  interrupted: '已中斷',
};
const types: Readonly<Record<Job['type'], string>> = {
  build: '網站更新',
  media: '媒體處理',
  taxonomy: '分類／Tag 網址調整',
};
const stages: Readonly<Record<string, string>> = {
  ...statuses,
  starting: '準備開始',
  completed: '已完成',
  'snapshot-inputs': '整理保存的內容',
  'offline-dependencies': '準備更新內容',
  rendering: '產生網站頁面',
  verifying: '檢查頁面與連結',
  'preparing-promotion': '套用更新',
  images: '產生圖片版本',
  'encoding-video': '轉換影片',
  video: '完成影片與封面',
  'planning-migration': '檢查分類與 Tag 網址',
};
function progressLabel(job: Job): string {
  const { completed, total } = job.progress;
  if (job.status === 'succeeded' && (total === null || total === 0))
    return '已完成';
  if (total !== null) return `${completed}／${total}`;
  if (job.status === 'queued') return '等待開始';
  if (job.status === 'running') return '正在估計工作量';
  return '未提供進度數字';
}
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
function JobTime({ value, empty }: { value: string | null; empty: string }) {
  return value ? (
    <time dateTime={value} title={value}>
      {dateLabel(value)}
    </time>
  ) : (
    <span className="muted">{empty}</span>
  );
}
export function JobsView({
  api,
  workspace,
  initialId,
  onChanged,
  onRetryTaxonomy,
  onDirty,
  onSelected,
}: {
  api: StudioApi;
  workspace: Workspace | null;
  initialId: string | null;
  onChanged: () => void;
  onRetryTaxonomy: (input: TaxonomyRetry) => void;
  onDirty?: (dirty: boolean) => void;
  onSelected?: (id: string | null) => void;
}) {
  const [filters, setFilters] = useState({ type: '', status: '' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(initialId);
  const [detailBlocked, setDetailBlocked] = useState(false);
  const jobs = usePolling<Collection>(
    api,
    queryPath('jobs', { ...filters, page, pageSize: 20 }),
    activeCollection,
  );
  const lastSuccess = usePolling<Collection>(
    api,
    queryPath('jobs', {
      type: 'build',
      status: 'succeeded',
      pageSize: 1,
      page: 1,
    }),
    activeCollection,
  );
  const artifact = usePolling<CurrentArtifact>(
    api,
    '/api/v1/artifacts/current',
    artifactNeedsAttention,
  );
  const command = useCommand(api);
  const blocked = command.busy || Boolean(command.pending) || detailBlocked;
  useEffect(() => {
    onDirty?.(blocked);
    return () => onDirty?.(false);
  }, [blocked, onDirty]);
  const select = (id: string | null) => {
    setSelected(id);
    onSelected?.(id);
  };
  const build = async (retryOf?: string) => {
    try {
      await command.run<Job>(
        {
          label: '更新網站',
          method: 'POST',
          path: '/api/v1/build-jobs',
          body: retryOf ? { retryOf } : {},
          idempotencyKey: newKey(),
        },
        (response) => {
          select(response.data.id);
          jobs.reload();
          onChanged();
        },
      );
    } catch {
      /* Manual same-key retry is offered by RetryNotice. */
    }
  };
  const latest = lastSuccess.response?.data.items[0];
  const lastResult = latest?.type === 'build' ? latest.result : null;
  const parsedArtifact = CurrentArtifactSchema.safeParse(
    artifact.response?.data,
  );
  const installed = parsedArtifact.success ? parsedArtifact.data : null;
  const installedBuild =
    installed?.recoveryState === 'ready' ? installed.current?.build : null;
  const artifactRecords = useRef<HTMLDetailsElement>(null);
  const artifactRecordContent = useRef<HTMLDivElement>(null);
  const artifactUnavailable =
    Boolean(artifact.error) || (!artifact.loading && !installed);
  const visibleBuild = artifactUnavailable ? null : installedBuild;
  const artifactMessage = artifactUnavailable
    ? '暫時無法確認網站狀態，請重新檢查。'
    : artifact.loading
      ? '正在確認網站是否已套用最新內容…'
      : installed?.recoveryState === 'recovery-required'
        ? '網站需要先完成復原，請至「衝突與復原」處理。'
        : installed?.current === null
          ? '網站尚未建立，請按「更新網站」。'
          : !visibleBuild
            ? '網站已存在，但更新紀錄不完整。請重新更新網站。'
            : !workspace
              ? '暫時無法確認內容是否有變更，網站仍保留目前版本。'
              : workspace.revision === visibleBuild.result.snapshotRevision
                ? '網站已更新至目前保存的內容。'
                : '有已保存的變更尚未套用到網站。';
  const artifactMessageClass =
    !artifactUnavailable && !artifact.loading
      ? installed?.recoveryState === 'recovery-required' ||
        (visibleBuild &&
          workspace?.revision !== visibleBuild.result.snapshotRevision)
        ? 'artifact-attention'
        : visibleBuild && workspace
          ? 'artifact-current'
          : undefined
      : undefined;
  return (
    <section className="jobs-view">
      <div className="section-heading">
        <div>
          <ResourceHeading
            title="網站更新與工作"
            icon="globe"
            loading={jobs.loading}
            loadingLabel="讀取工作中…"
          />
          <p className="muted">
            將已保存的文章與設定套用到網站，完成後即可查看更新。
          </p>
        </div>
        <button
          className="primary"
          disabled={blocked || workspace?.recoveryState !== 'ready'}
          onClick={() => void build()}
        >
          <Icon name="globe" />
          更新網站
        </button>
      </div>
      <section className="artifact-summary" aria-label="網站狀態">
        <div className="artifact-summary-heading">
          <h3>
            <Icon name="globe" />
            目前網站版本
          </h3>
          <span className="muted artifact-counts" tabIndex={0}>
            {visibleBuild?.result.routeCount ?? '—'} 個頁面、
            {visibleBuild?.result.fileCount ?? '—'} 個檔案
          </span>
        </div>
        <div
          className="artifact-summary-state"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          tabIndex={0}
        >
          <p className={artifactMessageClass}>{artifactMessage}</p>
          {Boolean(visibleBuild?.result.warnings.length) && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                if (artifactRecords.current)
                  artifactRecords.current.open = true;
                artifactRecordContent.current?.focus();
              }}
            >
              更新提醒（{visibleBuild?.result.warnings.length}）
            </button>
          )}
        </div>
        <div className="artifact-meta">
          <span className="artifact-update-time" tabIndex={0}>
            更新於{' '}
            <JobTime value={visibleBuild?.committedAt ?? null} empty="—" />
          </span>
          <details
            className="technical-details artifact-records"
            ref={artifactRecords}
          >
            <summary>查看更新紀錄</summary>
            <div
              className="artifact-records-content"
              role="region"
              aria-label="完整網站更新資訊"
              tabIndex={0}
              ref={artifactRecordContent}
            >
              <dl className="compact-details">
                <dt>更新紀錄編號</dt>
                <dd>
                  <code>{visibleBuild?.jobId ?? '—'}</code>
                </dd>
                <dt>內容版本</dt>
                <dd>
                  <code>{visibleBuild?.result.snapshotRevision ?? '—'}</code>
                </dd>
                <dt>網站版本</dt>
                <dd>
                  <code>
                    {visibleBuild ? (installed?.current?.digest ?? '—') : '—'}
                  </code>
                </dd>
              </dl>
              {visibleBuild && visibleBuild.result.warnings.length > 0 && (
                <Diagnostics items={visibleBuild.result.warnings} />
              )}
              <ErrorNotice error={artifact.error} />
            </div>
          </details>
        </div>
      </section>
      {selected === null && <RetryNotice api={api} command={command} />}
      <form
        className="filters job-filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <Field label="工作種類" width="medium">
          <select
            value={filters.type}
            onChange={(event) => {
              setFilters({ ...filters, type: event.target.value });
              setPage(1);
            }}
          >
            <option value="">全部種類</option>
            <option value="build">網站更新</option>
            <option value="media">媒體</option>
            <option value="taxonomy">分類／Tag</option>
          </select>
        </Field>
        <Field label="工作狀態" width="medium">
          <select
            value={filters.status}
            onChange={(event) => {
              setFilters({ ...filters, status: event.target.value });
              setPage(1);
            }}
          >
            <option value="">全部狀態</option>
            {Object.entries(statuses).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <button type="button" onClick={jobs.reload}>
          <Icon name="refresh" />
          重新讀取工作
        </button>
      </form>
      <ErrorNotice error={jobs.error} />
      {jobs.response?.data.items.length === 0 && (
        <p className="empty-state">沒有符合條件的工作。</p>
      )}
      {Boolean(jobs.response?.data.items.length) && (
        <div className="operations-table-wrap">
          <table className="operations-table jobs-table">
            <caption className="sr-only">工作紀錄</caption>
            <thead>
              <tr>
                <th scope="col">工作</th>
                <th scope="col">狀態</th>
                <th scope="col">目前階段</th>
                <th scope="col">建立時間</th>
              </tr>
            </thead>
            <tbody>
              {jobs.response?.data.items.map((job) => (
                <tr key={job.id}>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => select(job.id)}
                    >
                      {types[job.type]} · {statuses[job.status]}
                    </button>
                  </td>
                  <td>
                    <span className={`job-status job-status--${job.status}`}>
                      {statuses[job.status]}
                    </span>
                  </td>
                  <td className="job-stage-cell">
                    <span>{stages[job.stage] ?? '處理中'}</span>
                    {activeJob(job) && (
                      <progress
                        aria-label={`${types[job.type]}進度`}
                        {...(job.progress.total === null
                          ? {}
                          : {
                              value: job.progress.completed,
                              max: Math.max(1, job.progress.total),
                            })}
                      />
                    )}
                  </td>
                  <td>
                    <JobTime value={job.createdAt} empty="—" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {jobs.response && <Pagination {...jobs.response.data} onPage={setPage} />}
      <details className="job-history technical-details">
        <summary>最近成功更新</summary>
        <section aria-label="網站更新歷史">
          <p className="muted">
            這裡記錄過去的更新；目前網站狀態以上方說明為準。
          </p>
          {lastResult ? (
            <>
              <p>
                <JobTime
                  value={latest?.finishedAt ?? null}
                  empty="時間未記錄"
                />{' '}
                · {lastResult.routeCount} 個頁面、{lastResult.fileCount} 個檔案
              </p>
              <dl className="compact-details">
                <dt>更新紀錄編號</dt>
                <dd>
                  <code>{latest?.id}</code>
                </dd>
                <dt>內容版本</dt>
                <dd>
                  <code>{lastResult.snapshotRevision}</code>
                </dd>
              </dl>
            </>
          ) : (
            <p>
              {lastSuccess.error
                ? '暫時無法讀取最近的更新紀錄。'
                : '尚無成功更新紀錄。'}
            </p>
          )}
          <ErrorNotice error={lastSuccess.error} />
        </section>
      </details>
      {selected && (
        <JobDetail
          key={selected}
          api={api}
          id={selected}
          onClose={() => select(null)}
          onBlocked={setDetailBlocked}
          onChanged={() => {
            jobs.reload();
            lastSuccess.reload();
            artifact.reload();
            onChanged();
          }}
          buildBlocked={command.busy || Boolean(command.pending)}
          buildCommand={command}
          onBuildRetry={build}
          onRetryTaxonomy={onRetryTaxonomy}
          onNewJob={(job) => {
            select(job.id);
            jobs.reload();
            onChanged();
          }}
        />
      )}
    </section>
  );
}
function JobDetail({
  api,
  id,
  onClose,
  onBlocked,
  onChanged,
  onBuildRetry,
  buildBlocked,
  buildCommand,
  onRetryTaxonomy,
  onNewJob,
}: {
  api: StudioApi;
  id: string;
  onClose: () => void;
  onBlocked: (blocked: boolean) => void;
  onChanged: () => void;
  onBuildRetry: (id: string) => Promise<void>;
  buildBlocked: boolean;
  buildCommand: ReturnType<typeof useCommand>;
  onRetryTaxonomy: (input: TaxonomyRetry) => void;
  onNewJob: (job: Job) => void;
}) {
  const resource = usePolling<Job>(api, `/api/v1/jobs/${id}`, activeJob);
  const command = useCommand(api);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [retryPreparing, setRetryPreparing] = useState(false);
  const retryInFlight = useRef(false);
  const blocked = command.busy || Boolean(command.pending) || retryPreparing;
  useEffect(() => {
    onBlocked(blocked);
    return () => onBlocked(false);
  }, [blocked, onBlocked]);
  const retry = async () => {
    if (
      retryInFlight.current ||
      buildBlocked ||
      command.busy ||
      command.pending
    )
      return;
    retryInFlight.current = true;
    setRetryPreparing(true);
    setRetryError(null);
    try {
      const input = JobRetryInputSchema.parse(
        (await api.get(`/api/v1/jobs/${id}/retry-input`)).data,
      );
      if (input.type === 'build') {
        await onBuildRetry(id);
        return;
      }
      if (input.type === 'taxonomy') {
        onRetryTaxonomy({ ...input, retryOf: id });
        return;
      }
      await command.run<Job>(
        {
          label: '重試媒體工作',
          method: 'POST',
          path: '/api/v1/media-jobs',
          body: { sourceId: input.sourceId, preset: input.preset, retryOf: id },
          idempotencyKey: newKey(),
        },
        (response) => onNewJob(response.data),
      );
    } catch (error) {
      setRetryError(error);
    } finally {
      retryInFlight.current = false;
      setRetryPreparing(false);
    }
  };
  const job = resource.response?.data;
  const notifiedCompletion = useRef<string | null>(null);
  useEffect(() => {
    if (!job || activeJob(job)) return;
    const completion = `${job.id}:${job.status}`;
    if (notifiedCompletion.current === completion) return;
    notifiedCompletion.current = completion;
    onChanged();
  }, [job, onChanged]);
  const cancel = async () => {
    if (!window.confirm('確定取消這次工作？已完成的更新會保留。')) return;
    try {
      await command.run<Job>(
        {
          label: '取消工作',
          method: 'PUT',
          path: `/api/v1/jobs/${id}/cancellation`,
          body: { requested: true },
        },
        () => {
          resource.reload();
          onChanged();
        },
      );
    } catch {
      resource.reload();
    }
  };
  return (
    <Dialog
      open
      title="工作詳細資料"
      className="job-dialog"
      closeDisabled={blocked || buildBlocked}
      onClose={() => {
        if (!blocked && !buildBlocked) onClose();
      }}
      actions={
        job && (
          <>
            {activeJob(job) && (
              <button
                disabled={blocked || buildBlocked}
                onClick={() => void cancel()}
              >
                <Icon name="close" />
                取消此工作
              </button>
            )}
            {['failed', 'cancelled', 'interrupted'].includes(job.status) && (
              <button
                className="primary"
                disabled={blocked || buildBlocked}
                onClick={() => void retry()}
              >
                <Icon name="refresh" />
                以最新保存的內容重試
              </button>
            )}
          </>
        )
      }
    >
      <ErrorNotice error={resource.error} />
      <ErrorNotice error={retryError} />
      <RetryNotice api={api} command={command} />
      <RetryNotice api={api} command={buildCommand} />
      {resource.loading && !job && <p role="status">讀取工作詳細資料中…</p>}
      {job && (
        <>
          <dl className="job-detail-summary">
            <dt>種類／狀態</dt>
            <dd>
              {types[job.type]} · {statuses[job.status]}
            </dd>
            <dt>目前階段</dt>
            <dd>{stages[job.stage] ?? '處理中'}</dd>
            <dt>進度</dt>
            <dd>{progressLabel(job)}</dd>
            <dt>建立時間</dt>
            <dd>
              <JobTime value={job.createdAt} empty="—" />
            </dd>
            <dt>開始時間</dt>
            <dd>
              <JobTime value={job.startedAt} empty="尚未開始" />
            </dd>
            <dt>結束時間</dt>
            <dd>
              <JobTime value={job.finishedAt} empty="尚未結束" />
            </dd>
          </dl>
          {activeJob(job) && (
            <progress
              className="job-detail-progress"
              aria-label="目前工作進度"
              {...(job.progress.total === null
                ? {}
                : {
                    value: job.progress.completed,
                    max: Math.max(1, job.progress.total),
                  })}
            />
          )}
          {job.error && (
            <section role="alert" className="notice error">
              <p>{job.error.message}</p>
              {job.error.issues.length > 0 && (
                <ul>
                  {job.error.issues.map((issue, index) => (
                    <li key={index}>
                      {issue.path.join('.')}：{issue.message}
                    </li>
                  ))}
                </ul>
              )}
              {job.type === 'build' && (
                <p>這次更新未完成，網站仍保留上次成功的版本。</p>
              )}
              <details className="technical-details">
                <summary>查看錯誤詳情</summary>
                <code>{job.error.code}</code>
              </details>
            </section>
          )}
          <JobResult job={job} />
          <details className="technical-details">
            <summary>疑難排解資料</summary>
            <dl className="compact-details">
              <dt>工作紀錄編號</dt>
              <dd>
                <code>{id}</code>
              </dd>
              <dt>處理階段</dt>
              <dd>
                <code>{job.stage}</code>
              </dd>
              <dt>內容版本</dt>
              <dd>
                <code>{job.snapshotRevision ?? '尚未開始處理內容'}</code>
              </dd>
            </dl>
            <pre>{JSON.stringify(job, null, 2)}</pre>
          </details>
          {blocked && (
            <p className="muted" role="status">
              操作進行中或結果尚未確認，請完成操作或處理重送紀錄後再關閉。
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
function JobResult({ job }: { job: Job }) {
  if (!job.result) return null;
  return (
    <section className="job-result" aria-label="工作結果">
      <h4>工作結果</h4>
      {job.type === 'build' && job.result && (
        <>
          <p>已更新 {job.result.routeCount} 個頁面。</p>
          <Diagnostics items={job.result.warnings} />
        </>
      )}
      {job.type === 'media' && job.result && (
        <p>
          已產生 {job.result.asset.outputs.length} 個
          {job.result.asset.kind === 'image' ? '圖片' : '影片與封面'}
          版本，可返回媒體庫查看與引用。
        </p>
      )}
      {job.type === 'taxonomy' && job.result && (
        <>
          <p>
            {job.result.kind === 'category' ? '分類' : 'Tag'}「{job.result.from}
            」已改為「{job.result.to}」，更新{' '}
            {job.result.affectedArticleIds.length} 篇文章。
          </p>
          <p className="muted">
            網址調整 {job.result.changedUrls.length}{' '}
            筆。請按「更新網站」套用這次變更。
          </p>
        </>
      )}
    </section>
  );
}
