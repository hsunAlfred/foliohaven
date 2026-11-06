import type { ImageViewModel } from '@foliohaven/core';

export interface ManagedImageProps {
  readonly image: ImageViewModel;
  readonly priority?: boolean;
  readonly className?: string;
}
export function ManagedImage({
  image,
  priority = false,
  className,
}: ManagedImageProps) {
  return (
    <img
      className={className}
      src={image.src}
      alt={image.alt}
      width={image.width}
      height={image.height}
      {...(image.srcset === null ? {} : { srcSet: image.srcset })}
      {...(image.sizes === null ? {} : { sizes: image.sizes })}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      {...(priority ? { fetchPriority: 'high' } : {})}
    />
  );
}
