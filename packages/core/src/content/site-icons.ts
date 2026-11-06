import type {
  SiteConfig,
  SiteIconLink,
  SiteIconSetViewModel,
} from '../models/index.js';

const mediaPrefix = (path: string) => `/media/${path.split('/')[2] ?? ''}/`;
export function buildSiteIconSet(site: SiteConfig): SiteIconSetViewModel {
  const links: SiteIconLink[] = [];
  const settings = site.icons;
  const prefix = site.favicon === null ? null : mediaPrefix(site.favicon);
  if (settings.enabled && prefix !== null) {
    links.push({
      href: `${prefix}favicon.ico`,
      type: 'image/x-icon',
    });
    for (const [file, size] of [
      ['favicon-16.png', 16],
      ['favicon.png', 32],
      ['favicon-48.png', 48],
    ] as const)
      links.push({
        href: prefix + file,
        type: 'image/png',
        sizes: `${size}x${size}`,
      });
  }
  if (site.favicon !== null) {
    const path = site.favicon;
    links.push({
      href: path,
      type: path.endsWith('.svg')
        ? 'image/svg+xml'
        : path.endsWith('.ico')
          ? 'image/x-icon'
          : path.endsWith('.png')
            ? 'image/png'
            : 'image/webp',
      ...(path.endsWith('.svg')
        ? { sizes: 'any' }
        : path.endsWith('/favicon.png')
          ? { sizes: '32x32' }
          : {}),
    });
  }
  const icons = links.filter(
    (link, index) =>
      links.findIndex((other) => other.href === link.href) === index,
  );
  const maskSource = settings.enabled
    ? (settings.maskIcon ??
      (site.favicon?.endsWith('.svg') ? site.favicon : null))
    : null;
  return {
    icons,
    appleTouchIcon:
      settings.enabled && settings.appleTouch && prefix !== null
        ? `${prefix}apple-touch-icon.png`
        : null,
    maskIcon:
      maskSource === null
        ? null
        : {
            href: `${mediaPrefix(maskSource)}mask-icon.svg`,
            color: settings.maskColor,
          },
    manifest:
      settings.enabled && settings.manifest && prefix !== null
        ? {
            href: '/site.webmanifest',
            data: {
              id: '/',
              name: settings.appName ?? site.siteName,
              short_name: settings.shortName ?? site.siteName,
              description: site.siteDescription,
              start_url: '/',
              scope: '/',
              display: settings.display,
              theme_color: settings.themeLight,
              background_color: settings.backgroundColor,
              icons: [192, 512].map((size) => ({
                src: `${prefix}icon-${size}.png`,
                sizes: `${size}x${size}`,
                type: 'image/png',
                purpose: 'any',
              })),
            },
          }
        : null,
    themeLight: settings.enabled ? settings.themeLight : null,
    themeDark: settings.enabled ? settings.themeDark : null,
  };
}

export function siteIconMediaRefs(site: SiteConfig): readonly string[] {
  const view = buildSiteIconSet(site);
  return [
    ...new Set([
      ...view.icons.map((item) => item.href),
      ...(view.appleTouchIcon === null ? [] : [view.appleTouchIcon]),
      ...(view.maskIcon === null ? [] : [view.maskIcon.href]),
      ...(view.manifest?.data.icons.map((item) => item.src) ?? []),
    ]),
  ];
}
