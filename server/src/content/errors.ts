import { DiagnosticSchema } from '@foliohaven/core';
import type { ApiIssue, Diagnostic } from '@foliohaven/core';
import { ContentSourceError } from '@foliohaven/core/node';
import { RepositoryError } from '../files/index.js';

function diagnosticMessage(code: string): string {
  if (code === 'UNKNOWN_CATEGORY') return '文章分類不存在，請選擇已登錄分類。';
  if (code === 'UNKNOWN_TAG') return '文章Tag不存在，請選擇已登錄Tag。';
  if (code === 'INVALID_JSON') return 'JSON格式錯誤，請修正來源資料。';
  if (code.includes('MEDIA'))
    return '受管媒體不存在或尚未處理完成，請到媒體庫檢查並處理來源。';
  if (code.includes('FRAGMENT') || code.includes('LINK'))
    return '站內連結或目標anchor不符合發布規則。';
  if (/HTML|HEADING|ANCHOR|(?:^|_)ID(?:_|$)/u.test(code))
    return '正文HTML、標題或anchor不符合發布規則。';
  if (/ROUTE|URL|COLLISION/u.test(code))
    return '公開網址或路由與既有頁面衝突。';
  return '此欄位或來源不符合發布規則，請依位置及錯誤碼修正。';
}
/** 只轉換已驗證位置與固定訊息；不把Diagnostic原文／任意Error內容放進API。 */
function diagnosticIssues(
  diagnostics: readonly Diagnostic[],
): readonly ApiIssue[] {
  const valid = diagnostics.flatMap((value) => {
    const parsed = DiagnosticSchema.safeParse(value);
    return parsed.success && parsed.data.severity === 'error'
      ? [parsed.data]
      : [];
  });
  const result: ApiIssue[] = valid
    .slice(0, valid.length > 500 ? 499 : 500)
    .map((item) => {
      const path: (string | number)[] = [];
      const resourceArticle =
        /^content\/articles\/([a-z0-9-]+)\/(content\.html|meta\.json)$/u.exec(
          item.resource ?? '',
        );
      const id = item.articleId ?? resourceArticle?.[1];
      if (id !== undefined) {
        path.push('articles', id);
        if (
          resourceArticle?.[2] === 'content.html' ||
          item.field === 'contentHtml' ||
          (resourceArticle === null && item.code.startsWith('HTML_'))
        )
          path.push('contentHtml');
        else path.push('meta');
      } else if (item.resource === 'content/categories.json')
        path.push('categories');
      else if (item.resource === 'content/tags.json') path.push('tags');
      else if (
        item.resource !== undefined &&
        item.resource !== 'content/site.json'
      ) {
        path.push('resources');
        let part = '';
        for (const character of item.resource) {
          if (part.length + character.length > 512) {
            path.push(part);
            part = '';
          }
          part += character;
        }
        if (part) path.push(part);
      }
      if (item.field !== undefined && item.field !== 'contentHtml') {
        let fields = item.field.split('.');
        if (path.at(-1) === 'meta' && fields[0] === 'meta')
          fields = fields.slice(1);
        if (fields.length + path.length > 50) fields = [item.field];
        path.push(
          ...fields.map((field) =>
            /^\d+$/u.test(field) && Number.isSafeInteger(Number(field))
              ? Number(field)
              : field,
          ),
        );
      }
      const location =
        item.line === undefined
          ? ''
          : `（第 ${item.line} 行${item.column === undefined ? '' : `，第 ${item.column} 欄`}）`;
      return {
        path,
        code: item.code,
        message: diagnosticMessage(item.code) + location,
      };
    });
  if (valid.length > 500)
    result.push({
      path: [],
      code: 'ADDITIONAL_DIAGNOSTICS',
      message: '診斷超過500件，請修正已列項目後重新檢查。',
    });
  return result;
}

export class ContentServiceError extends RepositoryError {
  readonly diagnostics: readonly Diagnostic[];
  readonly issues: readonly ApiIssue[];
  constructor(
    code: string,
    message: string,
    status = 422,
    diagnostics: readonly Diagnostic[] = [],
    issues: readonly ApiIssue[] = [],
    etag?: string,
  ) {
    super(code, message, status, etag);
    this.name = 'ContentServiceError';
    this.diagnostics = diagnostics;
    this.issues = issues.length > 0 ? issues : diagnosticIssues(diagnostics);
  }
}
export interface SchemaLike<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues: readonly {
            path: readonly PropertyKey[];
            code: string;
            message: string;
          }[];
        };
      };
}
export function parseContract<T>(
  schema: SchemaLike<T>,
  value: unknown,
  resource?: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues: ApiIssue[] = parsed.error.issues.map((issue) => ({
    path: issue.path.map((part) =>
      typeof part === 'number' ? part : String(part),
    ),
    code: issue.code.toUpperCase(),
    message: issue.message,
  }));
  throw new ContentServiceError(
    'VALIDATION_FAILED',
    '資料不符合共用欄位契約。',
    422,
    issues.map((issue) => ({
      severity: 'error',
      code: 'VALIDATION_FAILED',
      message: issue.message,
      ...(resource === undefined ? {} : { resource }),
      ...(issue.path.length === 0 ? {} : { field: issue.path.join('.') }),
    })),
    issues,
  );
}
export function sourceError(error: unknown): never {
  if (error instanceof ContentSourceError)
    throw new ContentServiceError(
      'SOURCE_INVALID',
      '來源資料損壞，請依診斷修正；原始檔案已保留。',
      422,
      error.diagnostics,
    );
  throw error;
}
