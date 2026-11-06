import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capturePreviewFingerprint,
  previewFingerprintMatches,
} from '../../server/src/build/artifacts/preview-cache.js';

const fixtures: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-preview-fingerprint-'));
  fixtures.push(root);
  await mkdir(join(root, 'dist'));
  await mkdir(join(root, '.alfred/artifacts'), { recursive: true });
  await writeFile(join(root, 'dist/index.html'), '<p>first</p>');
  await writeFile(join(root, '.alfred/artifacts/state.json'), '{}');
  return root;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const root of fixtures.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('safe preview artifact observation', () => {
  it('falls back while metadata is recent, reuses a stable fingerprint, and rejects a same-length edit', async () => {
    const root = await fixture();
    expect(await capturePreviewFingerprint(root)).toBeUndefined();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5000);
    const fingerprint = await capturePreviewFingerprint(root);
    expect(fingerprint).toEqual({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    if (!fingerprint) throw new Error('Expected a stable observation');
    expect(await previewFingerprintMatches(root, fingerprint)).toBe(true);
    vi.useRealTimers();
    await writeFile(join(root, 'dist/index.html'), '<p>other</p>');
    expect(await capturePreviewFingerprint(root)).toBeUndefined();
    expect(await previewFingerprintMatches(root, fingerprint)).toBe(false);
  });

  it('does not trust a future file or directory timestamp', async () => {
    const root = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5000);
    const fingerprint = await capturePreviewFingerprint(root);
    if (!fingerprint) throw new Error('Expected a stable observation');
    const future = new Date(Date.now() + 60_000);
    await utimes(join(root, 'dist/index.html'), future, future);
    expect(await capturePreviewFingerprint(root)).toBeUndefined();
    expect(await previewFingerprintMatches(root, fingerprint)).toBe(false);
    const past = new Date(Date.now() - 60_000);
    await utimes(join(root, 'dist/index.html'), past, past);
    expect(await capturePreviewFingerprint(root)).toBeDefined();
    await utimes(join(root, 'dist'), future, future);
    expect(await capturePreviewFingerprint(root)).toBeUndefined();
  });

  it('falls back for an unsafe symlink instead of caching outside bytes', async () => {
    const root = await fixture();
    const outside = join(root, 'private.txt');
    await writeFile(outside, 'private');
    await symlink(outside, join(root, 'dist/untrusted.txt'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5000);
    expect(await capturePreviewFingerprint(root)).toBeUndefined();
  });
});
