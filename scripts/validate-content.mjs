import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  acquireFileLease,
  prepareRenderContext,
  scanBuildInputs,
  safeRenderFailure,
} from '@foliohaven/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let lease;
try {
  if (process.argv.length !== 2) throw new Error('VALIDATION_ARGUMENT_INVALID');
  lease = await acquireFileLease({
    root,
    name: 'content-validation',
    owner: 'content-validator',
    signal: controller.signal,
  });
  const before = await scanBuildInputs(root, { signal: controller.signal });
  const prepared = await prepareRenderContext({
    repositoryRoot: root,
    contextDirectory: resolve(root, '.alfred/validation/render'),
    signal: controller.signal,
  });
  if (
    (await scanBuildInputs(root, { signal: controller.signal })).revision !==
    before.revision
  )
    throw new Error('VALIDATION_INPUT_CHANGED');
  process.stdout.write(
    JSON.stringify({
      event: 'content-validated',
      sourceRevision: before.revision,
      articleCount: prepared.model.articles.length,
      routeCount: prepared.model.routeManifest.routes.length,
      mediaPending: prepared.model.mediaPending,
      pendingOutputLinkChecks: prepared.model.pendingLinkChecks.length,
      diagnostics: prepared.model.diagnostics.map(
        ({ severity, code, articleId, resource, field, line, column }) => ({
          severity,
          code,
          articleId,
          resource,
          field,
          line,
          column,
        }),
      ),
    }) + '\n',
  );
} catch (error) {
  process.stderr.write(
    JSON.stringify({ event: 'content-invalid', ...safeRenderFailure(error) }) +
      '\n',
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  await lease?.release();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
