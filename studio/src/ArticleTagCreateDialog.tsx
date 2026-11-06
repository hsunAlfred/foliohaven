import { useEffect, useRef, useState } from 'react';
import { SlugSchema } from '@foliohaven/core';
import type { Tag, Taxonomy } from '@foliohaven/core';
import type { StudioApi } from './api.js';
import { Dialog } from './Dialog.js';
import { ErrorNotice, TextField } from './components.js';
import { FormIssuesProvider } from './form-issues.js';
import { inputIssues } from './validation.js';
import { createArticleTag } from './article-tag-creation.js';

function suggestedSlug(name: string) {
  const normalized = name.normalize('NFKC').trim();
  if (Array.from(normalized).some((character) => character.charCodeAt(0) > 127))
    return '';
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80)
    .replace(/-$/u, '');
  return SlugSchema.safeParse(slug).success ? slug : '';
}

export function ArticleTagCreateDialog({
  api,
  disabled,
  initialName,
  onClose,
  onCreated,
  onBusy,
}: {
  readonly api: StudioApi;
  readonly disabled: boolean;
  readonly initialName: string;
  readonly onClose: () => void;
  readonly onCreated: (tag: Tag, taxonomy: Taxonomy) => void;
  readonly onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState(() => initialName.trim());
  const [slug, setSlug] = useState(() => suggestedSlug(initialName));
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const slugEdited = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = () => {
    if (!inFlight.current) onClose();
  };
  const create = async () => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    onBusy(true);
    try {
      const result = await createArticleTag(api, {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
      });
      if (mounted.current) onCreated(result.tag, result.taxonomy);
    } catch (failure) {
      if (mounted.current) setError(failure);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
      onBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="新增 Tag"
      className="article-tag-create"
      onClose={close}
      closeDisabled={busy}
      actions={
        <>
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={disabled || busy}
            onClick={() => void create()}
          >
            {busy ? '建立中…' : '建立並勾選'}
          </button>
        </>
      }
    >
      <p className="field-note">建立後會加入全站 Tag；文章仍需套用及保存。</p>
      <FormIssuesProvider issues={inputIssues(error)}>
        <ErrorNotice error={error} />
        <fieldset
          disabled={disabled || busy}
          className="article-tag-create-fields"
          aria-busy={busy}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              event.target instanceof HTMLInputElement
            ) {
              event.preventDefault();
              void create();
            }
          }}
        >
          <TextField
            label="Tag 名稱"
            field="name"
            value={name}
            maxLength={120}
            width="full"
            hint="必填，顯示於文章與 Tag 頁面。"
            onChange={(value) => {
              const next = value ?? '';
              setName(next);
              if (!slugEdited.current) setSlug(suggestedSlug(next));
            }}
          />
          <TextField
            label="Tag 網址名稱"
            field="slug"
            value={slug}
            maxLength={80}
            width="full"
            hint="必填，使用小寫英文字母、數字與連字號，不可為純數字；中文名稱請另外填寫英文網址名稱。"
            onChange={(value) => {
              slugEdited.current = true;
              setSlug(value ?? '');
            }}
          />
          <TextField
            label="Tag 描述"
            field="description"
            value={description}
            maxLength={300}
            multiline
            rows={3}
            width="full"
            hint="必填，說明這個 Tag 收錄的主題，最多 300 字。"
            onChange={(value) => setDescription(value ?? '')}
          />
        </fieldset>
      </FormIssuesProvider>
    </Dialog>
  );
}
