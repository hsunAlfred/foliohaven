import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { SiteConfigSchema, SiteIconsSchema } from '@foliohaven/core';
import type { MediaOutput, MediaSourceResource } from '@foliohaven/core';
import { StudioApi } from '../../studio/src/api.js';
import {
  firstMissingSiteIconSource,
  siteIconSourceRequirements,
} from '../../studio/src/site-icon-preparation.js';
import { SiteIconSettings } from '../../studio/src/SiteIconSettings.js';
import { MediaUploadDialog } from '../../studio/src/MediaUpload.js';
import { mediaMarkup } from '../../studio/src/media-markup.js';
import {
  imageSizeLabel,
  matchesMediaUploadFormat,
  mediaUploadAccept,
  needsPreferredImages,
  preferredImage,
  selectableImageOutputs,
  thumbnailImage,
} from '../../studio/src/media-display.js';
import {
  siteSettingsFieldLabel,
  siteSettingsIssues,
} from '../../studio/src/site-settings-validation.js';

function controls(html: string) {
  const values = new Map<
    string,
    { attrs: Record<string, string>; disabled: boolean }
  >();
  function visit(node: DefaultTreeAdapterMap['node'], disabled = false) {
    const attrs = Object.fromEntries(
      ('attrs' in node ? node.attrs : []).map((attr) => [
        attr.name,
        attr.value,
      ]),
    );
    const inactive = disabled || Object.hasOwn(attrs, 'disabled');
    if (attrs['data-field'])
      values.set(attrs['data-field'], { attrs, disabled: inactive });
    for (const child of 'childNodes' in node ? node.childNodes : [])
      visit(child, inactive);
  }
  visit(parseFragment(html));
  return values;
}
const id = '1791257a-aa80-4d3e-9a57-6bd43999e023';
function output(
  variant: string,
  width: number,
  mimeType: MediaOutput['mimeType'] = 'image/png',
): MediaOutput {
  return {
    publicPath: `/media/${id}/${variant}`,
    width,
    height: width,
    mimeType,
    byteSize: 100,
    sha256: 'a'.repeat(64),
  };
}
function source(): MediaSourceResource {
  return {
    id,
    kind: 'image',
    displayName: 'SVG 圖示',
    mimeType: 'image/svg+xml',
    width: 512,
    height: 512,
    byteSize: 1000,
    posterTimeSeconds: null,
    durationSeconds: null,
    sourceSha256: 'b'.repeat(64),
    asset: {
      id,
      kind: 'image',
      sourceSha256: 'b'.repeat(64),
      presetVersion: 'site-icons-v1',
      tools: { sharp: 'test' },
      outputs: [
        output('image.webp', 512, 'image/webp'),
        output('image-480.webp', 480, 'image/webp'),
        output('image.svg', 512, 'image/svg+xml'),
        output('mask-icon.svg', 16, 'image/svg+xml'),
        output('favicon.png', 32),
        output('favicon-16.png', 16),
        output('favicon-48.png', 48),
        output('apple-touch-icon.png', 180),
        output('icon-192.png', 192),
        output('icon-512.png', 512),
        output('favicon.ico', 256, 'image/x-icon'),
      ],
    },
  };
}

