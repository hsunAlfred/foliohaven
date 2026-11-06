import { describe, it, expect } from 'vitest';
import { JobRetryInputSchema } from '@foliohaven/core';
describe('safe persisted job retry input boundary', () => {
  it('accepts only the required media identity and preset', () => {
    const input = {
      type: 'media',
      sourceId: '1d4012fe-132d-4abc-8da7-123b9cf7c9ec',
      preset: 'article-image',
    };
    expect(JobRetryInputSchema.parse(input)).toEqual(input);
    expect(
      JobRetryInputSchema.safeParse({ ...input, sourceId: '../source' })
        .success,
    ).toBe(false);
  });
  it('rejects private fields and stale authorization data instead of leaking persisted payload', () => {
    const input = {
      type: 'taxonomy',
      kind: 'category',
      from: 'old',
      to: 'new',
    };
    expect(JobRetryInputSchema.parse(input)).toEqual(input);
    expect(
      JobRetryInputSchema.safeParse({
        ...input,
        workspaceRevision: 'a'.repeat(64),
        planId: 'old-plan',
      }).success,
    ).toBe(false);
    expect(
      JobRetryInputSchema.safeParse({ type: 'build', command: 'arbitrary' })
        .success,
    ).toBe(false);
  });
});
