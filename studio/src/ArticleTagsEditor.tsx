import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { Taxonomy } from '@foliohaven/core';
import { Dialog } from './Dialog.js';
import { Icon } from './Icon.js';
import { captureFocusOwner } from './focus.js';
import type { StudioApi } from './api.js';
import { ArticleTagCreateDialog } from './ArticleTagCreateDialog.js';
import {
  ARTICLE_TAG_LIMIT,
  articleTagSearchIndex,
  filterArticleTags,
  toggleArticleTag,
} from './article-tag-selection.js';
import './article-tags.css';

type Tag = Taxonomy['tags'][number];

export function ArticleTagsEditor({
  api,
  tags,
  value,
  disabled,
  onChange,
  onTaxonomySaved,
  onBusy,
}: {
  readonly api: StudioApi;
  readonly tags: Taxonomy['tags'];
  readonly value: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (tags: string[]) => void;
  readonly onTaxonomySaved: () => void;
  readonly onBusy: (busy: boolean) => void;
}) {
  const [opened, setOpened] = useState(false);
  const currentTags = useRef(tags);
  useLayoutEffect(() => {
    currentTags.current = tags;
  }, [tags]);
  // Keep the authoritative create response until App's taxonomy reload arrives.
  const [created, setCreated] = useState<{
    base: Taxonomy['tags'];
    tags: Taxonomy['tags'];
  } | null>(null);
  const availableTags = created?.base === tags ? created.tags : tags;
  const trigger = useRef<HTMLButtonElement>(null);
  const tagBySlug = useMemo(
    () => new Map(availableTags.map((tag) => [tag.slug, tag])),
    [availableTags],
  );
  const unavailable = value.filter((slug) => !tagBySlug.has(slug));

  return (
    <fieldset className="article-tags-settings" disabled={disabled}>
      <legend>Tag</legend>
      <p className="article-tags-count">
        已選 {value.length} / {ARTICLE_TAG_LIMIT}
      </p>
      {value.length > 0 ? (
        <SelectedTags
          value={value}
          tagBySlug={tagBySlug}
          label="文章已選 Tag"
          disabled={disabled}
          onRemove={(slug) => onChange(value.filter((tag) => tag !== slug))}
          onEmptyFocus={() => trigger.current?.focus()}
        />
      ) : (
        <p className="article-tags-empty">尚未選擇 Tag。</p>
      )}
      {unavailable.length > 0 && <UnavailableTags count={unavailable.length} />}
      <button
        ref={trigger}
        type="button"
        className="article-tags-trigger"
        data-field="meta.tags"
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpened(true)}
      >
        <Icon name="tag" size={17} />
        選擇 Tag
      </button>
      <p className="field-note">套用後仍需保存文章。</p>
      {opened &&
        createPortal(
          <TagPicker
            api={api}
            tags={availableTags}
            tagBySlug={tagBySlug}
            initial={value}
            disabled={disabled}
            onBusy={onBusy}
            onCreated={(taxonomy) => {
              setCreated({ base: currentTags.current, tags: taxonomy.tags });
              onTaxonomySaved();
            }}
            onClose={() => setOpened(false)}
            onApply={(selection) => {
              onChange([...selection]);
              setOpened(false);
            }}
          />,
          document.body,
        )}
    </fieldset>
  );
}

