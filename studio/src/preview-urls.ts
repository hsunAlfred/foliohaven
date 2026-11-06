import { RootPathSchema } from '@foliohaven/core';

declare const __ALFRED_SOURCE_PREVIEW_PORT__: number;
declare const __ALFRED_BUILT_PREVIEW_PORT__: number;

export function previewUrl(path: string, origin: string, port: number): string {
  RootPathSchema.parse(path);
  const url = new URL(origin);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new TypeError('預覽網址設定無效。');
  url.port = String(port);
  return new URL(path, url.origin).href;
}

function currentOrigin(): string {
  return typeof window === 'undefined'
    ? 'http://localhost'
    : window.location.origin;
}

export function sourcePreviewUrl(
  path: string,
  origin = currentOrigin(),
): string {
  const port =
    typeof __ALFRED_SOURCE_PREVIEW_PORT__ === 'number'
      ? __ALFRED_SOURCE_PREVIEW_PORT__
      : 4321;
  return previewUrl(path, origin, port);
}

export function builtPreviewUrl(
  path: string,
  origin = currentOrigin(),
): string {
  const port =
    typeof __ALFRED_BUILT_PREVIEW_PORT__ === 'number'
      ? __ALFRED_BUILT_PREVIEW_PORT__
      : 4322;
  return previewUrl(path, origin, port);
}
