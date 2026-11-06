import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  siteManifestResponse as GET,
  siteManifestPaths as getStaticPaths,
} from '../../site/src/lib/server/site-webmanifest.js';

const reader = vi.hoisted(() => ({ home: vi.fn() }));
vi.mock('../../site/src/lib/server/context.js', () => ({
  loadHomePage: reader.home,
}));

beforeEach(() => {
  reader.home.mockReset();
});

describe('conditional public web manifest', () => {
  it.each([{ favicon: null }, { iconSet: { manifest: null } }])(
    'does not emit an endpoint for a legacy or disabled model',
    async (site) => {
      reader.home.mockResolvedValue({ site });
      expect(await getStaticPaths()).toEqual([]);
      const response = await GET();
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    },
  );

  it('serializes the Core manifest without rebuilding its settings', async () => {
    const data = {
      id: '/',
      name: 'Foliohaven 範例網站',
      short_name: 'Foliohaven',
      description: '文章、頁面與網站設定。',
      start_url: '/',
      scope: '/',
      display: 'browser',
      theme_color: '#625273',
      background_color: '#ede8df',
      icons: [
        {
          src: '/media/123e4567-e89b-42d3-a456-426614174000/icon-192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any',
        },
      ],
    };
    reader.home.mockResolvedValue({
      site: {
        iconSet: { manifest: { href: '/site.webmanifest', data } },
      },
    });
    expect(await getStaticPaths()).toEqual([
      { params: { siteManifest: 'site' } },
    ]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/manifest+json; charset=utf-8',
    );
    expect(await response.json()).toEqual(data);
  });

  it('keeps a failed source read visible instead of emitting stale or blank data', async () => {
    const failure = new Error('RENDER_CONTEXT_INVALID');
    reader.home.mockRejectedValue(failure);
    await expect(getStaticPaths()).rejects.toBe(failure);
    await expect(GET()).rejects.toBe(failure);
  });
});
