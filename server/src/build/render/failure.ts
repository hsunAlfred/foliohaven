import { resolve } from 'node:path';
import {
  DiagnosticSchema,
  SafeErrorSchema,
  type SafeError,
  type ApiIssue,
  type Diagnostic,
} from '@foliohaven/core';
import { atomicJson, safeMkdir } from '../../files/io.js';
import { RenderError } from './context.js';

function message(code: string): string {
  if (code === 'BROKEN_FRAGMENT' || code === 'UNKNOWN_FRAGMENT_TARGET')
    return '連結目標頁面缺少指定anchor。';
  if (code === 'BROKEN_INTERNAL_LINK') return '站內連結沒有對應的公開頁面。';
  if (code === 'INVALID_SOURCE_DATA')
    return '來源欄位不符合結構、型別或值域要求。';
  if (code === 'INVALID_JSON') return 'JSON格式錯誤，請修正來源資料。';
  if (code.includes('MEDIA') || code.includes('RESOURCE'))
    return '受管資源不存在、未完成或輸出不一致。';
  if (code.includes('ROUTE') || code.includes('COLLISION'))
    return '公開路由或實際輸出檔案發生衝突。';
  if (
    code.includes('HTML') ||
    code.includes('HEADING') ||
    code.includes('ANCHOR') ||
    /(?:^|_)ID(?:_|$)/u.test(code)
  )
    return 'HTML結構、屬性或anchor不符合發布規則。';
  if (
    code.includes('SEO') ||
    code.includes('CANONICAL') ||
    code.includes('JSON_LD')
  )
    return '頁面的SEO資料與Core模型不一致。';
  return '此項資料未通過驗證，請依位置與錯誤碼修正。';
}
function issue(diagnostic: Diagnostic): ApiIssue {
  const path: (string | number)[] = [];
  if (diagnostic.articleId !== undefined)
    path.push('articles', diagnostic.articleId);
  else if (diagnostic.resource !== undefined) {
    // Diagnostic允許2048字元資源，但ApiIssue每個path片段最多512；完整保留且不切斷Unicode字元。
    path.push('resources');
    let part = '';
    for (const character of diagnostic.resource) {
      if (part.length + character.length > 512) {
        path.push(part);
        part = '';
      }
      part += character;
    }
    if (part !== '') path.push(part);
  }
  if (diagnostic.field !== undefined) path.push('fields', diagnostic.field);
  if (diagnostic.line !== undefined) path.push('line', diagnostic.line);
  if (diagnostic.column !== undefined) path.push('column', diagnostic.column);
  return { path, code: diagnostic.code, message: message(diagnostic.code) };
}
export function safeRenderFailure(error: unknown): SafeError {
  if (!(error instanceof RenderError))
    return {
      code: 'BUILD_RENDER_FAILED',
      message: '靜態網站呈現失敗，請檢查建置來源與必要工具。',
      retryable: false,
      issues: [],
    };
  const diagnostics = error.diagnostics.flatMap((value) => {
    const result = DiagnosticSchema.safeParse(value);
    return result.success && result.data.severity === 'error'
      ? [result.data]
      : [];
  });
  const issues = diagnostics
    .slice(0, diagnostics.length > 500 ? 499 : 500)
    .map(issue);
  if (diagnostics.length > 500)
    issues.push({
      path: [],
      code: 'ADDITIONAL_DIAGNOSTICS',
      message: '診斷超過500件；請修正已列項目後重新建置，查看其餘問題。',
    });
  return SafeErrorSchema.parse({
    code: error.code,
    message: '靜態網站建置未通過驗證，請修正列出的內容或輸出。',
    retryable: false,
    issues,
  });
}
/** 只保存明確白名單錯誤，不記任意message、stderr、stack或原文。 */
export async function writeBuildFailureReport(
  snapshotRoot: string,
  error: unknown,
): Promise<SafeError> {
  const root = resolve(snapshotRoot);
  if (
    !/\/\.alfred\/builds\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/snapshot$/u.test(
      root,
    )
  )
    throw new Error('INVALID_FAILURE_REPORT_LOCATION');
  const safeError = safeRenderFailure(error);
  await safeMkdir(root, '.alfred');
  await atomicJson(root, '.alfred/build-failure.json', {
    schemaVersion: 1,
    error: safeError,
  });
  return safeError;
}
