import { fileURLToPath } from 'node:url';
import { ProcessFailure, runControlledProcess } from '../runtime/process.js';
import { buildProcessEnvironment } from '../runtime/environment.js';
import { MediaError } from './errors.js';
import type { MediaInspection, MediaTaskOptions } from './types.js';

export interface WorkerOutput {
  readonly variant: string;
  readonly mimeType:
    | 'image/webp'
    | 'image/png'
    | 'image/svg+xml'
    | 'image/x-icon'
    | 'video/webm';
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly sha256: string;
  readonly durationSeconds?: number;
}
export interface WorkerResult {
  readonly inspection: MediaInspection;
  readonly outputs: readonly WorkerOutput[];
  readonly tools: {
    readonly sharp: string;
    readonly libvips: string;
    readonly ffmpeg?: string;
    readonly ffprobe?: string;
  };
}
export interface WorkerInput {
  readonly iconSet?: boolean;
  readonly action: 'inspect' | 'process' | 'verify';
  readonly sourcePath: string;
  readonly extension: string;
  readonly kind: 'image' | 'video';
  readonly outputDirectory?: string;
  readonly posterTimeSeconds?: number;
  readonly timeoutMs: number;
  readonly hasJobLease?: boolean;
}

export async function runMediaWorker(
  input: WorkerInput,
  fd: number,
  options: MediaTaskOptions = {},
): Promise<WorkerResult> {
  const source = import.meta.url.endsWith('.ts');
  const worker = fileURLToPath(
    new URL(source ? './worker.ts' : './worker.js', import.meta.url),
  );
  let progressBuffer = '';
  const observerController = new AbortController();
  const signal =
    options.signal === undefined
      ? observerController.signal
      : AbortSignal.any([options.signal, observerController.signal]);
  let observed: Promise<void> = Promise.resolve();
  let observerFailed = false;
  try {
    const result = await runControlledProcess({
      command: process.execPath,
      args: [
        ...(source ? ['--import', 'tsx'] : []),
        worker,
        JSON.stringify({
          ...input,
          ...(options.jobLeaseFd === undefined ? {} : { hasJobLease: true }),
        }),
      ],
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      timeoutMs: input.timeoutMs,
      env: buildProcessEnvironment(),
      keepStdinOpen: true,
      passFds: [
        fd,
        ...(options.jobLeaseFd === undefined ? [] : [options.jobLeaseFd]),
      ],
      signal,
      onOutput(stream, chunk) {
        if (stream !== 'stdout') return;
        progressBuffer += chunk.toString('utf8');
        const lines = progressBuffer.split('\n');
        progressBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('{"progress":')) continue;
          let progress: unknown;
          try {
            progress = JSON.parse(line);
          } catch {
            /* A malformed progress line cannot become a successful result. */
            continue;
          }
          if (
            typeof progress === 'object' &&
            progress !== null &&
            'progress' in progress
          ) {
            const update = progress.progress as Parameters<
              NonNullable<MediaTaskOptions['onProgress']>
            >[0];
            observed = observed
              .then(async () => {
                if (!observerFailed) await options.onProgress?.(update);
              })
              .catch(() => {
                observerFailed = true;
                observerController.abort();
              });
          }
        }
      },
    });
    await observed;
    if (observerFailed)
      throw new MediaError(
        'MEDIA_PROGRESS_FAILED',
        '媒體工作進度無法保存。',
        503,
        true,
      );
    const finalLine = result.stdout.toString('utf8').trim().split('\n').at(-1);
    if (finalLine === undefined)
      throw new MediaError(
        'MEDIA_WORKER_PROTOCOL',
        '媒體工作未回傳完整結果。',
        500,
      );
    const response = JSON.parse(finalLine) as {
      ok: boolean;
      result?: WorkerResult;
      error?: { code: string; message: string; status: number };
    };
    if (!response.ok || response.result === undefined)
      throw new MediaError(
        response.error?.code ?? 'MEDIA_DECODE_FAILED',
        response.error?.message ?? '媒體無法解碼或處理。',
        response.error?.status ?? 422,
      );
    return response.result;
  } catch (error) {
    await observed;
    if (observerFailed)
      throw new MediaError(
        'MEDIA_PROGRESS_FAILED',
        '媒體工作進度無法保存。',
        503,
        true,
      );
    if (error instanceof MediaError) throw error;
    if (error instanceof ProcessFailure)
      throw new MediaError(
        error.code === 'PROCESS_CANCELLED'
          ? 'MEDIA_CANCELLED'
          : error.code === 'PROCESS_TIMEOUT'
            ? 'MEDIA_TIMEOUT'
            : 'MEDIA_TOOL_UNAVAILABLE',
        error.code === 'PROCESS_CANCELLED'
          ? '媒體操作已取消。'
          : error.code === 'PROCESS_TIMEOUT'
            ? '媒體處理超過時間限制。'
            : '媒體工具無法完成處理。',
        error.code === 'PROCESS_CANCELLED' ? 409 : 503,
        true,
      );
    throw new MediaError(
      'MEDIA_WORKER_PROTOCOL',
      '媒體工作結果無法判讀。',
      500,
    );
  }
}
