import { privateResource } from './workspace-paths.mjs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDirectory } from './private-directory.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const projects = [
  'packages/core/tsconfig.json',
  'packages/core/tsconfig.node.json',
  'packages/ui/tsconfig.json',
  'site/tsconfig.registry.json',
  'server/tsconfig.json',
];
const packages = ['packages/core', 'packages/ui', 'site', 'server'];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
let fixture;

function write(relativePath, value) {
  const path = join(fixture, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function link(relativePath, target) {
  const path = join(fixture, 'node_modules', relativePath);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'dir');
}

function linkDependency(name) {
  const locations = [...packages, 'site', 'studio', '.'];
  for (const location of locations) {
    try {
      const dependencyRequire = createRequire(
        join(repository, location, 'package.json'),
      );
      link(name, dirname(dependencyRequire.resolve(`${name}/package.json`)));
      return;
    } catch (error) {
      if (
        error.code !== 'MODULE_NOT_FOUND' &&
        error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      ) {
        throw error;
      }
    }
  }
  throw new Error(`找不到已安裝的 ${name}；請先完成 frozen install。`);
}

function execute(arguments_, expectedDiagnostic) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expectedDiagnostic) {
    if (result.status === 0 || !expectedDiagnostic.test(output)) {
      throw new Error(`編譯器未依預期拒絕錯誤 fixture。\n${output}`);
    }
  } else if (result.status !== 0) {
    throw new Error(`編譯或 exports 執行失敗。\n${output}`);
  }
  return output;
}

function assertNoJavaScript(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) assertNoJavaScript(path);
    else if (/\.(?:js|d\.ts)$/.test(entry.name)) {
      throw new Error(
        'noEmitOnError 未阻止錯誤 fixture 產生 JS／declaration。',
      );
    }
  }
}

