import { describe, expect, it, vi } from 'vitest';
import { newKey } from '../../studio/src/api.js';

const uuidV4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

describe('Studio operation identifiers', () => {
  it('uses native randomUUID when available', () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID');
    const key = newKey();
    expect(key).toMatch(uuidV4);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('creates distinct UUID v4 keys with secure bytes when randomUUID is unavailable', () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', { getRandomValues });
    const keys = Array.from({ length: 100 }, () => newKey());
    for (const key of keys) expect(key).toMatch(uuidV4);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
