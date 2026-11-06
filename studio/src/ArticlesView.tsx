import { Icon } from './Icon.js';
import { ResourceHeading } from './ResourceHeading.js';
import { useState } from 'react';
import type { ArticleResource, Taxonomy } from '@foliohaven/core';
import type { StudioApi } from './api.js';
import { queryPath } from './api.js';
import { useCommand, useResource } from './hooks.js';
import {
  Diagnostics,
  ErrorNotice,
  Field,
  Pagination,
  RetryNotice,
} from './components.js';

interface Collection<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
export function ArticlesView({
  api,
  taxonomy,
  writable,
  onOpen,
  onCreate,
}: {
  api: StudioApi;
  taxonomy: Taxonomy;
  writable: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [filters, setFilters] = useState({
    status: '',
    category: '',
    tag: '',
    q: '',
    sort: 'published-desc',
  });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [advancedFilters, setAdvancedFilters] = useState(false);
  const resource = useResource<Collection<ArticleResource>>(
    api,
    queryPath('articles', { ...applied, page, pageSize: 20 }),
  );
  const command = useCommand(api);
  const [preflightError, setPreflightError] = useState<unknown>(null);
  const remove = async (id: string) => {
    setPreflightError(null);
    if (
      !window.confirm(
        '確定將這篇文章移至垃圾桶？你可以在「衝突與復原」找回文章。',
      )
    )
      return;
    try {
      const current = await api.get<ArticleResource>(`/api/v1/articles/${id}`);
      if (!current.etag) return;
      await command.run(
        {
          label: '刪除文章',
          method: 'DELETE',
          path: `/api/v1/articles/${id}`,
          etag: current.etag,
        },
        () => resource.reload(),
      );
    } catch (error) {
      setPreflightError(error);
    }
  };
  const quickPublish = async (id: string) => {
    setPreflightError(null);
    try {
      const current = await api.get<ArticleResource>(`/api/v1/articles/${id}`);
      if (
        !window.confirm(
          '發布的是目前已保存版本；不包含其他編輯器的未保存內容。確認發布？',
        )
      )
        return;
      await command.run(
        {
          label: '發布已保存文章',
          method: 'PATCH',
          path: `/api/v1/articles/${id}/publication`,
          body: {
            status: 'published',
            publishedAt:
              current.data.meta.publishedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          ...(current.etag ? { etag: current.etag } : {}),
        },
        () => resource.reload(),
      );
    } catch (error) {
      setPreflightError(error);
    }
  };
  return (
    <section>
      <div className="section-heading">
        <ResourceHeading
          title="文章"
          icon="article"
          loading={resource.loading}
          loadingLabel="讀取文章中…"
        />
        <button className="primary" disabled={!writable} onClick={onCreate}>
          <Icon name="plus" />
          新增文章
        </button>
      </div>
      <p className="page-description">整理文章、延續草稿，或開始一篇新內容。</p>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(filters);
          setPage(1);
        }}
      >
        <Field label="文章狀態">
          <select
            value={filters.status}
            onChange={(event) =>
              setFilters({ ...filters, status: event.target.value })
            }
          >
            <option value="">全部</option>
            <option value="draft">草稿</option>
            <option value="published">已發布</option>
          </select>
        </Field>

        <Field label="文章關鍵字">
          <input
            value={filters.q}
            maxLength={200}
            onChange={(event) =>
              setFilters({ ...filters, q: event.target.value })
            }
          />
        </Field>

        <button
          type="button"
          className="mobile-filter-toggle"
          aria-expanded={advancedFilters}
          aria-controls="article-advanced-filters"
          onClick={() => setAdvancedFilters(!advancedFilters)}
        >
          <Icon name="settings" />
          進階篩選
        </button>
        <div
          id="article-advanced-filters"
          className={`article-filter-advanced${advancedFilters ? ' is-open' : ''}`}
        >
          <Field label="篩選分類">
            <select
              value={filters.category}
              onChange={(event) =>
                setFilters({ ...filters, category: event.target.value })
              }
            >
              <option value="">全部分類</option>
              {taxonomy.categories.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="篩選 Tag">
            <select
              value={filters.tag}
              onChange={(event) =>
                setFilters({ ...filters, tag: event.target.value })
              }
            >
              <option value="">全部 Tag</option>
              {taxonomy.tags.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="文章排序">
            <select
              value={filters.sort}
              onChange={(event) =>
                setFilters({ ...filters, sort: event.target.value })
              }
            >
              <option value="published-desc">發布時間：新到舊</option>
              <option value="published-asc">發布時間：舊到新</option>
              <option value="updated-desc">更新時間：新到舊</option>
              <option value="title-asc">標題</option>
            </select>
          </Field>
        </div>
        <button type="submit">
          <Icon name="search" />
          套用篩選
        </button>
      </form>
      <ErrorNotice error={resource.error} />
      <ErrorNotice error={preflightError} />
      <RetryNotice command={command} api={api} />
      {resource.response?.data.items.length === 0 && (
        <p>沒有符合條件的文章。可新增草稿或調整篩選。</p>
      )}
      {Boolean(resource.response?.data.items.length) && (
        <div className="table-frame">
          <table className="compact-table article-table">
            <thead>
              <tr>
                <th>文章</th>
                <th>狀態</th>
                <th className="hide-mobile">分類</th>
                <th className="hide-medium">發布日期</th>
                <th className="article-actions-column">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {resource.response?.data.items.map((item) => (
                <tr key={item.id} data-article-id={item.id}>
                  <td>
                    <button
                      className="text-button article-title-button"
                      onClick={() => onOpen(item.id)}
                    >
                      {item.meta.title || '未命名文章'}
                    </button>
                    <span className="table-subtitle">
                      /{item.meta.slug || '尚未設定網址'}
                    </span>
                    {item.diagnostics.length > 0 && (
                      <details>
                        <summary>診斷（{item.diagnostics.length}）</summary>
                        <Diagnostics items={item.diagnostics} />
                      </details>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${item.meta.status}`}>
                      {item.meta.status === 'draft' ? '草稿' : '已發布'}
                    </span>
                  </td>
                  <td className="hide-mobile">
                    {taxonomy.categories.find(
                      (category) => category.path === item.meta.category,
                    )?.name ??
                      item.meta.category ??
                      '未分類'}
                  </td>
                  <td className="hide-medium">
                    {item.meta.publishedAt ? (
                      <time dateTime={item.meta.publishedAt}>
                        {new Intl.DateTimeFormat('zh-TW', {
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                        }).format(new Date(item.meta.publishedAt))}
                      </time>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="quiet article-open"
                        onClick={() => onOpen(item.id)}
                      >
                        <Icon name="edit" />
                        編輯
                      </button>
                      <details className="row-menu">
                        <summary
                          aria-label={`更多操作：${item.meta.title || '未命名文章'}`}
                        >
                          <Icon name="more" />
                        </summary>
                        <div className="actions">
                          {item.meta.status === 'draft' && (
                            <button
                              disabled={
                                !writable ||
                                command.busy ||
                                Boolean(command.pending)
                              }
                              onClick={() => void quickPublish(item.id)}
                            >
                              <Icon name="globe" />
                              發布已保存版本
                            </button>
                          )}
                          <button
                            className="danger"
                            disabled={
                              !writable ||
                              command.busy ||
                              Boolean(command.pending)
                            }
                            onClick={() => void remove(item.id)}
                          >
                            <Icon name="trash" />
                            刪除文章
                          </button>
                        </div>
                      </details>
                    </div>
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
    </section>
  );
}
