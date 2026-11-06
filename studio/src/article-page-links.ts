import {
  articleUrl,
  absoluteSiteUrl,
  type ArticleResource,
  type CurrentArtifact,
  type SiteConfig,
  type Workspace,
} from '@foliohaven/core';

export type ArticleBuildState =
  | 'draft'
  | 'checking'
  | 'unavailable'
  | 'recovery'
  | 'missing'
  | 'unknown'
  | 'stale'
  | 'current';

/** A saved publication state does not prove that an artifact or deployment exists. */
export function articlePageLinksState(input: {
  readonly article: ArticleResource | null;
  readonly site: SiteConfig | null;
  readonly workspace: Workspace | null;
  readonly artifact: CurrentArtifact | null;
  readonly checking: boolean;
  readonly failed: boolean;
}): {
  readonly path: string | null;
  readonly formalUrl: string | null;
  readonly buildState: ArticleBuildState;
  readonly hasInstalledWebsite: boolean;
} {
  const published = input.article?.meta;
  let path: string | null = null;
  let formalUrl: string | null = null;
  if (published?.status === 'published') {
    try {
      path = articleUrl(published.category, published.slug);
      formalUrl = input.site ? absoluteSiteUrl(input.site, path) : null;
    } catch {
      // Invalid saved metadata must not create a guessed public URL.
    }
  }
  const hasInstalledWebsite =
    !input.checking &&
    !input.failed &&
    input.artifact?.recoveryState === 'ready' &&
    input.artifact.current !== null;
  let buildState: ArticleBuildState;
  if (path === null) buildState = 'draft';
  else if (input.checking) buildState = 'checking';
  else if (input.failed || !input.workspace || !input.artifact)
    buildState = 'unavailable';
  else if (
    input.workspace.recoveryState !== 'ready' ||
    input.artifact.recoveryState !== 'ready'
  )
    buildState = 'recovery';
  else if (input.artifact.current === null) buildState = 'missing';
  else if (input.artifact.current.build === null) buildState = 'unknown';
  else if (
    input.workspace.revision !==
    input.artifact.current.build.result.snapshotRevision
  )
    buildState = 'stale';
  else buildState = 'current';
  return { path, formalUrl, buildState, hasInstalledWebsite };
}
