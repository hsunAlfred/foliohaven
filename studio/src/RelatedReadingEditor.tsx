import { useRef, useState } from 'react';
import type {
  ArticleOption,
  ArticleOptions,
  DraftArticleMeta,
} from '@foliohaven/core';
import type { StudioApi } from './api.js';
import { queryPath } from './api.js';
import { ErrorNotice, Pagination, TextField } from './components.js';
import { useResource } from './hooks.js';
import { Icon } from './Icon.js';
import './article-related-reading.css';

type RelatedReading = DraftArticleMeta['relatedReading'];

/** Page lightweight published options while retaining the author's selection order. */
export function RelatedReadingEditor({
  api,
  articleId,
  value,
  disabled,
  onChange,
}: {
  readonly api: StudioApi;
  readonly articleId: string;
  readonly value: RelatedReading;
  readonly disabled: boolean;
  readonly onChange: (value: RelatedReading) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<readonly string[]>([]);
  const selectedKey = [...new Set(value.articleIds)].sort().join(',');
  const resource = useResource<ArticleOptions>(
    api,
    queryPath('article-options', {
      status: 'published',
      sort: 'title-asc',
      selected: selectedKey,
      q: query,
      page,
      pageSize: 20,
    }),
  );
  const [knownArticles, setKnownArticles] = useState<{
    readonly articleId: string;
    readonly response: ArticleOptions | null;
    readonly items: ReadonlyMap<string, ArticleOption>;
  }>({ articleId, response: null, items: new Map() });
  const incoming = resource.response?.data;
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (
    incoming &&
    (knownArticles.articleId !== articleId ||
      knownArticles.response !== incoming)
  ) {
    const selected = new Set(value.articleIds);
    const retained = new Set(selection.filter((id) => !selected.has(id)));
    const items = new Map(
      knownArticles.articleId === articleId
        ? [...knownArticles.items].filter(([id]) => retained.has(id))
        : [],
    );
    for (const article of [...incoming.items, ...incoming.selected])
      items.set(article.id, article);
    setKnownArticles({ articleId, response: incoming, items });
  }
  const loading = resource.loading;
  const error = resource.error;
  const articleById = new Map(
    knownArticles.articleId === articleId ? knownArticles.items : [],
  );
  for (const article of [
    ...(incoming?.items ?? []),
    ...(incoming?.selected ?? []),
  ])
    articleById.set(article.id, article);
  const visibleArticles = (incoming?.items ?? []).filter(
    (article) => article.id !== articleId && article.status === 'published',
  );

  const close = () => dialog.current?.close();
  const open = () => {
    setSelection([...value.articleIds]);
    setQuery('');
    setPage(1);
    resource.reload();
    setOpened(true);
    dialog.current?.showModal();
  };
  const move = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= value.articleIds.length) return;
    const ids = [...value.articleIds];
    const selected = ids[index];
    const displaced = ids[nextIndex];
    if (selected === undefined || displaced === undefined) return;
    ids[index] = displaced;
    ids[nextIndex] = selected;
    onChange({ ...value, articleIds: ids });
  };

  return (
    <fieldset className="article-related-settings">
      <legend>延伸閱讀</legend>
      <TextField
        label="延伸閱讀區塊標題"
        field="meta.relatedReading.title"
        value={value.title}
        maxLength={200}
        width="full"
        disabled={disabled}
        onChange={(title) => onChange({ ...value, title: title ?? '' })}
      />
      <p className="field-note">選擇文章後才會顯示這個區塊。</p>
      <ErrorNotice error={error} />
      <div data-field="meta.relatedReading.articleIds" tabIndex={-1}>
        {value.articleIds.length > 0 ? (
          <ol className="related-selected-list" aria-label="已選延伸閱讀文章">
            {value.articleIds.map((id, index) => {
              const article = articleById.get(id);
              const title = article?.title ?? id;
              return (
                <li key={id}>
                  <div className="related-selected-row">
                    <div className="related-article-copy">
                      <strong>{title}</strong>
                      {(!article ||
                        article.status !== 'published' ||
                        id === articleId) &&
                      !loading ? (
                        <p className="related-article-unavailable">
                          這篇文章目前不是可選的已發布文章，請移除或重新選擇。
                        </p>
                      ) : !article ? (
                        <p>讀取文章資料中…</p>
                      ) : null}
                    </div>
                    <div className="related-article-actions">
                      <button
                        type="button"
                        disabled={disabled || index === 0}
                        aria-label={`將「${title}」往上移`}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={
                          disabled || index === value.articleIds.length - 1
                        }
                        aria-label={`將「${title}」往下移`}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        aria-label={`移除延伸閱讀「${title}」`}
                        onClick={() =>
                          onChange({
                            ...value,
                            articleIds: value.articleIds.filter(
                              (item) => item !== id,
                            ),
                          })
                        }
                      >
                        <Icon name="close" size={16} />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="muted">尚未選擇文章。</p>
        )}
      </div>
      <button type="button" ref={trigger} disabled={disabled} onClick={open}>
        <Icon name="plus" size={17} /> 選擇延伸閱讀文章
      </button>
      <dialog
        ref={dialog}
        className="related-picker-dialog"
        aria-labelledby={`related-picker-title-${articleId}`}
        onClose={() => {
          setOpened(false);
          trigger.current?.focus();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            close();
        }}
      >
        {opened && (
          <div className="related-picker-content">
            <header className="related-picker-header">
              <h3 id={`related-picker-title-${articleId}`}>選擇延伸閱讀文章</h3>
              <button
                type="button"
                aria-label="關閉延伸閱讀選單"
                onClick={close}
              >
                <Icon name="close" />
              </button>
            </header>
            <div className="related-picker-search">
              <TextField
                label="搜尋可選文章"
                value={query}
                type="search"
                maxLength={200}
                width="full"
                onChange={(next) => {
                  setQuery(next ?? '');
                  setPage(1);
                }}
              />
              <div className="related-picker-selection">
                <p className="muted" aria-live="polite">
                  已選 {selection.length}／20 篇
                </p>
                <button
                  type="button"
                  className="quiet"
                  disabled={selection.length === 0}
                  onClick={() => setSelection([])}
                >
                  清除選擇
                </button>
              </div>
            </div>
            <div className="related-picker-results" aria-busy={loading}>
              <ErrorNotice error={error} />
              {Boolean(error) && (
                <button type="button" onClick={resource.reload}>
                  重新讀取可選文章
                </button>
              )}
              {loading ? (
                <p role="status">讀取已發布文章中…</p>
              ) : (
                <>
                  {visibleArticles.map((article) => {
                    const checked = selection.includes(article.id);
                    return (
                      <label className="related-picker-option" key={article.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && selection.length >= 20}
                          onChange={(event) =>
                            setSelection((previous) =>
                              event.target.checked
                                ? [...previous, article.id]
                                : previous.filter((id) => id !== article.id),
                            )
                          }
                        />
                        <span className="related-article-copy">
                          <strong>{article.title}</strong>
                        </span>
                      </label>
                    );
                  })}
                  {visibleArticles.length === 0 && !error && (
                    <p>沒有符合的已發布文章。</p>
                  )}
                </>
              )}
            </div>
            {incoming && !loading && !error && (
              <Pagination
                page={page}
                pageSize={incoming.pageSize}
                total={incoming.total}
                onPage={setPage}
              />
            )}
            <footer className="related-picker-footer">
              <button type="button" onClick={close}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={disabled || loading || Boolean(error)}
                onClick={() => {
                  onChange({ ...value, articleIds: [...selection] });
                  close();
                }}
              >
                套用選擇
              </button>
            </footer>
          </div>
        )}
      </dialog>
    </fieldset>
  );
}
