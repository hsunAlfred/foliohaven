import { describe, expect, it } from 'vitest';
import {
  SiteConfigSchema,
  FixedPageSchema,
  buildSiteIconSet,
  siteIconMediaRefs,
  buildSiteModel,
  MediaListQuerySchema,
  filterMediaSources,
  MediaOutputSchema,
  ManagedImagePathSchema,
  MediaManifestSchema,
} from '@foliohaven/core';

const first = '873e8d4a-72fb-4818-a676-791e8529d98c';
const second = '94d777b3-d3a5-4bf7-95ec-d3e3561702a8';
const base = {
  siteName: 'Foliohaven icon fixture',
  siteDescription: 'Development notes',
  siteUrl: 'https://example.invalid/',
  author: { name: 'Author' },
};
const settings = (overrides: Record<string, unknown> = {}) =>
  SiteConfigSchema.parse({ ...base, ...overrides });
const fixedPages = [
  FixedPageSchema.parse({
    id: 'home',
    path: '/',
    entry: 'src/pages/index.astro',
  }),
  FixedPageSchema.parse({
    id: 'articles',
    path: '/articles/',
    entry: 'src/pages/articles/index.astro',
  }),
];

describe('complete website icon configuration', () => {
  it('preserves the legacy single icon until explicitly enabled', () => {
    const site = settings({ favicon: `/media/${first}/image.svg` });
    const view = buildSiteIconSet(site);
    expect(site.icons.enabled).toBe(false);
    expect(view.icons).toEqual([
      { href: site.favicon, type: 'image/svg+xml', sizes: 'any' },
    ]);
    expect(view).toMatchObject({
      manifest: null,
      appleTouchIcon: null,
      maskIcon: null,
      themeLight: null,
      themeDark: null,
    });
    expect(siteIconMediaRefs(site)).toEqual([site.favicon]);
  });

  it('uses every enabled App and color setting, with independent SVG mask selection', () => {
    const site = settings({
      favicon: `/media/${first}/image.svg`,
      icons: {
        enabled: true,
        appName: 'Actual App',
        shortName: 'Actual Short',
        display: 'minimal-ui',
        backgroundColor: '#d8d0c4',
        themeLight: '#e8dcc8',
        themeDark: '#303a45',
        maskColor: '#735d83',
        maskIcon: `/media/${second}/image.svg`,
      },
    });
    const view = buildSiteIconSet(site);
    expect(view.icons).toEqual(
      expect.arrayContaining([
        {
          href: `/media/${first}/favicon-16.png`,
          type: 'image/png',
          sizes: '16x16',
        },
        {
          href: `/media/${first}/favicon.png`,
          type: 'image/png',
          sizes: '32x32',
        },
        {
          href: `/media/${first}/favicon-48.png`,
          type: 'image/png',
          sizes: '48x48',
        },
        { href: `/media/${first}/favicon.ico`, type: 'image/x-icon' },
      ]),
    );
    expect(view).toMatchObject({
      appleTouchIcon: `/media/${first}/apple-touch-icon.png`,
      maskIcon: { href: `/media/${second}/mask-icon.svg`, color: '#735d83' },
      themeLight: '#e8dcc8',
      themeDark: '#303a45',
    });
    expect(view.manifest?.data).toEqual({
      id: '/',
      name: 'Actual App',
      short_name: 'Actual Short',
      description: 'Development notes',
      start_url: '/',
      scope: '/',
      display: 'minimal-ui',
      theme_color: '#e8dcc8',
      background_color: '#d8d0c4',
      icons: [192, 512].map((size) => ({
        src: `/media/${first}/icon-${size}.png`,
        sizes: `${size}x${size}`,
        type: 'image/png',
        purpose: 'any',
      })),
    });
    const refs = siteIconMediaRefs(site);
    expect(refs).toContain(`/media/${second}/mask-icon.svg`);
    expect(refs).toContain(`/media/${first}/icon-512.png`);
    expect(refs).not.toContain('/site.webmanifest');
    const model = buildSiteModel({
      site,
      articles: [],
      categories: [],
      tags: [],
      fixedPages,
    });
    expect(model.routeManifest.assets).toContain('/site.webmanifest');
    expect(model.mediaRefs).toEqual(expect.arrayContaining([...refs]));
  });

  it('supports separate switches, inherited names and SVG mask fallback without duplicate links', () => {
    const site = settings({
      favicon: `/media/${first}/favicon.png`,
      icons: { enabled: true, appleTouch: false, manifest: false },
    });
    const view = buildSiteIconSet(site);
    expect(view.appleTouchIcon).toBeNull();
    expect(view.manifest).toBeNull();
    expect(
      view.icons.filter((icon) => icon.href === site.favicon),
    ).toHaveLength(1);
    expect(
      buildSiteIconSet(
        settings({
          favicon: `/media/${first}/image.svg`,
          icons: { enabled: true },
        }),
      ).maskIcon?.href,
    ).toBe(`/media/${first}/mask-icon.svg`);
    expect(
      buildSiteIconSet(
        settings({
          favicon: `/media/${first}/favicon.png`,
          icons: { enabled: true },
        }),
      ).manifest?.data.name,
    ).toBe(base.siteName);
    const disabled = settings({
      favicon: site.favicon,
      icons: {
        ...site.icons,
        enabled: false,
        maskIcon: `/media/${second}/image.svg`,
      },
    });
    expect(siteIconMediaRefs(disabled)).toEqual([site.favicon]);
    expect(
      buildSiteModel({
        site: disabled,
        articles: [],
        categories: [],
        tags: [],
        fixedPages,
      }).routeManifest.assets,
    ).not.toContain('/site.webmanifest');
    expect(
      buildSiteIconSet(settings({ icons: { enabled: true } })).manifest,
    ).toBeNull();
  });

  it('rejects unsafe colors, non-SVG masks and unsupported display values', () => {
    for (const icons of [
      { maskColor: 'url(https://example.invalid/)' },
      { themeLight: '#fff' },
      { themeDark: 'transparent' },
      { maskIcon: `/media/${first}/image.webp` },
      { display: 'fullscreen' },
      { shortName: 'a'.repeat(41) },
    ])
      expect(SiteConfigSchema.safeParse({ ...base, icons }).success).toBe(
        false,
      );
  });

  it('publishes only requested platform icons while preserving the existing article asset closure', () => {
    const output = (file: string, mimeType: string, size: number) => ({
      publicPath: `/media/${first}/${file}`,
      mimeType,
      width: size,
      height: size,
      byteSize: 99,
      sha256: 'a'.repeat(64),
    });
    const mediaManifest = MediaManifestSchema.parse({
      schemaVersion: 1,
      assets: [
        {
          id: first,
          kind: 'image',
          sourceSha256: 'b'.repeat(64),
          presetVersion: 'site-icons-v1',
          tools: { sharp: 'fixture' },
          outputs: [
            output('image.webp', 'image/webp', 512),
            output('image.svg', 'image/svg+xml', 512),
            output('favicon.png', 'image/png', 32),
            output('favicon.ico', 'image/x-icon', 48),
            output('favicon-16.png', 'image/png', 16),
            output('favicon-48.png', 'image/png', 48),
            output('apple-touch-icon.png', 'image/png', 180),
            output('icon-192.png', 'image/png', 192),
            output('icon-512.png', 'image/png', 512),
            output('mask-icon.svg', 'image/svg+xml', 16),
          ],
        },
      ],
    });
    const model = (icons: Record<string, unknown>) =>
      buildSiteModel({
        site: settings({ favicon: `/media/${first}/image.svg`, icons }),
        articles: [],
        categories: [],
        tags: [],
        fixedPages,
        mediaManifest,
      });
    expect(model({ enabled: true }).mediaRefs).toHaveLength(10);
    const browsersOnly = model({
      enabled: true,
      appleTouch: false,
      manifest: false,
    });
    for (const file of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png'])
      expect(browsersOnly.mediaRefs).not.toContain(`/media/${first}/${file}`);
    expect(browsersOnly.mediaRefs).toContain(`/media/${first}/favicon.ico`);
    expect(browsersOnly.mediaRefs).toContain(`/media/${first}/mask-icon.svg`);
    const disabled = model({ enabled: false });
    expect(disabled.mediaRefs).toEqual([
      `/media/${first}/favicon.png`,
      `/media/${first}/image.svg`,
      `/media/${first}/image.webp`,
    ]);
  });

  it('validates exact public icon dimensions and isolates format filtering', () => {
    for (const [file, size] of [
      ['favicon-16.png', 16],
      ['favicon-48.png', 48],
      ['apple-touch-icon.png', 180],
      ['icon-192.png', 192],
      ['icon-512.png', 512],
    ] as const) {
      const output = {
        publicPath: `/media/${first}/${file}`,
        mimeType: 'image/png',
        width: size,
        height: size,
        byteSize: 99,
        sha256: 'a'.repeat(64),
      };
      expect(ManagedImagePathSchema.safeParse(output.publicPath).success).toBe(
        true,
      );
      expect(MediaOutputSchema.safeParse(output).success).toBe(true);
      expect(
        MediaOutputSchema.safeParse({ ...output, width: size + 1 }).success,
      ).toBe(false);
    }
    const rows = [
      {
        id: first,
        kind: 'image' as const,
        displayName: 'Alpha',
        source: 'original.svg',
      },
      {
        id: second,
        kind: 'image' as const,
        displayName: 'Beta',
        source: 'original.ico',
      },
    ];
    expect(
      filterMediaSources(
        rows,
        MediaListQuerySchema.parse({ format: 'svg' }),
      ).items.map((item) => item.id),
    ).toEqual([first]);
    expect(
      filterMediaSources(
        rows,
        MediaListQuerySchema.parse({ format: 'ico' }),
      ).items.map((item) => item.id),
    ).toEqual([second]);
  });
});
