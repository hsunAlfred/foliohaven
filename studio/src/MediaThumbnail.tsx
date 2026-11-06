import { Icon } from './Icon.js';
import { useState } from 'react';
import type { MediaSourceResource } from '@foliohaven/core';
import { imageOutputs, mediaFileUrl, thumbnailImage } from './media-display.js';

export function MediaThumbnail({
  source,
  path,
  className = '',
}: {
  source: MediaSourceResource;
  path?: string;
  className?: string;
}) {
  const output =
    path === undefined
      ? thumbnailImage(source)
      : imageOutputs(source).find((image) => image.publicPath === path);
  const image = path ?? output?.publicPath;
  const [failedPath, setFailedPath] = useState<string | null>(null);
  return (
    <span className={`media-thumbnail ${className}`.trim()}>
      {image && image !== failedPath ? (
        <img
          src={mediaFileUrl(image)}
          alt=""
          loading="lazy"
          decoding="async"
          width={output?.width}
          height={output?.height}
          onError={() => setFailedPath(image)}
        />
      ) : (
        <span className="media-thumbnail__empty">
          <Icon name={source.kind === 'video' ? 'video' : 'image'} size={30} />
          {image ? '預覽無法載入' : '等待處理'}
        </span>
      )}
      {source.kind === 'video' && (
        <span className="media-thumbnail__video" aria-label="影片">
          <Icon name="build" size={14} /> {source.durationSeconds?.toFixed(1)}{' '}
          秒
        </span>
      )}
    </span>
  );
}
