import type { MediaAsset } from '@foliohaven/core';

const attr = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
export function mediaMarkup(asset: MediaAsset, alt = ''): string {
  if (asset.kind === 'image') {
    const image = asset.outputs.find((output) =>
      output.publicPath.endsWith('/image.webp'),
    );
    if (!image) return '';
    const images = asset.outputs
      .filter((output) =>
        /\/image(?:-[1-9]\d*)?\.webp$/u.test(output.publicPath),
      )
      .sort((left, right) => left.width - right.width);
    return `<img src="${attr(image.publicPath)}" alt="${attr(alt)}" width="${image.width}" height="${image.height}" srcset="${images.map((output) => `${attr(output.publicPath)} ${output.width}w`).join(', ')}" sizes="(max-width: 768px) 100vw, 768px">`;
  }
  const video = asset.outputs.find((output) =>
    output.publicPath.endsWith('/video.webm'),
  );
  const poster = asset.outputs.find((output) =>
    output.publicPath.endsWith('/poster.webp'),
  );
  if (!video || !poster) return '';
  return `<video controls width="${video.width}" height="${video.height}" poster="${attr(poster.publicPath)}"><source src="${attr(video.publicPath)}" type="video/webm"></video>`;
}
