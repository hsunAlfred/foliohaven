import { describe, expect, it } from 'vitest';
import {
  ArticleResourceSchema,
  CurrentArtifactSchema,
  SiteConfigSchema,
  WorkspaceSchema,
} from '@foliohaven/core';
import { articlePageLinksState } from '../../studio/src/article-page-links.js';

const revision = 'a'.repeat(64);
const site = SiteConfigSchema.parse({
  siteName: 'Studio 文章網址測試',
  siteDescription: '保存、建置與正式網址分開確認。',
  siteUrl: 'https://blog.example.invalid/',
  author: { name: 'Author', url: null },
});
const article = ArticleResourceSchema.parse({
  id: 'saved-article',
  contentHtml: '<p>已保存文章。</p>',
  meta: {
    status: 'published',
    title: '已保存標題',
    slug: 'saved-path',
    category: 'notes',
    tags: [],
    publishedAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    seo: { description: '已保存摘要。' },
  },
  diagnostics: [],
});
function workspace(change: Record<string, unknown> = {}) {
  return WorkspaceSchema.parse({
    revision,
    editMode: 'studio',
    recoveryState: 'ready',
    diagnostics: [],
    limits: {
      articleMetaBytes: 1,
      articleHtmlBytes: 1,
      siteBytes: 1,
      pageBytes: 1,
      mediaMetaBytes: 1,
      taxonomyBytes: 1,
      articleCount: 1,
      publishedHtmlBytes: 1,
      loaderConcurrency: 1,
      imageSourceBytes: 1,
      videoSourceBytes: 1,
    },
    ...change,
  });
}
const currentBuild = {
  jobId: '947fa67a-df44-4fa3-bd9e-2b587383400b',
  committedAt: '2026-11-01T00:00:00Z',
  result: {
    outputDirectory: 'dist',
    snapshotRevision: revision,
    routeCount: 1,
    fileCount: 1,
    warnings: [],
  },
};
function artifact(change: Record<string, unknown> = {}) {
  return CurrentArtifactSchema.parse({
    recoveryState: 'ready',
    current: { digest: 'b'.repeat(64), build: currentBuild },
    ...change,
  });
}
function input() {
  return {
    article,
    site,
    workspace: workspace(),
    artifact: artifact(),
    checking: false,
    failed: false,
  };
}

describe('Studio saved article preview links', () => {
  it('confirms a precise built article URL only against the installed artifact and current source revision', () => {
    expect(articlePageLinksState(input())).toEqual({
      path: '/notes/saved-path/',
      formalUrl: 'https://blog.example.invalid/notes/saved-path/',
      buildState: 'current',
      hasInstalledWebsite: true,
    });
    expect(
      articlePageLinksState({
        ...input(),
        workspace: workspace({ revision: 'c'.repeat(64) }),
      }).buildState,
    ).toBe('stale');
  });

  it('does not treat an unpublished or unsaved draft as a public article', () => {
    const draft = ArticleResourceSchema.parse({
      ...article,
      meta: { ...article.meta, status: 'draft' },
    });
    for (const candidate of [null, draft])
      expect(
        articlePageLinksState({ ...input(), article: candidate }),
      ).toMatchObject({
        path: null,
        formalUrl: null,
        buildState: 'draft',
      });
  });

  it('distinguishes missing artifacts, missing build proof and recovery requirements', () => {
    expect(
      articlePageLinksState({
        ...input(),
        artifact: artifact({ current: null }),
      }),
    ).toMatchObject({ buildState: 'missing', hasInstalledWebsite: false });
    expect(
      articlePageLinksState({
        ...input(),
        artifact: artifact({
          current: { digest: 'b'.repeat(64), build: null },
        }),
      }).buildState,
    ).toBe('unknown');
    expect(
      articlePageLinksState({
        ...input(),
        artifact: artifact({ recoveryState: 'recovery-required' }),
      }),
    ).toMatchObject({ buildState: 'recovery', hasInstalledWebsite: false });
    expect(
      articlePageLinksState({
        ...input(),
        workspace: workspace({ recoveryState: 'recovery-required' }),
      }).buildState,
    ).toBe('recovery');
  });

  it('does not reuse a previously matching result while a fresh confirmation is pending or has failed', () => {
    expect(articlePageLinksState({ ...input(), checking: true })).toMatchObject(
      {
        buildState: 'checking',
        hasInstalledWebsite: false,
      },
    );
    expect(articlePageLinksState({ ...input(), failed: true })).toMatchObject({
      buildState: 'unavailable',
      hasInstalledWebsite: false,
    });
    expect(
      articlePageLinksState({ ...input(), artifact: null }).buildState,
    ).toBe('unavailable');
    expect(
      articlePageLinksState({ ...input(), workspace: null }).buildState,
    ).toBe('unavailable');
  });
});
