export class CloudflareError extends Error {
  constructor(code, message, { unknown = false, retryable = false } = {}) {
    super(message);
    this.name = 'CloudflareError';
    this.code = code;
    this.unknown = unknown;
    this.retryable = retryable;
  }
}

export function cancelled(signal) {
  if (signal?.aborted)
    throw new CloudflareError('CLOUDFLARE_CANCELLED', '操作已取消。');
}

export function safeDiagnostic(error) {
  if (error instanceof CloudflareError)
    return {
      code: error.code,
      message: error.message,
      unknown: error.unknown,
      retryable: error.retryable,
    };
  if (
    error instanceof Error &&
    ['ArtifactError', 'RepositoryError', 'ProcessFailure'].includes(
      error.name,
    ) &&
    /^(?:BUILD|ARTIFACT|PROCESS|DIST)_[A-Z_]{1,80}$/.test(error.code ?? '')
  )
    return {
      code: error.code,
      message: '本機建置或產物驗證未完成；請依錯誤代碼排查並保留紀錄。',
      unknown: false,
      retryable: false,
    };
  return {
    code: 'CLOUDFLARE_FAILED',
    message: '操作未完成；請保留部署紀錄並依階段排查。',
    unknown: false,
    retryable: false,
  };
}
