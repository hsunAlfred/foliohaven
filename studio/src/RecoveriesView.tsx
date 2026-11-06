import { Icon } from './Icon.js';
import { ResourceHeading } from './ResourceHeading.js';
import { useEffect, useState } from 'react';
import type { RecoveryChoice, RecoveryDetail } from '@foliohaven/core';
import type { ApiResponse, StudioApi } from './api.js';
import { ApiFailure, queryPath } from './api.js';
import { useCommand, useResource } from './hooks.js';
import { ErrorNotice, Field, Pagination, RetryNotice } from './components.js';
import { Dialog } from './Dialog.js';
import './jobs-recoveries.css';

interface RecoverySummary {
  id: string;
  kind: 'transaction' | 'trash' | 'build';
  status: 'pending' | 'available' | 'resolved';
  createdAt: string;
}
interface Collection {
  items: RecoverySummary[];
  total: number;
  page: number;
  pageSize: number;
}
const choices: Readonly<Record<RecoveryChoice, string>> = {
  'keep-current': '保留目前版本',
  'restore-backup': '還原備份版本',
  'apply-prepared': '採用原先準備版本',
  'restore-trash': '從垃圾桶還原',
  'purge-trash': '永久清除已過保留期限的垃圾桶',
};
const kinds: Readonly<Record<RecoverySummary['kind'], string>> = {
  transaction: '內容變更',
  trash: '垃圾桶',
  build: '網站版本',
};
const statuses: Readonly<Record<RecoverySummary['status'], string>> = {
  pending: '待處理',
  available: '可還原',
  resolved: '已處理',
};
const explanations: Readonly<Record<RecoveryChoice, string>> = {
  'keep-current': '保留目前內容，不套用備份。',
  'restore-backup': '以原始備份取代目前內容；會先確認內容沒有再次被修改。',
  'apply-prepared': '採用變更紀錄原先準備的內容；會先確認內容沒有再次被修改。',
  'restore-trash': '將刪除的資料還原；如已有同名新資料，會保留新資料。',
  'purge-trash': '永久刪除已超過保留期限的備份，執行後無法還原。',
};
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
export function RecoveriesView({
  api,
  onChanged,
  onDirty,
  initialId = null,
  onSelected,
}: {
  api: StudioApi;
  onChanged: () => void;
  onDirty?: (dirty: boolean) => void;
  initialId?: string | null;
  onSelected?: (id: string | null) => void;
}) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(initialId);
  const [blocked, setBlocked] = useState(false);
  const resource = useResource<Collection>(
    api,
    queryPath('recoveries', { page, pageSize: 20 }),
  );
  useEffect(() => {
    onDirty?.(blocked);
    return () => onDirty?.(false);
  }, [blocked, onDirty]);
  const select = (id: string | null) => {
    setSelected(id);
    onSelected?.(id);
  };
  return (
    <section className="recoveries-view">
      <div className="section-heading">
        <div>
          <ResourceHeading
            title="衝突與復原"
            icon="history"
            loading={resource.loading}
            loadingLabel="讀取復原紀錄中…"
          />
          <p className="muted">
            查看未完成變更紀錄、已刪除資料與可還原的網站版本。
          </p>
        </div>
        <button onClick={resource.reload}>
          <Icon name="refresh" />
          重新掃描復原紀錄
        </button>
      </div>
      <p className="recovery-guidance">
        先查看備份、目前內容與可還原版本，再選擇要保留哪一份；已有同名新內容時不會直接覆蓋。
      </p>
      <ErrorNotice error={resource.error} />
      {resource.response?.data.items.length === 0 && (
        <p className="empty-state">沒有未完成變更紀錄或垃圾桶紀錄。</p>
      )}
      {Boolean(resource.response?.data.items.length) && (
        <div className="operations-table-wrap">
          <table className="operations-table recoveries-table">
            <caption className="sr-only">復原紀錄</caption>
            <thead>
              <tr>
                <th scope="col">紀錄種類</th>
                <th scope="col">狀態</th>
                <th scope="col">建立時間</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {resource.response?.data.items.map((item) => (
                <tr key={item.id} data-recovery-id={item.id}>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => select(item.id)}
                    >
                      {kinds[item.kind]} · {statuses[item.status]}
                    </button>
                  </td>
                  <td>
                    <span
                      className={`recovery-status recovery-status--${item.status}`}
                    >
                      {statuses[item.status]}
                    </span>
                  </td>
                  <td>
                    <time dateTime={item.createdAt} title={item.createdAt}>
                      {dateLabel(item.createdAt)}
                    </time>
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => select(item.id)}
                      aria-label={`比較${kinds[item.kind]} ${dateLabel(item.createdAt)}`}
                    >
                      <Icon name="history" />
                      比較版本
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {resource.response && (
        <Pagination {...resource.response.data} onPage={setPage} />
      )}
      {selected && (
        <RecoveryPanel
          key={selected}
          api={api}
          id={selected}
          onClose={() => select(null)}
          onBlocked={setBlocked}
          onChanged={() => {
            resource.reload();
            onChanged();
          }}
        />
      )}
    </section>
  );
}
function RecoveryPanel({
  api,
  id,
  onClose,
  onBlocked,
  onChanged,
}: {
  api: StudioApi;
  id: string;
  onClose: () => void;
  onBlocked: (blocked: boolean) => void;
  onChanged: () => void;
}) {
  const resource = useResource<RecoveryDetail>(api, `/api/v1/recoveries/${id}`);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    onBlocked(blocked);
    return () => onBlocked(false);
  }, [blocked, onBlocked]);
  return (
    <Dialog
      open
      title="復原比較"
      className="recovery-dialog"
      closeDisabled={blocked}
      onClose={() => {
        if (!blocked) onClose();
      }}
    >
      <ErrorNotice error={resource.error} />
      {resource.response ? (
        <RecoveryForm
          api={api}
          initial={resource.response}
          onChanged={onChanged}
          onBlocked={setBlocked}
        />
      ) : (
        !resource.error && <p role="status">讀取完整版本中…</p>
      )}
    </Dialog>
  );
}
function RecoveryForm({
  api,
  initial,
  onChanged,
  onBlocked,
}: {
  api: StudioApi;
  initial: ApiResponse<RecoveryDetail>;
  onChanged: () => void;
  onBlocked: (blocked: boolean) => void;
}) {
  const [base, setBase] = useState(initial);
  const [choice, setChoice] = useState<RecoveryChoice>(
    initial.data.choices[0] ?? 'keep-current',
  );
  const [selectedResource, setSelectedResource] = useState(
    initial.data.resources[0]?.resourceKey ?? '',
  );
  const [latest, setLatest] = useState<ApiResponse<RecoveryDetail> | null>(
    null,
  );
  const [notice, setNotice] = useState('');
  const [readError, setReadError] = useState<unknown>(null);
  const command = useCommand(api);
  const blocked = command.busy || Boolean(command.pending);
  useEffect(() => {
    onBlocked(blocked);
    return () => onBlocked(false);
  }, [blocked, onBlocked]);
  const detail = base.data;
  const selected =
    detail.resources.find((item) => item.resourceKey === selectedResource) ??
    detail.resources[0];
  const resolve = async () => {
    const question =
      choice === 'purge-trash'
        ? '這會永久刪除備份，無法再還原。確認清除？'
        : `確認「${choices[choice]}」並重新核對所有 ${detail.resources.length} 個項目的內容？`;
    if (!window.confirm(question)) return;
    try {
      await command.run(
        {
          label: choices[choice],
          method: 'PUT',
          path: `/api/v1/recoveries/${detail.id}/resolution`,
          body: {
            choice,
            revisions: detail.resources.map((item) => ({
              resourceKey: item.resourceKey,
              revision: item.current.revision,
            })),
          },
          ...(base.etag ? { etag: base.etag } : {}),
        },
        () => {
          setNotice(
            '復原決策已完成。若還原的是文章或設定，請更新網站讓變更生效。',
          );
          onChanged();
        },
      );
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 412) {
        try {
          setLatest(
            await api.get<RecoveryDetail>(`/api/v1/recoveries/${detail.id}`),
          );
        } catch (failure) {
          setReadError(failure);
        }
      }
    }
  };
  return (
    <>
      <div className="recovery-detail-heading">
        <p>
          <strong>{kinds[detail.kind]}</strong>
          <span
            className={`recovery-status recovery-status--${notice ? 'resolved' : detail.status}`}
          >
            {notice ? '已處理' : statuses[detail.status]}
          </span>
        </p>
        <time
          className="muted"
          dateTime={detail.createdAt}
          title={detail.createdAt}
        >
          {dateLabel(detail.createdAt)}
        </time>
      </div>
      <RetryNotice api={api} command={command} />
      <ErrorNotice error={readError} />
      {latest && (
        <section className="notice error">
          <p>
            比較期間版本已改變，尚未套用復原決策。請重新載入完整比較資料後再次確認。
          </p>
          <button
            onClick={() => {
              setBase(latest);
              setChoice(latest.data.choices[0] ?? 'keep-current');
              setSelectedResource(latest.data.resources[0]?.resourceKey ?? '');
              setLatest(null);
              command.clear();
            }}
          >
            <Icon name="refresh" />
            載入最新比較版本
          </button>
        </section>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="recovery-resource-picker">
        <Field
          label={`比較資源（共 ${detail.resources.length} 個）`}
          width="full"
        >
          <select
            value={selected?.resourceKey ?? ''}
            onChange={(event) => setSelectedResource(event.target.value)}
          >
            {detail.resources.map((item) => (
              <option key={item.resourceKey} value={item.resourceKey}>
                {item.resourceKey === 'dist'
                  ? '網站檔案總覽'
                  : item.resourceKey.startsWith('dist/')
                    ? `網站檔案 / ${item.resourceKey.slice(5)}`
                    : item.resourceKey === 'content/site.json'
                      ? '網站設定'
                      : item.resourceKey === 'content/categories.json'
                        ? '分類設定'
                        : item.resourceKey === 'content/tags.json'
                          ? 'Tag 設定'
                          : item.resourceKey}
              </option>
            ))}
          </select>
        </Field>
        <p className="muted">
          可逐一比較這筆紀錄中的內容，確認後會套用至整筆紀錄。文章正文以原文顯示。
        </p>
      </div>
      {selected && (
        <section className="recovery-resource" aria-label="版本比較">
          <div className="recovery-versions">
            {(['base', 'current', 'prepared'] as const).map((key) => (
              <section key={key} className="recovery-version">
                <h4>
                  {key === 'base'
                    ? '原始備份'
                    : key === 'current'
                      ? '目前內容'
                      : '準備版本'}
                </h4>
                <Version
                  value={selected[key]}
                  json={
                    selected.resourceKey === 'dist' ||
                    selected.resourceKey.endsWith('.json')
                  }
                />
              </section>
            ))}
          </div>
          {selected.preserved.length > 0 && (
            <details className="technical-details">
              <summary>另外保留的版本（{selected.preserved.length}）</summary>
              <div className="recovery-preserved">
                {selected.preserved.map((version, index) => (
                  <section key={index} className="recovery-version">
                    <h4>保留版本 {index + 1}</h4>
                    <Version
                      value={version}
                      json={
                        selected.resourceKey === 'dist' ||
                        selected.resourceKey.endsWith('.json')
                      }
                    />
                  </section>
                ))}
              </div>
            </details>
          )}
        </section>
      )}
      <details className="technical-details recovery-technical">
        <summary>疑難排解資料</summary>
        <dl className="compact-details">
          <dt>紀錄編號</dt>
          <dd>
            <code>{detail.id}</code>
          </dd>
          <dt>比對版本</dt>
          <dd>
            <code>{base.etag ?? '未提供'}</code>
          </dd>
        </dl>
        <details>
          <summary>完整比較資料</summary>
          <pre>{JSON.stringify(detail, null, 2)}</pre>
        </details>
      </details>
      <section className="recovery-decision" aria-label="復原決策">
        <Field label="復原選擇" width="wide">
          <select
            disabled={
              blocked || Boolean(notice) || detail.status === 'resolved'
            }
            value={choice}
            onChange={(event) =>
              setChoice(event.target.value as RecoveryChoice)
            }
          >
            {detail.choices.map((value) => (
              <option key={value} value={value}>
                {choices[value]}
              </option>
            ))}
          </select>
        </Field>
        <p className="muted">{explanations[choice]}</p>
        <button
          className={choice === 'purge-trash' ? 'danger' : 'primary'}
          disabled={
            blocked ||
            Boolean(notice) ||
            Boolean(latest) ||
            detail.status === 'resolved' ||
            detail.choices.length === 0
          }
          onClick={() => void resolve()}
        >
          <Icon name="check" />
          確認套用復原決策
        </button>
        {blocked && (
          <p role="status" className="muted">
            正在處理復原決策，請等待完成後再關閉。
          </p>
        )}
      </section>
    </>
  );
}
function Version({
  value,
  json,
}: {
  value: RecoveryDetail['resources'][number]['base'];
  json: boolean;
}) {
  return (
    <>
      {value.revision === null && <p className="muted">此版本不存在</p>}
      {value.text !== null &&
        (json ? (
          <details className="recovery-json">
            <summary>查看完整內容</summary>
            <pre>{value.text}</pre>
          </details>
        ) : (
          <pre>{value.text}</pre>
        ))}
      {value.binary && (
        <p className="recovery-attachment">
          <a href={value.binary.downloadUrl} download>
            下載受控附件
          </a>
          <span className="muted">
            {value.binary.byteSize.toLocaleString('zh-TW')} bytes ·{' '}
            {value.binary.mimeType}
          </span>
        </p>
      )}
      {value.revision !== null && (
        <details className="technical-details">
          <summary>比對版本</summary>
          <code>{value.revision}</code>
        </details>
      )}
    </>
  );
}
