import { fileURLToPath } from 'node:url';
import { createStaticPreview, RepositoryError } from '@foliohaven/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const preview = createStaticPreview({ repositoryRoot: root });
let shutdown;
const stop = () => {
  shutdown ??= preview.close().catch(() => {
    process.stderr.write('PREVIEW_STOP_FAILED：預覽服務未能正常停止。\n');
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const container = process.argv[2] === '--container';
  if (process.argv.length !== (container ? 3 : 2))
    throw new RepositoryError(
      'PREVIEW_ARGUMENT_INVALID',
      '預覽只服務根dist，不接受任意路徑。',
      400,
    );
  const { url } = await preview.listen({
    host: container ? '0.0.0.0' : '127.0.0.1',
  });
  process.stdout.write(`dist 預覽：${url}\n`);
} catch (error) {
  process.stderr.write(
    (error instanceof RepositoryError
      ? `${error.code}：${error.message}`
      : 'PREVIEW_FAILED：無法啟動dist預覽，請先完成正式建置並檢查連接埠。') +
      '\n',
  );
  process.exitCode = 1;
  stop();
  await shutdown;
}
