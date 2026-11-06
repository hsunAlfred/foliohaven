import busboy from 'busboy';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { MediaService } from './service.js';
import type { MediaTaskOptions, StagedMedia } from './types.js';
import { MediaError } from './errors.js';

export async function receiveUpload(
  service: MediaService,
  request: IncomingMessage,
  options: MediaTaskOptions & { uploadMs: number; idleMs: number },
): Promise<StagedMedia> {
  const maximum = 513 * 1024 * 1024;
  const length = request.headers['content-length'];
  if (
    length !== undefined &&
    (!/^\d+$/u.test(length) || Number(length) > maximum)
  )
    throw new MediaError('MEDIA_UPLOAD_TOO_LARGE', '上傳總量超過513MiB。', 413);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: request.headers,
      defCharset: 'utf8',
      defParamCharset: 'utf8',
      limits: {
        files: 1,
        fields: 3,
        parts: 4,
        fileSize: 512 * 1024 * 1024,
        fieldSize: 4096,
        headerPairs: 32,
      },
    });
  } catch {
    options.signal?.removeEventListener('abort', abort);
    throw new MediaError(
      'MEDIA_MULTIPART_INVALID',
      '請使用有合法boundary的multipart/form-data。',
      415,
    );
  }
  const fields: Record<string, string> = {};
  let file: Readable | undefined;
  let staged: Promise<StagedMedia> | undefined;
  let total = 0;
  let resolveFields: (value: {
    displayName?: string;
    posterTimeSeconds?: number;
  }) => void = () => undefined;
  let rejectFields: (error: unknown) => void = () => undefined;
  const metadata = new Promise<{
    displayName?: string;
    posterTimeSeconds?: number;
  }>((resolve, reject) => {
    resolveFields = resolve;
    rejectFields = reject;
  });
  void metadata.catch(() => undefined);
  let rejectDone: (error: unknown) => void = () => undefined;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  void done.catch(() => undefined);
  let failure: Error | undefined;
  const fail = (error: Error) => {
    if (failure !== undefined) return;
    failure = error;
    controller.abort();
    rejectFields(error);
    rejectDone(error);
    request.unpipe(parser);
    file?.destroy(error);
    parser.destroy();
    request.pause();
  };
  let idle: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () =>
        fail(
          new MediaError(
            'MEDIA_UPLOAD_TIMEOUT',
            '上傳串流超過30秒沒有資料。',
            408,
            true,
          ),
        ),
      options.idleMs,
    );
    idle.unref();
  };
  const deadline = setTimeout(
    () =>
      fail(
        new MediaError('MEDIA_UPLOAD_TIMEOUT', '上傳超過時間限制。', 408, true),
      ),
    options.uploadMs,
  );
  deadline.unref();
  resetIdle();
  const onData = (chunk: Buffer) => {
    total += chunk.length;
    if (total > maximum)
      fail(
        new MediaError('MEDIA_UPLOAD_TOO_LARGE', '上傳總量超過513MiB。', 413),
      );
    else resetIdle();
  };
  const onAbort = () =>
    fail(new MediaError('MEDIA_UPLOAD_ABORTED', '上傳已中斷。', 400, true));
  const onSignal = () =>
    fail(new MediaError('MEDIA_CANCELLED', '上傳已取消。', 409));
  parser.on('file', (name, stream, info) => {
    file = stream;
    stream.on('error', () => undefined);
    if (name !== 'file' || staged !== undefined) {
      stream.resume();
      fail(
        new MediaError(
          'MEDIA_MULTIPART_INVALID',
          '一次只能上傳單一file欄位。',
          400,
        ),
      );
      return;
    }
    stream.once('limit', () =>
      fail(
        new MediaError('MEDIA_UPLOAD_TOO_LARGE', '上傳檔案超過大小限制。', 413),
      ),
    );
    stream.once('end', () => {
      if (stream.truncated)
        fail(new MediaError('MEDIA_UPLOAD_TRUNCATED', '上傳檔案不完整。', 413));
    });
    staged = service.stageSource(
      stream,
      { filename: info.filename ?? '', mimeType: info.mimeType },
      { ...options, signal: controller.signal },
      metadata,
    );
    void staged.catch((error) =>
      fail(
        error instanceof Error
          ? error
          : new MediaError('MEDIA_UPLOAD_FAILED', '媒體上傳失敗。', 500),
      ),
    );
  });
  parser.on('field', (name, value, info) => {
    if (
      info.nameTruncated ||
      info.valueTruncated ||
      !['displayName', 'posterTimeSeconds'].includes(name) ||
      Object.hasOwn(fields, name)
    ) {
      fail(
        new MediaError(
          'MEDIA_MULTIPART_INVALID',
          '媒體上傳欄位未知、重複或超過長度限制。',
          400,
        ),
      );
      return;
    }
    fields[name] = value;
  });
  for (const event of ['partsLimit', 'filesLimit', 'fieldsLimit'] as const)
    parser.on(event, () =>
      fail(
        new MediaError(
          'MEDIA_MULTIPART_LIMIT',
          'multipart欄位或檔案數超過限制。',
          413,
        ),
      ),
    );
  parser.once('error', () =>
    fail(
      new MediaError(
        'MEDIA_MULTIPART_INVALID',
        'multipart格式錯誤或資料不完整。',
        400,
      ),
    ),
  );
  parser.once('finish', () => {
    clearTimeout(idle);
    if (staged === undefined) {
      fail(new MediaError('MEDIA_FILE_REQUIRED', '請選擇一個媒體檔案。', 422));
      return;
    }
    const poster = fields['posterTimeSeconds'];
    if (
      poster !== undefined &&
      (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(poster) ||
        !Number.isFinite(Number(poster)))
    ) {
      fail(
        new MediaError(
          'MEDIA_METADATA_INVALID',
          'Poster時間必須是有限非負數值。',
        ),
      );
      return;
    }
    resolveFields({
      ...(fields['displayName'] === undefined
        ? {}
        : { displayName: fields['displayName'] }),
      ...(poster === undefined ? {} : { posterTimeSeconds: Number(poster) }),
    });
    resolveDone();
  });
  request.on('data', onData);
  request.once('aborted', onAbort);
  request.once('error', onAbort);
  controller.signal.addEventListener('abort', onSignal, { once: true });
  if (controller.signal.aborted) onSignal();
  else request.pipe(parser);
  try {
    await done;
    if (staged === undefined)
      throw new MediaError('MEDIA_FILE_REQUIRED', '請選擇媒體。');
    const result = await staged;
    if (failure !== undefined) {
      await service.discard(result);
      throw failure;
    }
    return result;
  } catch (error) {
    controller.abort();
    if (staged !== undefined) {
      try {
        await service.discard(await staged);
      } catch {
        /* stageSource already removed its own failed staging */
      }
    }
    throw error;
  } finally {
    clearTimeout(idle);
    clearTimeout(deadline);
    request.off('data', onData);
    request.off('aborted', onAbort);
    request.off('error', onAbort);
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onSignal);
    request.unpipe(parser);
    parser.destroy();
  }
}
