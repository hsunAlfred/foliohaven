import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PreviewRequestSchema, SiteConfigSchema } from '@foliohaven/core';
import type { ContentSources } from '@foliohaven/core/node';
import { FileRepository } from '../../server/src/files/repository.js';
import type { ReadSession } from '../../server/src/files/types.js';
import { PreviewStore } from '../../server/src/previews/store.js';

const request = () =>
  PreviewRequestSchema.parse({
    contentHtml: '<p>Unsaved preview</p>',
    meta: { status: 'draft' },
  });
function content(): ContentSources {
  return {
    site: SiteConfigSchema.parse({
      siteName: 'Preview fixture',
      siteDescription: 'Isolated cancellation fixture',
      siteUrl: 'https://example.invalid/',
      author: { name: 'Fixture author', url: null },
    }),
    categories: [],
    tags: [],
    articles: [],
    pages: {},
  };
}
function session(loadContent: ReadSession['loadContent']): ReadSession {
  return {
    generation: 0,
    read: async () => null,
    etag: async () => `"${'a'.repeat(64)}"`,
    listArticleIds: async () => [],
    loadContent,
  };
}

describe('cancelled preview work', () => {
  it('does not load sources or media after waiting for a repository session', async () => {
    const repository = new FileRepository({
      repositoryRoot: '/tmp/unused-preview-fixture',
    });
    const load = vi.fn(async () => content());
    const manifest = vi.fn(async () => ({
      schemaVersion: 1 as const,
      assets: [],
    }));
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(repository, 'withConsistentRead').mockImplementation(
      async (fn) => {
        entered();
        await gate;
        return fn(session(load));
      },
    );
    const store = new PreviewStore({ repository, fixedPages: [], manifest });
    const controller = new AbortController();
    const task = store.create(request(), {
      editorId: randomUUID(),
      studioOrigin: 'http://localhost:5173',
      signal: controller.signal,
    });
    const cancelled = expect(task).rejects.toMatchObject({
      code: 'PREVIEW_CANCELLED',
    });
    await waiting;
    controller.abort();
    release();
    await cancelled;
    expect(load).not.toHaveBeenCalled();
    expect(manifest).not.toHaveBeenCalled();
    store.close();
  });

  it('stops before manifest work when cancellation arrives during content loading', async () => {
    const repository = new FileRepository({
      repositoryRoot: '/tmp/unused-preview-fixture',
    });
    const controller = new AbortController();
    const load = vi.fn(async () => {
      controller.abort();
      return content();
    });
    const manifest = vi.fn(async () => ({
      schemaVersion: 1 as const,
      assets: [],
    }));
    vi.spyOn(repository, 'withConsistentRead').mockImplementation(async (fn) =>
      fn(session(load)),
    );
    const store = new PreviewStore({ repository, fixedPages: [], manifest });
    await expect(
      store.create(request(), {
        editorId: randomUUID(),
        studioOrigin: 'http://localhost:5173',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_CANCELLED' });
    expect(load).toHaveBeenCalledOnce();
    expect(manifest).not.toHaveBeenCalled();
    store.close();
  });
});
