import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  prepareRenderContext,
  runControlledProcess,
  buildProcessEnvironment,
} from '@foliohaven/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const context = resolve(root, '.alfred/typecheck/render');
  await prepareRenderContext({
    repositoryRoot: root,
    contextDirectory: context,
    signal: controller.signal,
  });
  await runControlledProcess({
    command: 'pnpm',
    args: ['--filter', '@foliohaven/site', 'typecheck'],
    cwd: root,
    env: buildProcessEnvironment({
      ALFRED_RENDER_CONTEXT: context,
      ALFRED_RENDER_OUTPUT: resolve(root, '.alfred/typecheck/site-output'),
    }),
    timeoutMs: 15 * 60_000,
    maxOutputBytes: 32 * 1024 * 1024,
    signal: controller.signal,
    onOutput: (stream, chunk) => process[stream].write(chunk),
  });
} catch {
  process.stderr.write(
    'SITE_TYPECHECK_FAILED：網站型別或來源檢查失敗，請依診斷修正。\n',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
