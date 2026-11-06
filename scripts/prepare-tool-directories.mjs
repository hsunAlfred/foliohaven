import { fileURLToPath } from 'node:url';
import { ensurePrivateDirectory } from './private-directory.mjs';

try {
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  ensurePrivateDirectory(repositoryRoot, '.alfred/cache/typescript');
} catch {
  console.error(
    'TOOL_DIRECTORIES_INVALID：無法準備編譯快取；請確認私有目錄由目前帳號擁有，且未使用符號連結。',
  );
  process.exitCode = 1;
}
