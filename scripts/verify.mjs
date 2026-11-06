import { fileURLToPath } from 'node:url';
import { managedProcess } from './managed-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let active;
let stopping = false;
const stop = () => {
  stopping = true;
  void active?.stop();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  for (const script of [
    'format:check',
    'lint',
    'typecheck',
    'test',
    'test:environment',
    'test:integration',
    'build',
    'test:e2e',
  ]) {
    if (stopping) throw new Error('VERIFY_CANCELLED');
    process.stdout.write(`驗證：${script}\n`);
    active = managedProcess('pnpm', ['run', script], {
      cwd: root,
      stopGraceMs: 12_000,
    });
    const result = await active.done;
    if (stopping || result.code !== 0) throw new Error('VERIFY_FAILED');
  }
} catch {
  process.stderr.write(
    stopping
      ? 'VERIFY_CANCELLED：驗證已中止。\n'
      : 'VERIFY_FAILED：必要檢查失敗，後續步驟未執行。\n',
  );
  process.exitCode = stopping ? 130 : 1;
} finally {
  await active?.stop();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
