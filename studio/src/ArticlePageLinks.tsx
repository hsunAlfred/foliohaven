import { useCallback } from 'react';
import {
  CurrentArtifactSchema,
  WorkspaceSchema,
  type ArticleResource,
  type CurrentArtifact,
  type SiteConfig,
  type Workspace,
} from '@foliohaven/core';
import type { StudioApi } from './api.js';
import { useResource } from './hooks.js';
import { Icon } from './Icon.js';
import { articlePageLinksState } from './article-page-links.js';
import { builtPreviewUrl, sourcePreviewUrl } from './preview-urls.js';
import './article-page-links.css';

const buildMessages = {
  draft: '草稿僅提供文章即時預覽，尚無公開文章網址。',
  checking: '正在確認最近成功建置的網站…',
  unavailable: '暫時無法確認成功建置版本，請重新確認網站狀態。',
  recovery: '網站目前需要復原，尚不能確認這篇文章的建置預覽。',
  missing: '網站尚未建立，請先到「網站更新與工作」更新網站。',
  unknown: '網站產物存在，但無法確認對應的來源版本，請重新更新網站。',
  stale: '有已保存的變更尚未套用到網站；更新網站後才提供這篇文章的建置預覽。',
  current: '成功建置版本已套用目前保存的內容。',
} as const;

export interface ArticleWorkspaceStatus {
  readonly value: Workspace | null;
  readonly loading: boolean;
  readonly error: unknown;
  readonly reload: () => void;
}

export function ArticlePageLinks({
  api,
  article,
  site,
  dirty,
  workspace,
}: {
  readonly api: StudioApi;
  readonly article: ArticleResource | null;
  readonly site: SiteConfig | null;
  readonly dirty: boolean;
  readonly workspace: ArticleWorkspaceStatus;
}) {
  const artifact = useResource<CurrentArtifact>(
    api,
    '/api/v1/artifacts/current',
  );
  const reloadWorkspace = workspace.reload;
  const reloadArtifact = artifact.reload;
  const refresh = useCallback(() => {
    reloadWorkspace();
    reloadArtifact();
  }, [reloadWorkspace, reloadArtifact]);
  const parsedWorkspace = WorkspaceSchema.safeParse(workspace.value);
  const parsedArtifact = CurrentArtifactSchema.safeParse(
    artifact.response?.data,
  );
  const state = articlePageLinksState({
    article,
    site,
    workspace: parsedWorkspace.success ? parsedWorkspace.data : null,
    artifact: parsedArtifact.success ? parsedArtifact.data : null,
    checking: workspace.loading || artifact.loading,
    failed: Boolean(
      workspace.error ||
      artifact.error ||
      (workspace.value && !parsedWorkspace.success) ||
      (artifact.response && !parsedArtifact.success),
    ),
  });
  return (
    <section className="article-page-links" aria-label="文章預覽與網址">
      <div className="article-page-links-heading">
        <h3>文章預覽與網址</h3>
        {state.path && (
          <button
            type="button"
            className="quiet"
            disabled={workspace.loading || artifact.loading}
            onClick={refresh}
          >
            <Icon name="refresh" size={16} /> 重新確認網站狀態
          </button>
        )}
      </div>
      {dirty && (
        <p className="field-note">
          目前有未保存修改，可在上方即時預覽查看；以下網址開啟已保存的版本。
        </p>
      )}
      <div className="article-page-link-actions">
        {state.path && (
          <a
            href={sourcePreviewUrl(state.path)}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="eye" size={17} /> 來源預覽
          </a>
        )}
        {state.path && state.buildState === 'current' ? (
          <a
            href={builtPreviewUrl(state.path)}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="check" size={17} /> 成功建置預覽
          </a>
        ) : state.hasInstalledWebsite &&
          !workspace.loading &&
          !artifact.loading ? (
          <a href={builtPreviewUrl('/')} target="_blank" rel="noreferrer">
            <Icon name="globe" size={17} /> 查看已建置網站首頁
          </a>
        ) : null}
        {state.formalUrl && (
          <a href={state.formalUrl} target="_blank" rel="noreferrer">
            <Icon name="externalLink" size={17} /> 正式網站網址
          </a>
        )}
      </div>
      <p className="article-page-links-status" role="status">
        {buildMessages[state.buildState]}
      </p>
      {state.formalUrl && (
        <p className="field-note">
          正式網址依網站設定產生；本機成功建置不代表已部署到正式網站。
        </p>
      )}
    </section>
  );
}