try {
  const compiler = require.resolve('typescript/bin/tsc');
  const graph = readJson(join(repository, 'tsconfig.build.json'));
  const referencedProjects = graph.references?.map(({ path }) =>
    resolve(repository, path),
  );
  if (
    referencedProjects?.length !== projects.length ||
    !projects.every((path) =>
      referencedProjects.includes(resolve(repository, path)),
    )
  ) {
    throw new Error(
      '實際 tsconfig.build.json 必須列出Core純／Node、UI、site registry、server。',
    );
  }

  const checksDirectory = ensurePrivateDirectory(
    repository,
    privateResource(repository, 'environment-checks'),
  );
  fixture = mkdtempSync(join(checksDirectory, 'compiler-'));
  write('package.json', { private: true, type: 'module' });
  write('tsconfig.build.json', graph);

  for (const project of projects) {
    const source = readJson(join(repository, project));
    write(project, {
      extends: join(repository, project),
      compilerOptions: {
        rootDir: source.compilerOptions.rootDir,
        outDir: source.compilerOptions.outDir,
        tsBuildInfoFile: source.compilerOptions.tsBuildInfoFile,
      },
      include: source.include,
      exclude: source.exclude,
      ...(source.references ? { references: source.references } : {}),
    });
  }

  for (const path of packages) {
    const source = readJson(join(repository, path, 'package.json'));
    if (
      !source.private ||
      source.type !== 'module' ||
      !source.exports?.[path === 'site' ? './registry' : '.']
    ) {
      throw new Error(`${path} 缺少 private ESM／公開 exports 契約。`);
    }
    write(`${path}/package.json`, {
      name: source.name,
      private: true,
      type: source.type,
      exports: source.exports,
    });
    link(source.name, join(fixture, path));
  }
  for (const dependency of [
    'zod',
    'react',
    'react-dom',
    '@types/node',
    '@types/react',
    '@types/react-dom',
  ]) {
    linkDependency(dependency);
  }

  write(
    'packages/core/src/index.ts',
    `import { z } from "zod";
export const articleHeadingSchema = z.strictObject({ title: z.string().trim().min(1) });
export type ArticleHeading = z.infer<typeof articleHeadingSchema>;
export function parseArticleHeading(input: unknown): ArticleHeading {
  return articleHeadingSchema.parse(input);
}
`,
  );
  write(
    'packages/core/src/node/index.ts',
    `import { readFile } from "node:fs/promises";
import { parseArticleHeading, type ArticleHeading } from "../index.js";
export async function loadArticleHeading(source: URL): Promise<ArticleHeading> {
  const input: unknown = JSON.parse(await readFile(source, "utf8"));
  return parseArticleHeading(input);
}
`,
  );
  write(
    'packages/ui/src/index.tsx',
    `import type { ArticleHeading } from "@foliohaven/core";
export interface ArticleCardProps { heading: ArticleHeading; }
export function ArticleCard({ heading }: ArticleCardProps) {
  return <article><h2>{heading.title}</h2></article>;
}
`,
  );
  write(
    'site/src/fixed-pages.ts',
    `import { parseArticleHeading } from "@foliohaven/core";
export const configuredHeading = parseArticleHeading({ title: "編譯 & exports" });
`,
  );
  write(
    'server/src/index.tsx',
    `import { renderToStaticMarkup } from "react-dom/server";
import { loadArticleHeading } from "@foliohaven/core/node";
import { ArticleCard } from "@foliohaven/ui";
import { configuredHeading } from "@foliohaven/site/registry";
export async function renderArticleFromFile(source: URL): Promise<string> {
  const heading = await loadArticleHeading(source);
  if (heading.title !== configuredHeading.title) throw new Error("公開registry設定不一致。");
  return renderToStaticMarkup(<ArticleCard heading={heading} />);
}
`,
  );

  execute([compiler, '--build', 'tsconfig.build.json', '--pretty', 'false']);
  for (const path of [
    'packages/core/dist/index',
    'packages/core/dist/node/index',
    'packages/ui/dist/index',
    'site/dist/registry/fixed-pages',
    'server/dist/index',
  ]) {
    for (const extension of ['js', 'd.ts']) {
      if (!existsSync(join(fixture, `${path}.${extension}`))) {
        throw new Error(`缺少已編譯的 ${path}.${extension}。`);
      }
    }
  }

  // The consumer has no project references: only package exports and emitted declarations.
  write('consumer/tsconfig.json', {
    extends: join(repository, 'server/tsconfig.json'),
    compilerOptions: {
      rootDir: './src',
      outDir: './dist',
      tsBuildInfoFile: './dist/.tsbuildinfo',
    },
    include: ['src/**/*.ts'],
    exclude: ['dist', 'node_modules'],
    references: [],
  });
  write('consumer/article.json', { title: '編譯 & exports' });
  write(
    'consumer/src/index.ts',
    `import { parseArticleHeading, type ArticleHeading } from "@foliohaven/core";
import { renderArticleFromFile } from "@foliohaven/server";
const heading: ArticleHeading = parseArticleHeading({ title: "編譯 & exports" });
const html = await renderArticleFromFile(new URL("../article.json", import.meta.url));
if (heading.title !== "編譯 & exports" || html !== "<article><h2>編譯 &amp; exports</h2></article>") {
  throw new Error("Zod、Node 檔案讀取或 React escaping 結果不符。");
}
process.stdout.write("compiler-fixture-ok\\n");
`,
  );
  execute([
    compiler,
    '--project',
    'consumer/tsconfig.json',
    '--pretty',
    'false',
  ]);
  if (execute(['consumer/dist/index.js']).trim() !== 'compiler-fixture-ok') {
    throw new Error('編譯後的 exports consumer 沒有完成實際資料流程。');
  }

  const negativeCases = [
    {
      name: 'exact-optional',
      project: 'packages/core/tsconfig.json',
      source: `type Article = { description?: string };\nexport const article: Article = { description: undefined };\n`,
      diagnostic: /error TS2375:/,
    },
    {
      name: 'unchecked-index',
      project: 'packages/core/tsconfig.json',
      source: `export function firstTitle(titles: readonly string[]): string { return titles[0]; }\n`,
      diagnostic: /error TS2322:/,
    },
    {
      name: 'core-node-global',
      project: 'packages/core/tsconfig.json',
      source: `export const executable: string = process.execPath;\n`,
      diagnostic: /Cannot find name ['"]process['"]/,
    },
    {
      name: 'ui-node-global',
      project: 'packages/ui/tsconfig.json',
      source: `export const executable: string = process.execPath;\n`,
      diagnostic: /Cannot find name ['"]process['"]/,
    },
  ];
  for (const { name, project, source, diagnostic } of negativeCases) {
    const directory = `negative/${name}`;
    write(`${directory}/src/index.ts`, source);
    write(`${directory}/tsconfig.json`, {
      extends: join(repository, project),
      compilerOptions: {
        rootDir: './src',
        outDir: './dist',
        tsBuildInfoFile: './dist/.tsbuildinfo',
      },
      include: ['src/**/*.ts'],
      exclude: ['dist', 'node_modules'],
      references: [],
    });
    execute(
      [
        compiler,
        '--project',
        `${directory}/tsconfig.json`,
        '--pretty',
        'false',
      ],
      diagnostic,
    );
    assertNoJavaScript(join(fixture, directory, 'dist'));
  }
  console.log(
    'Compiler 檢查通過：實際五專案編譯、JS／declaration exports、Zod／Node／React 資料流程，以及四個拒絕錯誤案例。',
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `Compiler 檢查失敗：${message.replaceAll(fixture ?? repository, '<compiler-fixture>').replaceAll(repository, '<repository>')}`,
  );
  process.exitCode = 1;
} finally {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
}
