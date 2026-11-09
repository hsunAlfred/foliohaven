import { describe, expect, it, vi } from 'vitest';
import {
  builtPreviewUrl,
  previewUrl,
  sourcePreviewUrl,
} from '../../studio/src/preview-urls.js';

describe('public preview links', () => {
  it('uses the Foliohaven compile-time ports when configured', () => {
    vi.stubGlobal('__FOLIOHAVEN_SOURCE_PREVIEW_PORT__', 8121);
    vi.stubGlobal('__FOLIOHAVEN_BUILT_PREVIEW_PORT__', 8122);
    expect(sourcePreviewUrl('/', 'http://localhost:5173')).toBe(
      'http://localhost:8121/',
    );
    expect(builtPreviewUrl('/', 'http://localhost:5173')).toBe(
      'http://localhost:8122/',
    );
  });
  it('uses the current Studio hostname and the distinct public preview ports', () => {
    const origin = 'http://192.168.5.4:5173';
    expect(sourcePreviewUrl('/rust/example/', origin)).toBe(
      'http://192.168.5.4:4321/rust/example/',
    );
    expect(builtPreviewUrl('/rust/example/', origin)).toBe(
      'http://192.168.5.4:4322/rust/example/',
    );
  });
  it('supports mapped ports and IPv6 without changing the requested article path', () => {
    expect(previewUrl('/ai-gpt/example/', 'http://[::1]:5173', 8123)).toBe(
      'http://[::1]:8123/ai-gpt/example/',
    );
    expect(previewUrl('/', 'https://preview.example.invalid/', 8443)).toBe(
      'https://preview.example.invalid:8443/',
    );
  });
  it.each([
    '//example.invalid/',
    '/\\example.invalid/',
    'https://example.invalid/',
  ])('rejects non-root or escaping article path %s', (path) => {
    expect(() => sourcePreviewUrl(path, 'http://localhost:5173')).toThrow();
  });
  it('rejects credentials, non-HTTP origins and invalid ports', () => {
    expect(() =>
      previewUrl('/', 'http://user:password@localhost', 4321),
    ).toThrow();
    expect(() => previewUrl('/', 'file:///tmp/', 4321)).toThrow();
    expect(() => previewUrl('/', 'http://localhost', 70000)).toThrow();
  });
});
