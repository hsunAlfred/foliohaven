import { RepositoryError } from '../files/io.js';
export class MediaError extends RepositoryError {
  constructor(
    code: string,
    message: string,
    status = 422,
    readonly retryable = false,
  ) {
    super(code, message, status);
    this.name = 'MediaError';
  }
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new MediaError('MEDIA_CANCELLED', '媒體操作已取消。', 409);
}
