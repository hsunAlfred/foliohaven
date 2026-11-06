import { mediaImageGroup, type MediaSourceResource } from '@foliohaven/core';

export type ImagePreference = 'social' | 'favicon' | 'mask';
export type MediaFileFormat = 'svg' | 'ico';

export const mediaFileUrl = (path: string) =>
  path.replace('/media/', '/api/v1/media/files/');

export function canPreviewMediaUpload(file: Pick<File, 'name' | 'type'>) {
  return (
    !/\.(?:svg|ico)$/iu.test(file.name) &&
    !['image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(
      file.type.toLowerCase(),
    )
  );
}

export function mediaUploadFile(file: File): File {
  if (file.type) return file;
  const mimeType = /\.svg$/iu.test(file.name)
    ? 'image/svg+xml'
    : /\.ico$/iu.test(file.name)
      ? 'image/x-icon'
      : undefined;
  return mimeType
    ? new File([file], file.name, {
        type: mimeType,
        lastModified: file.lastModified,
      })
    : file;
}

export function mediaUploadAccept(
  imagesOnly: boolean,
  format?: MediaFileFormat,
) {
  if (format) return `.${format}`;
  return imagesOnly
    ? '.jpg,.jpeg,.png,.webp,.avif,.svg,.ico'
    : '.jpg,.jpeg,.png,.webp,.avif,.svg,.ico,.mp4,.mov,.webm';
}

export function matchesMediaUploadFormat(
  file: Pick<File, 'name'>,
  format: MediaFileFormat | undefined,
) {
  if (format === 'svg') return /\.svg$/iu.test(file.name);
  if (format === 'ico') return /\.ico$/iu.test(file.name);
  return true;
}

export function imageOutputs(source: MediaSourceResource) {
  return (
    source.asset?.outputs.filter((output) =>
      output.mimeType.startsWith('image/'),
    ) ?? []
  );
}

export function selectableImageOutputs(
  source: MediaSourceResource,
  preference: ImagePreference | undefined,
) {
  const outputs = imageOutputs(source);
  return preference === 'mask'
    ? outputs.filter((output) => output.publicPath.endsWith('/mask-icon.svg'))
    : outputs;
}

export function primaryImage(source: MediaSourceResource) {
  return imageOutputs(source).find((output) =>
    output.publicPath.endsWith(
      source.kind === 'image' ? '/image.webp' : '/poster.webp',
    ),
  );
}

export function nativeImage(source: MediaSourceResource) {
  const variant =
    source.mimeType === 'image/svg+xml'
      ? '/image.svg'
      : source.mimeType === 'image/x-icon'
        ? '/favicon.ico'
        : undefined;
  return variant
    ? imageOutputs(source).find((output) => output.publicPath.endsWith(variant))
    : undefined;
}

export function thumbnailImage(source: MediaSourceResource) {
  if (source.kind === 'video') return primaryImage(source);
  const images = imageOutputs(source)
    .filter(
      (output) =>
        mediaImageGroup(output.publicPath) === 'responsive' &&
        /\/image(?:-[1-9]\d*)?\.webp$/u.test(output.publicPath),
    )
    .sort((left, right) => left.width - right.width);
  return (
    images.find((output) => output.width >= 480) ??
    images.at(-1) ??
    primaryImage(source)
  );
}

export function preferredImage(
  source: MediaSourceResource,
  preference: ImagePreference | undefined,
) {
  if (preference === 'mask')
    return selectableImageOutputs(source, preference)[0];
  if (preference === 'favicon') {
    const native = nativeImage(source);
    if (native) return native;
  }
  const variant =
    preference === 'social' ? '/image-social.webp' : '/favicon.png';
  return (
    (preference &&
      imageOutputs(source).find((output) =>
        output.publicPath.endsWith(variant),
      )) ||
    primaryImage(source)
  );
}

export function needsPreferredImages(
  source: MediaSourceResource,
  preference: ImagePreference | undefined,
) {
  if (!preference || source.kind !== 'image') return false;
  const paths = imageOutputs(source).map((output) => output.publicPath);
  const variants =
    preference === 'mask'
      ? ['/mask-icon.svg']
      : preference === 'social'
        ? ['/image-social.webp', '/image-social-crop.webp']
        : ['/favicon.png'];
  return variants.some(
    (variant) => !paths.some((path) => path.endsWith(variant)),
  );
}

export function imageSizeLabel(path: string) {
  if (path.endsWith('/mask-icon.svg')) return 'Safari pinned tab・單色 SVG';
  if (path.endsWith('/favicon-16.png')) return '瀏覽器圖示・16 × 16 PNG';
  if (path.endsWith('/favicon-48.png')) return '瀏覽器圖示・48 × 48 PNG';
  if (path.endsWith('/apple-touch-icon.png')) return 'Apple Touch Icon・PNG';
  if (path.endsWith('/icon-192.png')) return 'App 圖示・192 × 192 PNG';
  if (path.endsWith('/icon-512.png')) return 'App 圖示・512 × 512 PNG';
  if (path.endsWith('/image.svg')) return 'SVG・向量圖';
  if (path.endsWith('/favicon.ico')) return 'ICO・原生圖示';
  if (path.endsWith('/image-social.webp')) return '分享圖片・完整補邊';
  if (path.endsWith('/image-social-crop.webp')) return '分享圖片・裁切填滿';
  if (path.endsWith('/favicon.png')) return 'Favicon・PNG';
  if (path.endsWith('/image.webp')) return '網站主要圖片';
  if (path.endsWith('/poster.webp')) return '影片封面';
  return '較小尺寸';
}
