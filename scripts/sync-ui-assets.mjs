import { watch } from 'node:fs';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(
  new URL('../packages/ui/src/styles/', import.meta.url),
);
const target = fileURLToPath(
  new URL('../packages/ui/dist/styles/', import.meta.url),
);

async function sync() {
  if (!(await stat(source)).isDirectory()) {
    throw new Error('UI 樣式來源必須是目錄。');
  }
  if (!(await stat(join(source, 'index.css'))).isFile()) {
    throw new Error('缺少 UI 公開樣式入口 index.css。');
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, dereference: false });
  console.log('UI CSS 已更新至套件公開輸出。');
}

try {
  await sync();
  if (process.argv.includes('--watch')) {
    let timer;
    let pending = Promise.resolve();
    const watcher = watch(source, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        pending = pending.then(sync).catch(() => {
          console.error('UI CSS watch 失敗，請確認來源檔案及權限。');
          watcher.close();
          process.exitCode = 1;
        });
      }, 50);
    });
    watcher.on('error', () => {
      clearTimeout(timer);
      watcher.close();
      console.error('UI CSS watch 失敗，請確認來源目錄及權限。');
      process.exitCode = 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        clearTimeout(timer);
        watcher.close();
      });
    }
  }
} catch {
  console.error(
    'UI CSS 複製失敗；需要 packages/ui/src/styles/ 的正式樣式來源。',
  );
  process.exitCode = 1;
}
