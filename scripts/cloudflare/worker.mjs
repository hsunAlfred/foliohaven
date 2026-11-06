import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildProcessEnvironment,
  runControlledProcess,
  scanArtifactTree,
} from '@foliohaven/server';
import { ensurePrivateDirectory } from '../private-directory.mjs';
import { CloudflareError } from './errors.mjs';

const require = createRequire(import.meta.url);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const message = (id) => `alfred-wiki deploy ${id}`;
const restoreMessage = (id) => `alfred-wiki restore ${id}`;
const cancelled = (signal) => {
  if (signal?.aborted)
    throw new CloudflareError('CLOUDFLARE_CANCELLED', '操作已取消。');
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}
function malformed() {
  return new CloudflareError(
    'WORKER_RESPONSE_INVALID',
    '無法判讀 Worker 回應，請保留部署紀錄後重試狀態查詢。',
  );
}
function currentDeployment(result) {
  if (!object(result) || !Array.isArray(result.deployments)) throw malformed();
  const deployment = result.deployments[0];
  if (
    !object(deployment) ||
    !uuid.test(deployment.id ?? '') ||
    !Array.isArray(deployment.versions) ||
    deployment.versions.length !== 1 ||
    deployment.versions[0]?.percentage !== 100 ||
    !uuid.test(deployment.versions[0]?.version_id ?? '')
  )
    throw new CloudflareError(
      'WORKER_DEPLOYMENT_CONFLICT',
      '既有 Worker 必須由單一版本承接全部流量；請先處理分流或未知部署。',
    );
  return {
    versionId: deployment.versions[0].version_id,
    deploymentId: deployment.id,
    message:
      /^alfred-wiki (?:deploy|restore) [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
        deployment.annotations?.['workers/message'] ?? '',
      )
        ? deployment.annotations['workers/message']
        : null,
  };
}
function compatible(settings, version, compatibilityDate, ownDeployment) {
  const resources = version.resources;
  const bindings = settings.bindings ?? [];
  const handlers = resources?.script?.handlers ?? [];
  if (
    !Array.isArray(bindings) ||
    bindings.length > 0 ||
    !object(resources) ||
    (handlers.length > 0 &&
      !(ownDeployment && handlers.length === 1 && handlers[0] === 'fetch')) ||
    (resources.script?.named_handlers?.length ?? 0) > 0 ||
    (Array.isArray(resources.bindings)
      ? resources.bindings.length > 0
      : object(resources.bindings) &&
        Object.keys(resources.bindings).length > 0) ||
    (settings.compatibility_flags?.length ?? 0) > 0 ||
    (settings.compatibility_date !== undefined &&
      settings.compatibility_date !== compatibilityDate) ||
    settings.logpush === true ||
    settings.observability?.enabled === true ||
    settings.placement?.mode === 'smart' ||
    (settings.tail_consumers?.length ?? 0) > 0 ||
    (object(settings.limits) && Object.keys(settings.limits).length > 0)
  )
    throw new CloudflareError(
      'WORKER_SETTINGS_CONFLICT',
      '同名 Worker 的程式、綁定或設定與靜態網站部署不同，請使用網站專用 Worker。',
    );
}
async function privateRead(path, maxBytes = 1024 * 1024) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes))
      throw new CloudflareError('WORKER_CONFIG_INVALID', 'Worker 設定檔無效。');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new CloudflareError(
        'WORKER_CONFIG_CHANGED',
        'Worker 設定在讀取期間改變，請重新建立部署。',
      );
    return bytes;
  } finally {
    await handle.close();
  }
}
function validateTemplate(value) {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'assets,compatibility_date,preview_urls,workers_dev' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.compatibility_date ?? '') ||
    value.workers_dev !== false ||
    value.preview_urls !== false ||
    !object(value.assets) ||
    Object.keys(value.assets).sort().join(',') !==
      'directory,html_handling,not_found_handling' ||
    value.assets.directory !== '../worker' ||
    value.assets.html_handling !== 'force-trailing-slash' ||
    value.assets.not_found_handling !== '404-page'
  )
    throw new CloudflareError(
      'WORKER_TEMPLATE_INVALID',
      'Worker 模板不符合靜態網站與手動路由契約。',
    );
  return value;
}
async function wranglerCli() {
  let directory = dirname(require.resolve('wrangler'));
  for (;;) {
    try {
      const metadata = JSON.parse(
        await readFile(join(directory, 'package.json'), 'utf8'),
      );
      if (metadata.name === 'wrangler') {
        const bin =
          typeof metadata.bin === 'string'
            ? metadata.bin
            : metadata.bin?.wrangler;
        if (typeof bin !== 'string') throw malformed();
        return join(directory, bin);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new CloudflareError('WRANGLER_MISSING', '尚未安裝固定 Wrangler。');
    directory = parent;
  }
}

/** 固定帳戶與名稱；所有可注入依賴僅供程式測試，CLI 不暴露 endpoint。 */
export function createWorker({
  config,
  token,
  repositoryRoot,
  signal,
  fetchImpl = fetch,
  run = runControlledProcess,
  retryDelayMs = 1000,
}) {
  if (
    !/^[a-f0-9]{32}$/.test(config?.accountId ?? '') ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config?.workerName ?? '')
  )
    throw new CloudflareError('WORKER_TARGET_INVALID', 'Worker 部署目標無效。');
  const target = Object.freeze({
    accountId: config.accountId,
    workerName: config.workerName,
  });
  const base = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/scripts/${target.workerName}`;
  let template;
  async function loadTemplate() {
    template ??= validateTemplate(
      JSON.parse(
        (
          await privateRead(
            join(repositoryRoot, 'cloudflare/wrangler.template.json'),
          )
        ).toString('utf8'),
      ),
    );
    return template;
  }
  function contextRoot(context) {
    if (
      !uuid.test(context?.deploymentId ?? '') ||
      resolve(context.root) !==
        resolve(repositoryRoot, '.alfred/deployments', context.deploymentId)
    )
      throw new CloudflareError('WORKER_CONTEXT_INVALID', '部署紀錄位置無效。');
    return ensurePrivateDirectory(
      repositoryRoot,
      `.alfred/deployments/${context.deploymentId}`,
    );
  }
  async function api(suffix, { method = 'GET', body, missing = false } = {}) {
    if (typeof token !== 'string' || token.length === 0)
      throw new CloudflareError(
        'WORKER_CREDENTIALS_MISSING',
        '缺少 Worker 部署憑證。',
      );
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      cancelled(signal);
      let response;
      try {
        response = await fetchImpl(`${base}${suffix}`, {
          method,
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        });
      } catch {
        // fetch 已開始，取消不能證明非 GET 的遠端寫入沒有提交。
        if (method !== 'GET')
          throw new CloudflareError(
            'WORKER_RESULT_UNKNOWN',
            'Worker 寫入結果尚未確認，請先查詢本次部署狀態。',
            { unknown: true },
          );
        cancelled(signal);
        if (method === 'GET' && attempt + 1 < attempts) {
          await delay(retryDelayMs * 2 ** attempt, undefined, { signal });
          continue;
        }
        throw new CloudflareError(
          method === 'GET' ? 'WORKER_API_UNAVAILABLE' : 'WORKER_RESULT_UNKNOWN',
          method === 'GET'
            ? '暫時無法讀取 Worker 狀態，請稍後重試。'
            : 'Worker 寫入結果尚未確認，請先查詢本次部署狀態。',
          { retryable: method === 'GET', unknown: method !== 'GET' },
        );
      }
      if (
        method === 'GET' &&
        (response.status === 429 || response.status >= 500) &&
        attempt + 1 < attempts
      ) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = Number(retryAfter);
        const wait = retryAfter
          ? Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : Math.max(0, Date.parse(retryAfter) - Date.now())
          : retryDelayMs * 2 ** attempt;
        await response.body?.cancel();
        if (wait > 30_000)
          throw new CloudflareError(
            'WORKER_RATE_LIMITED',
            'Cloudflare 要求較長等待，請稍後重試狀態查詢。',
            { retryable: true },
          );
        await delay(Number.isFinite(wait) ? wait : retryDelayMs, undefined, {
          signal,
        });
        continue;
      }
      let payload;
      try {
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > 4 * 1024 * 1024)
          throw malformed();
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response.body ?? []) {
          bytes += chunk.byteLength;
          if (bytes > 4 * 1024 * 1024) throw malformed();
          chunks.push(chunk);
        }
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        if (method !== 'GET')
          throw new CloudflareError(
            'WORKER_RESULT_UNKNOWN',
            'Worker 寫入結果尚未確認，請先查詢本次部署狀態。',
            { unknown: true },
          );
        throw malformed();
      }
      if (
        missing &&
        response.status === 404 &&
        Array.isArray(payload.errors) &&
        payload.errors.some((error) => error?.code === 10007)
      )
        return null;
      if (!response.ok || payload.success !== true) {
        const auth = response.status === 401 || response.status === 403;
        throw new CloudflareError(
          auth ? 'WORKER_PERMISSION_DENIED' : 'WORKER_API_FAILED',
          auth
            ? 'Worker 憑證無效或權限不足，請檢查指定帳戶的部署權限。'
            : 'Worker API 未完成操作，請依部署紀錄排查後重試狀態查詢。',
          {
            retryable:
              method === 'GET' &&
              (response.status === 429 || response.status >= 500),
            unknown: method !== 'GET' && response.status >= 500,
          },
        );
      }
      return payload.result;
    }
    throw malformed();
  }
  async function inspect() {
    const settings = await api('/settings', { missing: true });
    if (settings === null) return null;
    if (!object(settings)) throw malformed();
    const active = currentDeployment(await api('/deployments'));
    const version = await api(`/versions/${active.versionId}`);
    if (!object(version) || version.id !== active.versionId) throw malformed();
    const tag = uuid.test(version.annotations?.['workers/tag'] ?? '')
      ? version.annotations['workers/tag']
      : null;
    // Wrangler 把 deploy 的 message／tag 寫在版本上；deployment 的註記可不同。
    const versionMessage =
      tag !== null && version.annotations?.['workers/message'] === message(tag)
        ? message(tag)
        : null;
    compatible(
      settings,
      version,
      (await loadTemplate()).compatibility_date,
      versionMessage !== null,
    );
    return {
      ...active,
      tag,
      versionMessage,
      settingsFingerprint: hash(JSON.stringify(canonical(settings))),
    };
  }
  function state(context) {
    contextRoot(context);
    context.journal.worker ??= {
      before: null,
      after: null,
      stage: null,
      status: 'prepared',
    };
    return context.journal.worker;
  }
  async function save(context) {
    await context.save();
  }
  async function workerManifest(context) {
    cancelled(context.signal ?? signal);
    try {
      const manifest = await scanArtifactTree(
        contextRoot(context),
        'worker',
        context.signal ?? signal,
      );
      if (!manifest) throw malformed();
      return manifest;
    } catch {
      cancelled(context.signal ?? signal);
      throw new CloudflareError(
        'WORKER_ASSETS_CHANGED',
        'Worker 靜態檔案缺漏、變更或含符號連結，請保留本次紀錄後重新建立部署。',
      );
    }
  }
  function matchManifestFiles(manifest, expected) {
    const files = (entries) =>
      entries
        .map((entry) => ({
          path: entry.path,
          byteSize: entry.byteSize,
          sha256: entry.sha256,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (
      JSON.stringify(
        files(manifest.entries.filter((entry) => entry.kind === 'file')),
      ) !== JSON.stringify(files(expected))
    )
      throw new CloudflareError(
        'WORKER_ASSETS_CHANGED',
        'Worker 靜態檔案與本次正式產物清單不一致，未開始發布。',
      );
  }
  async function stage(context) {
    const root = contextRoot(context);
    cancelled(context.signal ?? signal);
    const current = state(context);
    if (current.stage !== null) {
      await checkStage(context);
      return current.stage;
    }
    const fixedWorker = await workerManifest(context);
    if (context.manifest !== undefined) {
      if (!Array.isArray(context.manifest)) throw malformed();
      matchManifestFiles(
        fixedWorker,
        context.manifest.filter((entry) => entry.target === 'worker'),
      );
    }
    const value = {
      ...(await loadTemplate()),
      name: target.workerName,
      account_id: target.accountId,
    };
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    ensurePrivateDirectory(
      repositoryRoot,
      `.alfred/deployments/${context.deploymentId}/wrangler`,
    );
    const configRelative = 'wrangler/wrangler.json';
    const path = join(root, configRelative);
    try {
      const handle = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const directory = await open(
        dirname(path),
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!(await privateRead(path)).equals(bytes))
        throw new CloudflareError(
          'WORKER_CONFIG_CHANGED',
          '本次 Worker 固定設定已存在且內容不同。',
        );
    }
    const result = {
      configRelative,
      configDigest: hash(bytes),
      templateDigest: hash(JSON.stringify(canonical(await loadTemplate()))),
      workerManifest: fixedWorker,
    };
    state(context).stage = result;
    await save(context);
    return result;
  }
  async function checkStage(context) {
    cancelled(context.signal ?? signal);
    const current = state(context);
    if (
      current.stage?.configRelative !== 'wrangler/wrangler.json' ||
      !/^[a-f0-9]{64}$/.test(current.stage?.configDigest ?? '') ||
      hash(
        await privateRead(
          join(contextRoot(context), current.stage.configRelative),
        ),
      ) !== current.stage.configDigest
    )
      throw new CloudflareError(
        'WORKER_CONFIG_CHANGED',
        '本次固定 Worker 設定缺漏或已被修改。',
      );
    const path = join(context.root, current.stage.configRelative);
    const value = JSON.parse((await privateRead(path)).toString('utf8'));
    const { name, account_id, ...rest } = value;
    validateTemplate(rest);
    if (name !== target.workerName || account_id !== target.accountId)
      throw new CloudflareError(
        'WORKER_TARGET_CHANGED',
        '本次固定設定與部署目標不一致。',
      );
    const currentWorker = await workerManifest(context);
    if (
      !object(current.stage.workerManifest) ||
      currentWorker.digest !== current.stage.workerManifest.digest ||
      JSON.stringify(currentWorker) !==
        JSON.stringify(current.stage.workerManifest)
    )
      throw new CloudflareError(
        'WORKER_ASSETS_CHANGED',
        'Worker 靜態檔案已偏離本次固定清單，停止發布。',
      );
    if (context.manifest !== undefined)
      matchManifestFiles(
        currentWorker,
        context.manifest.filter((entry) => entry.target === 'worker'),
      );
    return path;
  }
  async function execute(context, dryRun) {
    const path = await checkStage(context);
    const resource = `.alfred/deployments/${context.deploymentId}/wrangler`;
    const home = ensurePrivateDirectory(repositoryRoot, `${resource}/home`);
    const environment = buildProcessEnvironment({
      HOME: home,
      CI: 'true',
      NO_COLOR: '1',
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_WRITE_LOGS: 'false',
      WRANGLER_LOG: 'error',
      WRANGLER_HIDE_BANNER: 'true',
      WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true',
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
      ...(dryRun ? {} : { CLOUDFLARE_API_TOKEN: token }),
    });
    let output, failure;
    try {
      output = await run({
        command: process.execPath,
        args: [
          await wranglerCli(),
          'deploy',
          '--config',
          path,
          '--strict',
          '--autoconfig=false',
          '--install-skills=false',
          '--tag',
          context.deploymentId,
          '--message',
          message(context.deploymentId),
          ...(dryRun
            ? ['--dry-run', '--outdir', join(context.root, 'wrangler/output')]
            : []),
        ],
        cwd: join(context.root, 'wrangler'),
        env: environment,
        ...((context.signal ?? signal)
          ? { signal: context.signal ?? signal }
          : {}),
        timeoutMs: dryRun ? 120_000 : 30 * 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
      });
    } catch (error) {
      failure = error;
    }
    try {
      await checkStage(context);
    } catch (error) {
      if (!dryRun) {
        state(context).stageArtifactInvalid = true;
        await save(context);
      }
      throw error;
    }
    if (failure) throw failure;
    return output;
  }
  async function preflight(context) {
    cancelled(context?.signal ?? signal);
    const remote = await inspect();
    const before = remote && {
      versionId: remote.versionId,
      deploymentId: remote.deploymentId,
      message: remote.message,
      tag: remote.tag,
      settingsFingerprint: remote.settingsFingerprint,
    };
    if (context) {
      const current = state(context);
      current.before = before;
      current.status = 'prepared';
      await save(context);
    }
    return before;
  }
  function restoreFingerprint(current) {
    return (
      (current.status === 'restored'
        ? current.restored?.settingsFingerprint
        : undefined) ??
      current.after?.settingsFingerprint ??
      current.before?.settingsFingerprint
    );
  }
  async function status(context) {
    cancelled(context.signal ?? signal);
    const current = state(context);
    const unresolved = ['deploy-intent', 'unknown', 'restore-intent'].includes(
      current.status,
    );
    const result = (remote, conflict, diagnosticCode) => ({
      status: unresolved ? 'unknown' : 'conflict',
      conflict,
      diagnosticCode,
      remote: remote && {
        versionId: remote.versionId,
        deploymentId: remote.deploymentId,
      },
      canRestoreWorker: current.before !== null,
    });
    let remote;
    try {
      remote = await inspect();
    } catch (error) {
      cancelled(context.signal ?? signal);
      if (!unresolved) throw error;
      const code =
        error instanceof CloudflareError
          ? error.code
          : 'WORKER_STATE_UNAVAILABLE';
      return result(
        null,
        ['WORKER_DEPLOYMENT_CONFLICT', 'WORKER_SETTINGS_CONFLICT'].includes(
          code,
        ),
        code,
      );
    }
    const own =
      remote?.versionMessage === message(context.deploymentId) &&
      remote?.tag === context.deploymentId;
    if (
      current.after &&
      own &&
      (current.after.versionId !== remote.versionId ||
        current.after.deploymentId !== remote.deploymentId ||
        (current.after.settingsFingerprint !== undefined &&
          current.after.settingsFingerprint !== remote.settingsFingerprint))
    )
      return result(remote, true, 'WORKER_REMOTE_CHANGED');
    const restoredFingerprint = restoreFingerprint(current);
    if (current.status === 'restored') {
      if (
        (current.restored &&
          ((remote?.versionId ?? null) !== current.restored.versionId ||
            (remote?.deploymentId ?? null) !==
              current.restored.deploymentId)) ||
        (restoredFingerprint !== undefined &&
          remote?.settingsFingerprint !== restoredFingerprint)
      )
        return result(remote, true, 'WORKER_REMOTE_CHANGED');
    }
    const restored =
      remote !== null &&
      current.before?.versionId === remote.versionId &&
      (current.status === 'restore-intent' || current.status === 'restored') &&
      remote.message === restoreMessage(context.deploymentId);
    if (
      restored &&
      restoredFingerprint !== undefined &&
      remote.settingsFingerprint !== restoredFingerprint
    )
      return result(remote, true, 'WORKER_REMOTE_CHANGED');
    if (
      own &&
      ['deploy-intent', 'unknown', 'uploaded', 'recovery-required'].includes(
        current.status,
      )
    ) {
      current.after = {
        versionId: remote.versionId,
        deploymentId: remote.deploymentId,
        settingsFingerprint: remote.settingsFingerprint,
        tag: remote.tag,
      };
      current.status = current.stageArtifactInvalid
        ? 'recovery-required'
        : 'uploaded';
      await save(context);
      return {
        status: current.status,
        ...(current.stageArtifactInvalid
          ? { diagnosticCode: 'WORKER_ASSETS_UNPROVEN' }
          : {}),
        remote: current.after,
        canRestoreWorker: current.before !== null,
      };
    }
    if (restored) {
      current.status = 'restored';
      current.restored = {
        versionId: remote.versionId,
        deploymentId: remote.deploymentId,
        settingsFingerprint: remote.settingsFingerprint,
      };
      await save(context);
      return {
        status: 'restored',
        remote: current.restored,
        canRestoreWorker: true,
      };
    }
    const expected =
      current.status === 'restored'
        ? (current.restored ?? current.before)
        : (current.after ?? current.before);
    const expectedFingerprint =
      current.status === 'restored'
        ? restoreFingerprint(current)
        : expected?.settingsFingerprint;
    if (
      (remote?.versionId ?? null) !== (expected?.versionId ?? null) ||
      (remote?.deploymentId ?? null) !== (expected?.deploymentId ?? null) ||
      (remote !== null &&
        expectedFingerprint !== undefined &&
        remote.settingsFingerprint !== expectedFingerprint)
    )
      return result(remote, true, 'WORKER_REMOTE_CHANGED');
    return {
      status: unresolved ? 'unknown' : current.status,
      ...(unresolved
        ? { conflict: false, diagnosticCode: 'WORKER_RESULT_UNKNOWN' }
        : {}),
      remote: remote && {
        versionId: remote.versionId,
        deploymentId: remote.deploymentId,
      },
      canRestoreWorker: current.before !== null,
    };
  }
  async function deploy(context) {
    cancelled(context.signal ?? signal);
    const current = state(context);
    if (current.status !== 'prepared')
      throw new CloudflareError(
        'WORKER_RECOVERY_REQUIRED',
        '本次 Worker 已有部署紀錄，請先查詢狀態。',
      );
    await checkStage(context);
    const remote = await inspect();
    if (
      (remote?.versionId ?? null) !== (current.before?.versionId ?? null) ||
      (remote?.deploymentId ?? null) !==
        (current.before?.deploymentId ?? null) ||
      (remote?.settingsFingerprint ?? null) !==
        (current.before?.settingsFingerprint ?? null)
    )
      throw new CloudflareError(
        'WORKER_REMOTE_CHANGED',
        'Worker 在上傳期間已被修改，請先查詢狀態。',
      );
    current.status = 'deploy-intent';
    await save(context);
    try {
      await execute(context, false);
      current.wranglerSucceeded = true;
      await save(context);
    } catch {
      current.status = 'unknown';
      await save(context);
      if (!(context.signal ?? signal)?.aborted) {
        try {
          const checked = await status(context);
          if (checked.status === 'uploaded') return current.after;
        } catch {
          /* 不以後續查證失敗覆蓋已持久化的未知寫入。 */
        }
      }
      if (
        current.stageArtifactInvalid &&
        current.status === 'recovery-required'
      )
        throw new CloudflareError(
          'WORKER_ASSETS_UNPROVEN',
          'Worker 版本已確認，但靜態檔案在發布期間變更，無法證明本次網站內容；請依紀錄還原。',
        );
      throw new CloudflareError(
        'WORKER_RESULT_UNKNOWN',
        'Worker 部署結果尚未確認，請先查詢本次部署狀態。',
        { unknown: true },
      );
    }
    try {
      const verified = await status(context);
      if (verified.status === 'uploaded') return current.after;
    } catch {
      /* 保留 intent，交由狀態查證。 */
    }
    if (current.stageArtifactInvalid && current.status === 'recovery-required')
      throw new CloudflareError(
        'WORKER_ASSETS_UNPROVEN',
        'Worker 版本已確認，但靜態檔案在發布期間變更，無法證明本次網站內容；請依紀錄還原。',
      );
    current.status = 'unknown';
    await save(context);
    throw new CloudflareError(
      'WORKER_RESULT_UNKNOWN',
      'Worker 部署尚未確認生效，請先查詢本次部署狀態。',
      { unknown: true },
    );
  }
  async function preflightRestore(context) {
    cancelled(context.signal ?? signal);
    const current = state(context);
    if (['unknown', 'deploy-intent'].includes(current.status))
      throw new CloudflareError(
        'WORKER_RECOVERY_REQUIRED',
        'Worker 部署結果未知，請先查詢狀態。',
      );
    if (
      current.status === 'restore-intent' &&
      (await status(context)).status !== 'restored'
    )
      throw new CloudflareError(
        'WORKER_RECOVERY_REQUIRED',
        'Worker 回復結果未知，請先查詢狀態。',
      );
    const remote = await inspect();
    const expected =
      current.status === 'restored'
        ? (current.restored ?? current.before)
        : (current.after ?? current.before);
    const expectedFingerprint =
      current.status === 'restored'
        ? restoreFingerprint(current)
        : expected?.settingsFingerprint;
    if (
      (remote?.versionId ?? null) !== (expected?.versionId ?? null) ||
      (remote?.deploymentId ?? null) !== (expected?.deploymentId ?? null) ||
      (remote !== null &&
        expectedFingerprint !== undefined &&
        remote.settingsFingerprint !== expectedFingerprint)
    )
      throw new CloudflareError(
        'WORKER_REMOTE_CHANGED',
        'Worker 已由其他部署更新，停止還原。',
      );
    if (current.before === null)
      return { canRestoreWorker: false, alreadyRestored: remote === null };
    const versions = await api('/versions?deployable=true');
    if (
      !object(versions) ||
      !Array.isArray(versions.items) ||
      !versions.items
        .slice(0, 100)
        .some((version) => version.id === current.before.versionId)
    )
      throw new CloudflareError(
        'WORKER_RESTORE_VERSION_UNAVAILABLE',
        '原 Worker 版本已超出可回復範圍，停止整批還原。',
      );
    const version = await api(`/versions/${current.before.versionId}`);
    if (
      !object(version) ||
      version.id !== current.before.versionId ||
      !object(version.resources)
    )
      throw malformed();
    if (
      (version.resources.bindings &&
        Object.keys(version.resources.bindings).length > 0) ||
      version.resources.script_runtime?.migration_tag
    )
      throw new CloudflareError(
        'WORKER_RESTORE_VERSION_UNAVAILABLE',
        '原 Worker 版本包含不同綁定或遷移，停止整批還原。',
      );
    return {
      canRestoreWorker: true,
      alreadyRestored: remote?.versionId === current.before.versionId,
      remote: {
        versionId: remote.versionId,
        deploymentId: remote.deploymentId,
        settingsFingerprint: remote.settingsFingerprint,
      },
    };
  }
  async function restore(context) {
    cancelled(context.signal ?? signal);
    const current = state(context);
    const preflight = await preflightRestore(context);
    if (!preflight.canRestoreWorker)
      return { restored: false, reason: 'no-before-version' };
    if (preflight.alreadyRestored) {
      current.status = 'restored';
      current.restored = preflight.remote;
      await save(context);
      return { restored: true, versionId: current.before.versionId };
    }
    current.status = 'restore-intent';
    await save(context);
    try {
      await api('/deployments', {
        method: 'POST',
        body: {
          strategy: 'percentage',
          versions: [{ version_id: current.before.versionId, percentage: 100 }],
          annotations: {
            'workers/message': restoreMessage(context.deploymentId),
          },
        },
      });
    } catch (error) {
      if (!error.unknown) {
        current.status = current.after ? 'uploaded' : 'prepared';
        await save(context);
        throw error;
      }
    }
    try {
      if ((await status(context)).status === 'restored')
        return { restored: true, versionId: current.before.versionId };
    } catch {
      /* 寫入已送出，不能改報未執行。 */
    }
    throw new CloudflareError(
      'WORKER_RESTORE_UNKNOWN',
      'Worker 回復結果尚未確認，請先查詢狀態。',
      { unknown: true },
    );
  }
  return {
    preflight,
    stage,
    dryRun: (context) => execute(context, true),
    deploy,
    status,
    preflightRestore,
    restore,
  };
}
