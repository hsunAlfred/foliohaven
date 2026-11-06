import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const rootRequire = createRequire(join(repository, 'package.json'));
const coreRequire = createRequire(
  join(repository, 'packages/core/package.json'),
);
const serverRequire = createRequire(join(repository, 'server/package.json'));
const siteRequire = createRequire(join(repository, 'site/package.json'));

async function command(executable, args, cwd = repository) {
  return execute(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}

async function installedVersion(require, name) {
  let directory = dirname(require.resolve(name));
  for (;;) {
    try {
      const metadata = JSON.parse(
        await readFile(join(directory, 'package.json'), 'utf8'),
      );
      if (metadata.name === name) {
        assert.match(metadata.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u);
        return metadata.version;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert.notEqual(
      directory,
      parse(directory).root,
      '找不到已安裝套件的版本。',
    );
    directory = dirname(directory);
  }
}

async function load(require, name) {
  const module = await import(pathToFileURL(require.resolve(name)).href);
  return { module, version: await installedVersion(require, name) };
}

async function check(label, operation) {
  try {
    const detail = await operation();
    console.log(`相容檢查通過：${label}${detail ? `（${detail}）` : ''}`);
  } catch {
    // 不轉印第三方錯誤、子程序 stderr 或 stack，避免帶出執行環境資料。
    throw new Error(
      `相容檢查失敗：${label}。請核對固定工具鏈、frozen 安裝及原生工具。`,
    );
  }
}

export async function checkDependencies() {
  await check('非 root 與固定 Node.js／pnpm', async () => {
    assert.equal(process.platform, 'linux');
    assert.notEqual(process.getuid?.(), 0);
    const manifest = JSON.parse(
      await readFile(join(repository, 'package.json'), 'utf8'),
    );
    assert.match(manifest.engines?.node, /^\d+\.\d+\.\d+$/u);
    assert.equal(process.versions.node, manifest.engines.node);
    assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
    const expectedPnpm = manifest.packageManager.slice('pnpm@'.length);
    const { stdout } = await command('pnpm', ['--version']);
    assert.equal(stdout.trim(), expectedPnpm);
    return `Node.js ${process.versions.node}；pnpm ${expectedPnpm}`;
  });

  await check('Core HTML parser 與嚴格 Schema', async () => {
    const { module: parser, version: parserVersion } = await load(
      coreRequire,
      'parse5',
    );
    const { module: schemaModule, version: schemaVersion } = await load(
      coreRequire,
      'zod',
    );
    const z = schemaModule.z ?? schemaModule.default.z;
    const errors = [];
    const fragment = parser.parseFragment('<h2 id="sample">相容檢查</h2>', {
      sourceCodeLocationInfo: true,
      onParseError: (error) => errors.push(error),
    });
    assert.deepEqual(errors, []);
    assert.equal(fragment.childNodes[0].tagName, 'h2');
    assert.equal(fragment.childNodes[0].attrs[0].value, 'sample');
    assert.equal(fragment.childNodes[0].sourceCodeLocation.startLine, 1);
    const schema = z.strictObject({ title: z.string().min(1) });
    assert.deepEqual(schema.parse({ title: '相容檢查' }), {
      title: '相容檢查',
    });
    assert.equal(schema.safeParse({ title: 123 }).success, false);
    assert.equal(
      schema.safeParse({ title: '相容檢查', unknown: true }).success,
      false,
    );
    return `parse5 ${parserVersion}；Zod ${schemaVersion}`;
  });

  await check('網站 React 靜態 HTML', async () => {
    const { module: reactModule, version: reactVersion } = await load(
      siteRequire,
      'react',
    );
    const react = reactModule.default ?? reactModule;
    const rendererModule = await import(
      pathToFileURL(siteRequire.resolve('react-dom/server')).href
    );
    const renderer = rendererModule.default ?? rendererModule;
    const html = renderer.renderToStaticMarkup(
      react.createElement('p', null, '<相容檢查>'),
    );
    assert.equal(html, '<p>&lt;相容檢查&gt;</p>');
    const domVersion = await installedVersion(siteRequire, 'react-dom');
    assert.equal(reactVersion, domVersion);
    return `React／ReactDOM ${reactVersion}`;
  });

  await check('tsx 使用的 esbuild 原生轉譯', async () => {
    const tsxRequire = createRequire(rootRequire.resolve('tsx/package.json'));
    const { module: esbuildModule, version } = await load(
      tsxRequire,
      'esbuild',
    );
    const esbuild = esbuildModule.default ?? esbuildModule;
    const result = await esbuild.transform(
      'const value: number = 2; export default value + 3;',
      {
        loader: 'ts',
        format: 'esm',
        target: 'es2022',
      },
    );
    assert.match(result.code, /value\s*=\s*2/u);
    assert.doesNotMatch(result.code, /:\s*number/u);
    assert.deepEqual(result.warnings, []);
    return `esbuild ${version}`;
  });

  await check('本機 locked Playwright CLI', async () => {
    const version = await installedVersion(rootRequire, '@playwright/test');
    const cli = rootRequire.resolve('@playwright/test/cli');
    const { stdout } = await command(process.execPath, [cli, '--version']);
    assert.equal(stdout.trim(), `Version ${version}`);
    return `Playwright ${version}`;
  });

  await check('本機 locked Cloudflare Wrangler 與 R2 SDK', async () => {
    const { module: s3, version: sdkVersion } = await load(
      rootRequire,
      '@aws-sdk/client-s3',
    );
    assert.equal(typeof s3.S3Client, 'function');
    assert.equal(typeof s3.CreateMultipartUploadCommand, 'function');
    const metadataPath = rootRequire.resolve('wrangler/package.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const cli = join(dirname(metadataPath), metadata.bin.wrangler);
    const environment = {
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_WRITE_LOGS: 'false',
      WRANGLER_HIDE_BANNER: 'true',
      CI: 'true',
    };
    for (const name of ['PATH', 'HOME', 'PNPM_HOME'])
      if (process.env[name]) environment[name] = process.env[name];
    const { stdout } = await execute(process.execPath, [cli, '--version'], {
      cwd: repository,
      env: environment,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(stdout.trim(), metadata.version);
    return `Wrangler ${metadata.version}；R2 SDK ${sdkVersion}`;
  });

  await check('Sharp PNG→WebP 透明像素解碼與 FFmpeg WebM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'alfred-dependency-check-'));
    try {
      const { module: sharpModule, version } = await load(
        serverRequire,
        'sharp',
      );
      const sharp = sharpModule.default ?? sharpModule;
      const png = join(directory, 'sample.png');
      const webp = join(directory, 'sample.webp');
      await sharp({
        create: {
          width: 8,
          height: 6,
          channels: 4,
          background: { r: 51, g: 102, b: 153, alpha: 0.5 },
        },
      })
        .png()
        .toFile(png);
      await sharp(png).webp({ lossless: true }).toFile(webp);
      const metadata = await sharp(webp).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.hasAlpha, true);
      const { data, info } = await sharp(webp)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 8);
      assert.equal(info.height, 6);
      assert.equal(info.channels, 4);
      assert.deepEqual([...data.subarray(0, 4)], [51, 102, 153, 128]);

      const video = join(directory, 'sample.webm');
      await command(
        'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=0x336699:s=32x24:r=5',
          '-t',
          '0.4',
          '-an',
          '-c:v',
          'libvpx-vp9',
          '-pix_fmt',
          'yuv420p',
          '-threads',
          '1',
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          '-f',
          'webm',
          '-y',
          video,
        ],
        directory,
      );
      const { stdout } = await command(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'format=format_name,duration:stream=codec_name,codec_type,width,height',
          '-of',
          'json',
          video,
        ],
        directory,
      );
      const probe = JSON.parse(stdout);
      assert.equal(probe.streams.length, 1);
      assert.deepEqual(probe.streams[0], {
        codec_name: 'vp9',
        codec_type: 'video',
        width: 32,
        height: 24,
      });
      assert.ok(probe.format.format_name.split(',').includes('webm'));
      assert.ok(
        Number(probe.format.duration) >= 0.3 &&
          Number(probe.format.duration) <= 0.6,
      );
      await command(
        'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          video,
          '-f',
          'null',
          '-',
        ],
        directory,
      );
      const { stdout: ffmpegVersion } = await command(
        'ffmpeg',
        ['-version'],
        directory,
      );
      const match = /^ffmpeg version ([\w.+~-]+)/u.exec(ffmpegVersion);
      assert.ok(match);
      return `Sharp ${version}；FFmpeg ${match[1]}`;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  console.log('相依資源實際相容檢查全部通過；此指令不驗收瀏覽器或應用功能。');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  checkDependencies().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