describe('Studio complete site icon settings', () => {
  it('shows Core defaults without enabling or writing an older buffer', () => {
    const changed = vi.fn();
    const html = renderToStaticMarkup(
      <SiteIconSettings
        api={new StudioApi()}
        favicon={null}
        onFaviconChange={() => undefined}
        value={undefined}
        disabled={false}
        onChange={changed}
      />,
    );
    const values = controls(html);
    expect(values.get('icons.enabled')?.attrs).not.toHaveProperty('checked');
    expect(values.get('icons.enabled')?.disabled).toBe(false);
    expect(values.get('icons.appleTouch')?.attrs).toHaveProperty('checked');
    expect(values.get('icons.manifest')?.attrs).toHaveProperty('checked');
    for (const field of [
      'icons.appleTouch',
      'icons.manifest',
      'icons.appName',
      'icons.themeLight',
      'icons.themeDark',
    ])
      expect(values.get(field)?.disabled).toBe(true);
    expect(values.get('icons.themeLight')?.attrs.value).toBe('#ffffff');
    expect(values.get('icons.themeDark')?.attrs.value).toBe('#262626');
    expect(values.get('icons.appName')?.attrs.value).toBe('');
    expect(html).toContain('留空時使用網站名稱');
    expect(html).not.toContain('value="#000000"');
    expect(values.get('icons.maskColor')?.attrs.value).toBe('#404040');
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps inactive custom values and makes the whole group read-only when requested', () => {
    const value = Object.freeze(
      SiteIconsSchema.parse({
        enabled: false,
        appName: 'Example App',
        shortName: 'Example',
        themeDark: '#2c343f',
      }),
    );
    const changed = vi.fn();
    const html = renderToStaticMarkup(
      <SiteIconSettings
        api={new StudioApi()}
        favicon={null}
        onFaviconChange={() => undefined}
        value={value}
        disabled
        onChange={changed}
      />,
    );
    const values = controls(html);
    expect([...values.values()].every((control) => control.disabled)).toBe(
      true,
    );
    expect(values.get('icons.appName')?.attrs.value).toBe('Example App');
    expect(values.get('icons.shortName')?.attrs.value).toBe('Example');
    expect(values.get('icons.themeDark')?.attrs.value).toBe('#2c343f');
    expect(changed).not.toHaveBeenCalled();
    expect(value.themeDark).toBe('#2c343f');
  });

  it('retains invalid HEX text for validation while rendering a safe color picker fallback', () => {
    const value = {
      ...SiteIconsSchema.parse({ enabled: true }),
      themeDark: '#badhex',
    };
    const html = renderToStaticMarkup(
      <SiteIconSettings
        api={new StudioApi()}
        favicon={null}
        onFaviconChange={() => undefined}
        value={value}
        disabled={false}
        onChange={() => undefined}
      />,
    );
    expect(controls(html).get('icons.themeDark')?.attrs.value).toBe('#badhex');
    expect(html).toContain(
      'type="color" aria-label="深色模式瀏覽器色彩色票" value="#262626"',
    );
  });

  it.each([
    ['enabled', '產生多尺寸圖示'],
    ['appleTouch', 'Apple Touch 圖示'],
    ['manifest', 'Web App Manifest'],
    ['maskIcon', 'Safari pinned tab 圖示'],
    ['maskColor', 'Safari 圖示色彩'],
    ['themeLight', '淺色模式瀏覽器色彩'],
    ['themeDark', '深色模式瀏覽器色彩'],
    ['backgroundColor', '啟動畫面背景色'],
    ['appName', 'App 名稱'],
    ['shortName', 'App 短名稱'],
    ['display', 'App 顯示模式'],
  ])('provides the actionable settings label for icons.%s', (field, label) => {
    expect(siteSettingsFieldLabel(['icons', field])).toBe(label);
    const issue = siteSettingsIssues({
      issues: [{ path: ['icons', field], message: 'Invalid input' }],
    });
    expect(issue).toHaveLength(1);
    expect(issue[0]?.path).toEqual(['icons', field]);
    expect(issue[0]?.message).not.toBe('Invalid input');
  });

  it('turns Core color and mask validation into the correct field hints', () => {
    const result = SiteIconsSchema.safeParse({
      themeDark: '#oops',
      maskIcon: `/media/${id}/favicon.png`,
    });
    if (result.success)
      throw new Error('Invalid icon fixture passed validation');
    const fullPaths = result.error.issues.map((issue) => ({
      ...issue,
      path: ['icons', ...issue.path],
    }));
    const formatted = siteSettingsIssues({ issues: fullPaths });
    expect(
      formatted.find((issue) => issue.path.join('.') === 'icons.themeDark')
        ?.message,
    ).toContain('深色模式');
    expect(
      formatted.find((issue) => issue.path.join('.') === 'icons.maskIcon')
        ?.message,
    ).toContain('SVG');
  });

  it('uses only the generated Safari mask SVG for mask choices', () => {
    const media = source();
    const choices = selectableImageOutputs(media, 'mask');
    expect(choices.map((item) => item.publicPath)).toEqual([
      `/media/${id}/mask-icon.svg`,
    ]);
    expect(preferredImage(media, 'mask')).toBe(choices[0]);
    expect(needsPreferredImages(media, 'mask')).toBe(false);
    const withoutMask = {
      ...media,
      asset: media.asset && {
        ...media.asset,
        outputs: media.asset.outputs.filter(
          (item) => !item.publicPath.endsWith('/mask-icon.svg'),
        ),
      },
    };
    expect(selectableImageOutputs(withoutMask, 'mask')).toEqual([]);
    expect(preferredImage(withoutMask, 'mask')).toBeUndefined();
    expect(needsPreferredImages(withoutMask, 'mask')).toBe(true);
    expect(preferredImage(media, 'favicon')?.publicPath).toBe(
      `/media/${id}/image.svg`,
    );
  });

  it('limits Safari upload controls to SVG while retaining generic upload support', () => {
    expect(mediaUploadAccept(true, 'svg')).toBe('.svg');
    expect(matchesMediaUploadFormat({ name: 'mask.SVG' }, 'svg')).toBe(true);
    expect(matchesMediaUploadFormat({ name: 'icon.ico' }, 'svg')).toBe(false);
    expect(matchesMediaUploadFormat({ name: 'photo.png' }, 'svg')).toBe(false);
    expect(mediaUploadAccept(true)).toContain('.svg,.ico');
    const html = renderToStaticMarkup(
      <MediaUploadDialog
        api={new StudioApi()}
        writable
        imagesOnly
        format="svg"
        onClose={() => undefined}
        onUploaded={() => undefined}
      />,
    );
    expect(html).toContain('accept=".svg"');
    expect(html).not.toContain('.png,.webp');
  });

  it('keeps fixed-size app icons out of ordinary thumbnails and copied responsive HTML', () => {
    const media = source();
    expect(thumbnailImage(media)?.publicPath).toBe(
      `/media/${id}/image-480.webp`,
    );
    if (!media.asset) throw new Error('Missing fixture asset');
    const html = mediaMarkup(media.asset);
    expect(html).toContain(
      `srcset="/media/${id}/image-480.webp 480w, /media/${id}/image.webp 512w"`,
    );
    expect(html).not.toMatch(
      /favicon|mask-icon|apple-touch|icon-192|icon-512/u,
    );
    expect(imageSizeLabel(`/media/${id}/apple-touch-icon.png`)).toContain(
      'Apple Touch',
    );
    expect(imageSizeLabel(`/media/${id}/mask-icon.svg`)).toContain(
      'Safari pinned tab',
    );
  });
});