function SelectedTags({
  value,
  tagBySlug,
  label,
  disabled,
  onRemove,
  onEmptyFocus,
}: {
  readonly value: readonly string[];
  readonly tagBySlug: ReadonlyMap<string, Tag>;
  readonly label: string;
  readonly disabled: boolean;
  readonly onRemove: (slug: string) => void;
  readonly onEmptyFocus: () => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  return (
    <ul
      ref={list}
      className="article-tags-selected"
      role="list"
      aria-label={label}
    >
      {value.map((slug, index) => {
        const tag = tagBySlug.get(slug);
        const name = tag?.name ?? slug;
        return (
          <li key={slug} data-unavailable={!tag || undefined}>
            <span title={slug}>
              {name}
              {!tag && (
                <span className="article-tag-unavailable">（已失效）</span>
              )}
            </span>
            <button
              type="button"
              aria-label={`移除 Tag：${name}`}
              disabled={disabled}
              onClick={(event) => {
                const ownsFocus = captureFocusOwner(
                  event.currentTarget.ownerDocument,
                );
                onRemove(slug);
                requestAnimationFrame(() => {
                  if (!ownsFocus()) return;
                  const buttons = list.current?.querySelectorAll('button');
                  const next = buttons?.[Math.min(index, buttons.length - 1)];
                  if (next) next.focus();
                  else onEmptyFocus();
                });
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function UnavailableTags({ count }: { readonly count: number }) {
  return (
    <p className="article-tags-warning">
      有 {count} 個已選 Tag 已不存在；原選擇仍保留，請移除或改選。
    </p>
  );
}

/** Search and checkboxes only change this dialog's draft, never the article. */
function TagPicker({
  api,
  tags,
  tagBySlug,
  initial,
  disabled,
  onClose,
  onApply,
  onCreated,
  onBusy,
}: {
  readonly api: StudioApi;
  readonly tags: Taxonomy['tags'];
  readonly tagBySlug: ReadonlyMap<string, Tag>;
  readonly initial: readonly string[];
  readonly disabled: boolean;
  readonly onClose: () => void;
  readonly onApply: (selection: readonly string[]) => void;
  readonly onCreated: (taxonomy: Taxonomy) => void;
  readonly onBusy: (busy: boolean) => void;
}) {
  const [selection, setSelection] = useState<readonly string[]>(() => [
    ...initial,
  ]);
  const [query, setQuery] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const pendingCreatedFocus = useRef<string | null>(null);
  const id = useId();
  const index = useMemo(() => articleTagSearchIndex(tags), [tags]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const visible = filterArticleTags(index, query).filter(
    (tag) => !selectedOnly || selected.has(tag.slug),
  );
  const unavailable = selection.filter((slug) => !tagBySlug.has(slug));
  const atLimit = selection.length >= ARTICLE_TAG_LIMIT;
  useEffect(() => {
    if (creating || pendingCreatedFocus.current === null) return;
    // Wait for the new option's commit and the nested Dialog's cleanup.
    // A frame callback can run before React has mounted the created option.
    const option = options.current?.querySelector<HTMLInputElement>(
      `input[data-tag-slug="${CSS.escape(pendingCreatedFocus.current)}"]`,
    );
    if (option?.isConnected && !option.disabled) option.focus();
    pendingCreatedFocus.current = null;
  }, [creating]);

  return (
    <Dialog
      open
      title="選擇 Tag"
      className="article-tag-picker"
      onClose={onClose}
      actions={
        <>
          <span className="article-tag-picker-save-note">
            套用後仍需保存文章
          </span>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={disabled || selection.length > ARTICLE_TAG_LIMIT}
            onClick={() => onApply(selection)}
          >
            套用選擇
          </button>
        </>
      }
    >
      <div className="article-tag-picker-controls">
        <div className="field">
          <label htmlFor={`${id}-search`}>搜尋 Tag</label>
          <input
            ref={search}
            id={`${id}-search`}
            type="search"
            value={query}
            autoComplete="off"
            placeholder="輸入名稱或 slug"
            aria-describedby={`${id}-search-note`}
            onChange={(event) => setQuery(event.target.value)}
          />
          <small id={`${id}-search-note`}>
            搜尋名稱或 slug，不分英文大小寫。
          </small>
        </div>
        <div className="article-tag-picker-summary">
          <p role="status" aria-live="polite" aria-atomic="true">
            已勾選 {selection.length} / {ARTICLE_TAG_LIMIT}
            {atLimit && ' · 已達上限，請先移除再加入'}
          </p>
          <label className="article-tag-picker-filter">
            <input
              type="checkbox"
              checked={selectedOnly}
              onChange={(event) => setSelectedOnly(event.target.checked)}
            />
            只看已勾選
          </label>
        </div>
        {selection.length > 0 && (
          <div className="article-tag-picker-selected">
            <SelectedTags
              value={selection}
              tagBySlug={tagBySlug}
              label="目前勾選 Tag"
              disabled={disabled}
              onRemove={(slug) =>
                setSelection((previous) =>
                  toggleArticleTag(previous, slug, false),
                )
              }
              onEmptyFocus={() => search.current?.focus()}
            />
          </div>
        )}
        {unavailable.length > 0 && (
          <UnavailableTags count={unavailable.length} />
        )}
      </div>
      <div className="article-tag-picker-results">
        <div className="article-tag-picker-results-heading">
          <p className="article-tag-picker-result-count">
            {query.trim() || selectedOnly ? '符合條件' : '可選 Tag'}：
            {visible.length} 個
          </p>
          <button
            type="button"
            className="article-tag-picker-create"
            disabled={disabled || atLimit}
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" size={16} /> 新增 Tag
          </button>
        </div>
        {visible.length > 0 ? (
          <div
            ref={options}
            className="article-tag-picker-options"
            role="group"
            aria-label="可選 Tag"
          >
            {visible.map((tag) => {
              const checked = selected.has(tag.slug);
              return (
                <label className="article-tag-picker-option" key={tag.slug}>
                  <input
                    type="checkbox"
                    data-tag-slug={tag.slug}
                    aria-label={`${tag.name} ${tag.slug}`}
                    checked={checked}
                    disabled={disabled || (!checked && atLimit)}
                    onChange={(event) =>
                      setSelection((previous) =>
                        toggleArticleTag(
                          previous,
                          tag.slug,
                          event.target.checked,
                        ),
                      )
                    }
                  />
                  <span>
                    <strong>{tag.name}</strong>
                    <small>{tag.slug}</small>
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <p className="article-tag-picker-empty">
            {tags.length === 0
              ? '尚未建立 Tag。'
              : selectedOnly
                ? '沒有符合條件的已勾選 Tag。'
                : '沒有符合的 Tag，請試試其他名稱或 slug。'}
          </p>
        )}
      </div>
      {creating &&
        createPortal(
          <ArticleTagCreateDialog
            api={api}
            disabled={disabled}
            initialName={query.trim()}
            onBusy={onBusy}
            onClose={() => setCreating(false)}
            onCreated={(tag, taxonomy) => {
              pendingCreatedFocus.current = tag.slug;
              onCreated(taxonomy);
              setSelection((previous) =>
                toggleArticleTag(previous, tag.slug, true),
              );
              setQuery(tag.name);
              setCreating(false);
            }}
          />,
          document.body,
        )}
    </Dialog>
  );
}
