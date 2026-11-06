import { fileURLToPath } from 'node:url';
import {
  exportReleaseWorkspace,
  packageRelease,
  ReleaseError,
} from './release-source.mjs';

try {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (
      !['--directory', '--output', '--source'].includes(name) ||
      !value ||
      value.startsWith('--') ||
      name in options
    )
      throw new ReleaseError(
        'RELEASE_ARGUMENT_INVALID',
        '請指定 --directory 或 --output，以及可選的 --source。',
      );
    options[name] = value;
  }
  if (Boolean(options['--directory']) === Boolean(options['--output']))
    throw new ReleaseError(
      'RELEASE_ARGUMENT_INVALID',
      '請擇一指定 --directory 或 --output。',
    );
  const sourceRoot =
    options['--source'] ?? fileURLToPath(new URL('../', import.meta.url));
  const operation = options['--directory']
    ? exportReleaseWorkspace
    : packageRelease;
  const result = await operation({
    sourceRoot,
    destination: options['--directory'] ?? options['--output'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const failure =
    error instanceof ReleaseError
      ? error
      : new ReleaseError(
          'RELEASE_EXPORT_FAILED',
          '無法完成匯出；請檢查來源、輸出權限與 tar 工具。',
        );
  process.stderr.write(`${failure.code}：${failure.message}\n`);
  process.exitCode = 1;
}
