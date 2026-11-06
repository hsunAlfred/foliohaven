import type { Diagnostic } from '@foliohaven/core';
import { ApiFailure } from './api.js';
export interface InputIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}
export function inputIssues(error: unknown): readonly InputIssue[] {
  if (error instanceof ApiFailure) return error.issues;
  if (
    typeof error !== 'object' ||
    error === null ||
    !('issues' in error) ||
    !Array.isArray(error.issues)
  )
    return [];
  const walk = (
    items: readonly unknown[],
    prefix: readonly (string | number)[],
  ): InputIssue[] =>
    items.flatMap((item) => {
      if (
        typeof item !== 'object' ||
        item === null ||
        !('path' in item) ||
        !Array.isArray(item.path) ||
        !('message' in item) ||
        typeof item.message !== 'string'
      )
        return [];
      const path = [
        ...prefix,
        ...item.path.filter(
          (part): part is string | number =>
            typeof part === 'string' || typeof part === 'number',
        ),
      ];
      if ('errors' in item && Array.isArray(item.errors))
        return item.errors.flatMap((branch) =>
          Array.isArray(branch) ? walk(branch, path) : [],
        );
      if (
        path.at(-1) === 'status' &&
        'code' in item &&
        item.code === 'invalid_value'
      )
        return [];
      return [{ path, message: item.message }];
    });
  const values = walk(error.issues, []);
  return values.filter(
    (value, index) =>
      values.findIndex(
        (item) =>
          item.path.join('.') === value.path.join('.') &&
          item.message === value.message,
      ) === index,
  );
}
export function inputFieldPath(
  path: readonly (string | number)[],
  currentArticleId?: string | null,
): readonly (string | number)[] {
  return currentArticleId &&
    path[0] === 'articles' &&
    path[1] === currentArticleId
    ? path.slice(2)
    : path;
}
export function focusField(
  path: readonly (string | number)[],
  currentArticleId?: string | null,
) {
  const localPath = inputFieldPath(path, currentArticleId);
  const element = document.querySelector<HTMLElement>(
    `[data-field="${CSS.escape(localPath.join('.'))}"]`,
  );
  let parent = element?.parentElement;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
  const focusable =
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable="true"]';
  const control = element?.matches(focusable)
    ? element
    : element?.querySelector<HTMLElement>(focusable);
  control?.focus();
  element?.scrollIntoView({ block: 'center' });
}

/** 只信任明確屬於目前HTML的行列；metadata與他篇不可改動目前編輯器位置。 */
export function isCurrentHtmlDiagnostic(
  item: Diagnostic,
  currentArticleId?: string | null,
): boolean {
  if (!currentArticleId || item.line === undefined) return false;
  const resource = `content/articles/${currentArticleId}/content.html`;
  if (item.articleId !== undefined && item.articleId !== currentArticleId)
    return false;
  if (item.resource !== undefined && item.resource !== resource) return false;
  if (item.field !== undefined && !/^contentHtml(?:\.|$)/u.test(item.field))
    return false;
  if (item.articleId !== currentArticleId && item.resource !== resource)
    return false;
  return (
    item.resource === resource ||
    item.field?.startsWith('contentHtml') === true ||
    (item.resource === undefined &&
      item.field === undefined &&
      /^(?:HTML_|MEDIA_)/u.test(item.code))
  );
}