describe('Studio prepares complete site icons before saving', () => {
  const site = (overrides: Record<string, unknown> = {}) =>
    SiteConfigSchema.parse({
      siteName: 'Test site',
      siteDescription: 'Test description',
      siteUrl: 'https://example.com/',
      favicon: `/media/${id}/image.svg`,
      author: { name: 'Author' },
      icons: { enabled: true },
      ...overrides,
    });
  const response = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('leaves the legacy disabled mode alone without reading or processing media', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await firstMissingSiteIconSource(
        new StudioApi(fetcher),
        site({ icons: { enabled: false } }),
      ),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('finds the missing pack of an otherwise valid ordinary SVG', async () => {
    const media = source();
    if (!media.asset) throw new Error('Fixture needs outputs');
    media.asset.outputs = media.asset.outputs.filter((item) =>
      ['image.webp', 'image.svg', 'favicon.png'].some((name) =>
        item.publicPath.endsWith(`/${name}`),
      ),
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(media));
    const missing = await firstMissingSiteIconSource(
      new StudioApi(fetcher),
      site(),
    );
    expect(missing?.sourceId).toBe(id);
    expect(missing?.missingPaths).toContain(`/media/${id}/icon-512.png`);
    expect(missing?.missingPaths).toContain(`/media/${id}/mask-icon.svg`);
    expect(missing?.missingPaths).not.toContain(`/media/${id}/image.svg`);
  });

  it('reuses complete output sets for color-only settings without starting work', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response(source()));
    const settings = site({ icons: { enabled: true, themeDark: '#334455' } });
    expect(
      await firstMissingSiteIconSource(new StudioApi(fetcher), settings),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('groups an independent Safari SVG separately and checks it after the primary source', async () => {
    const maskId = '794c066c-d096-4d7a-a619-d0394fc3224f';
    const settings = site({
      icons: { enabled: true, maskIcon: `/media/${maskId}/image.svg` },
    });
    expect([...siteIconSourceRequirements(settings).keys()]).toEqual([
      id,
      maskId,
    ]);
    const mask = { ...source(), id: maskId, asset: null };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (path) =>
        response(String(path).endsWith(maskId) ? mask : source()),
      );
    expect(
      await firstMissingSiteIconSource(new StudioApi(fetcher), settings),
    ).toEqual({
      sourceId: maskId,
      missingPaths: [`/media/${maskId}/mask-icon.svg`],
    });
  });

  it('propagates unknown sources and does not treat a failed lookup as readiness', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'MEDIA_NOT_FOUND',
            message: 'No source',
            issues: [],
            requestId: id,
            retryable: false,
          },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(
      firstMissingSiteIconSource(new StudioApi(fetcher), site()),
    ).rejects.toMatchObject({ status: 404, code: 'MEDIA_NOT_FOUND' });
  });

  it('describes automatic Safari fallback and keeps its color editable without an explicit mask', () => {
    const html = renderToStaticMarkup(
      <SiteIconSettings
        api={new StudioApi()}
        favicon={null}
        onFaviconChange={() => undefined}
        value={SiteIconsSchema.parse({ enabled: true })}
        disabled={false}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('自動使用 SVG 網站圖示');
    expect(html).toContain('主圖為 PNG 或 ICO 時不產生 Safari 圖示');
    expect(controls(html).get('icons.maskColor')?.disabled).toBe(false);
  });
});
