import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { SiteConfigSchema, SiteUrlSchema } from '@foliohaven/core';

const site = (siteUrl: string) => ({
  siteName: '網址驗收網站',
  siteDescription: '驗證網站網址時保留一般欄位錯誤處理。',
  siteUrl,
  author: { name: '作者' },
});

describe('site URL validation during partial input', () => {
  it.each([
    '',
    'h',
    'ht',
    'https',
    'https:',
    'https:/',
    'https://',
    'https://[',
    'https://[::1',
    'https://%',
    'https://%/',
    'https://exa mple.invalid/',
  ])(
    'returns validation issues instead of throwing a URL error for %j',
    (value) => {
      expect(() => SiteUrlSchema.safeParse(value)).not.toThrow();
      const result = SiteUrlSchema.safeParse(value);
      expect(result.success).toBe(false);
      if (result.success)
        throw new Error('Malformed URL unexpectedly accepted');
      expect(result.error).toBeInstanceOf(ZodError);
      expect(() => SiteUrlSchema.parse(value)).toThrow(ZodError);

      // This is the public schema used while Studio renders an edited site object.
      expect(() => SiteConfigSchema.safeParse(site(value))).not.toThrow();
      const nested = SiteConfigSchema.safeParse(site(value));
      expect(nested.success).toBe(false);
      if (nested.success)
        throw new Error('Malformed site URL unexpectedly accepted');
      expect(nested.error.issues.length).toBeGreaterThan(0);
      expect(
        nested.error.issues.every((issue) => issue.path[0] === 'siteUrl'),
      ).toBe(true);
      expect(() => SiteConfigSchema.parse(site(value))).toThrow(ZodError);
    },
  );

  it.each([
    'https://example.invalid/',
    'https://EXAMPLE.invalid/',
    'http://localhost:4321/',
    'http://127.0.0.1:8080/',
    'https://[::1]/',
  ])(
    'continues accepting the origin %s without changing its stored spelling',
    (value) => {
      expect(SiteUrlSchema.parse(value)).toBe(value);
      const parsed = SiteConfigSchema.parse(site(value));
      expect(parsed.siteUrl).toBe(value);
      expect(parsed.defaultSEO.description).toBe(site(value).siteDescription);
    },
  );

  it.each([
    'https://example.invalid',
    'https://example.invalid/blog/',
    'https://example.invalid/?q=example',
    'https://example.invalid/#section',
    'https://user:placeholder@example.invalid/',
    'ftp://example.invalid/',
  ])(
    'continues rejecting the structurally parseable but disallowed URL %s',
    (value) => {
      expect(() => SiteUrlSchema.safeParse(value)).not.toThrow();
      expect(SiteUrlSchema.safeParse(value).success).toBe(false);
      const result = SiteConfigSchema.safeParse(site(value));
      expect(result.success).toBe(false);
      if (result.success)
        throw new Error('Disallowed site URL unexpectedly accepted');
      expect(
        result.error.issues.every((issue) => issue.path[0] === 'siteUrl'),
      ).toBe(true);
    },
  );
});
