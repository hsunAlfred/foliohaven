import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateResource } from '../../../scripts/workspace-paths.mjs';
import { randomUUID } from 'node:crypto';
import { committedWorkspace } from './committed-workspace.js';
import {
  scanBuildInputs,
  copyBuildSnapshot,
} from '../../../server/src/build/inputs.js';
import { prepareSnapshotDependencies } from '../../../server/src/build/dependencies.js';
import { runControlledProcess } from '../../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../../server/src/runtime/environment.js';

export const publishedImageId = '12345678-1234-4123-8123-123456789abc';
export const draftImageId = '87654321-4321-4321-8321-cba987654321';
export const draftSentinel = 'ONLY_DRAFT_6a8e7349_NEVER_PUBLIC';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function overlaySources(root: string, sourceRoot: string) {
  for (const resource of [
    'server',
    'packages/core',
    'packages/ui',
    'site',
    'scripts',
  ]) {
    await rm(join(root, resource), { recursive: true, force: true });
    const source = join(sourceRoot, resource);
    await cp(source, join(root, resource), {
      recursive: true,
      filter: (path) =>
        !relative(source, path)
          .split('/')
          .some((part) =>
            [
              'node_modules',
              'dist',
              '.astro',
              '.foliohaven',
              '.alfred',
            ].includes(part),
          ),
    });
  }
  for (const resource of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
  ])
    await cp(join(sourceRoot, resource), join(root, resource));
}
export async function captureSiteWorkspaceSources() {
  const base = await committedWorkspace();
  try {
    await overlaySources(base.root, repository);
    return base;
  } catch (error) {
    await base.cleanup();
    throw error;
  }
}
export async function siteWorkspace(empty = false, sourceRoot = repository) {
  const { root, cleanup } = await committedWorkspace();
  try {
    // HEAD 是穩定基底；只覆蓋測試所需來源，不複製既有產物或 node_modules。
    await overlaySources(root, sourceRoot);
    await rm(join(root, 'content'), { recursive: true, force: true });
    await mkdir(join(root, 'content/articles'), { recursive: true });
    await mkdir(join(root, 'content/pages'), { recursive: true });
    await writeFile(
      join(root, 'content/site.json'),
      JSON.stringify({
        siteName: 'SSG驗收網站 & <安全文字>',
        siteDescription: 'SSR完整內容與來源隔離驗收',
        siteUrl: 'https://example.invalid/',
        language: 'zh-Hant',
        timeZone: 'Asia/Taipei',
        author: { name: 'Fixture' },
        navigation: [
          { label: '首頁', href: '/' },
          { label: '筆記', href: '/category/notes/' },
          { label: '工具', href: '/category/tools/' },
          { label: '介紹', href: '/about/' },
        ],
        pagination: { category: 2, tag: 2, articles: 2 },
        home: { featuredArticleIds: empty ? [] : ['entry-1'], latestCount: 5 },
        ...(empty ? { defaultSEO: { index: false } } : {}),
        googleSiteVerification: empty ? null : 'safe-fixture-verification',
      }),
    );
    await writeFile(
      join(root, 'content/categories.json'),
      JSON.stringify([
        { path: 'notes', name: '筆記', description: '筆記文章' },
        { path: 'tools', name: '工具', description: '工具文章' },
        { path: 'empty', name: '空分類', description: '空分類' },
      ]),
    );
    await writeFile(
      join(root, 'content/tags.json'),
      JSON.stringify([
        { slug: 'example', name: '範例', description: '範例文章' },
        { slug: 'empty', name: '空Tag', description: '空Tag' },
      ]),
    );
    if (!empty)
      for (let n = 1; n <= 5; n++) {
        const directory = join(root, 'content/articles', `entry-${n}`);
        await mkdir(directory);
        await writeFile(
          join(directory, 'meta.json'),
          JSON.stringify({
            status: 'published',
            title: n === 1 ? '測試 </script> & <SSR>' : `文章 ${n}`,
            slug: n === 3 ? 'content' : `entry-${n}`,
            category: n <= 3 ? 'notes' : 'tools',
            tags: n <= 4 ? ['example'] : [],
            publishedAt: `2026-01-0${6 - n}T09:00:00+08:00`,
            updatedAt: `2026-02-0${n}T10:00:00+08:00`,
            ...(n === 1
              ? {
                  featuredImage: `/media/${publishedImageId}/image.webp`,
                  featuredImageAlt: '固定圖片替代文字',
                }
              : {}),
            seo: {
              description: `文章 ${n} 的摘要 & 字元`,
              ...(n === 4 ? { index: false } : {}),
            },
          }),
        );
        await writeFile(
          join(directory, 'content.html'),
          `<!-- exact SSR fixture -->\n<h2 id="章節-${n}">文章 ${n} 章節</h2>\n<p>正文可在沒有 JavaScript 時閱讀。</p>${n === 1 ? '<p><a href="/about/#about-details">介紹anchor</a><a href="/tools/entry-4/#章節-4">另一篇</a></p>' : ''}`,
        );
      }
    const draft = join(root, 'content/articles/private-draft');
    await mkdir(draft);
    await writeFile(
      join(draft, 'meta.json'),
      JSON.stringify({
        status: 'draft',
        title: draftSentinel,
        slug: 'private-draft',
        category: 'notes',
        featuredImage: `/media/${draftImageId}/image.webp`,
        featuredImageAlt: '草稿專用',
      }),
    );
    await writeFile(
      join(draft, 'content.html'),
      `<h2 id="draft">${draftSentinel}</h2><img src="/media/${draftImageId}/image.webp" alt="草稿"/>`,
    );
    // 完整獨立頁流程：UI、固定Entry、strict資料schema及獨立SEO同時擴展。
    await mkdir(join(root, 'packages/ui/src/pages/about'), { recursive: true });
    await writeFile(
      join(root, 'packages/ui/src/pages/about/AboutFixture.tsx'),
      'export function AboutFixture({data}:{data:{heading:string;description:string}}){return <main id="ui-main" tabIndex={-1}><h1>{data.heading}</h1><h2 id="about-details">獨立頁anchor</h2><p>{data.description}</p><a href="/">首頁</a></main>;}\n',
    );
    await writeFile(
      join(root, 'packages/ui/src/index.ts'),
      (await readFile(join(root, 'packages/ui/src/index.ts'), 'utf8')) +
        "\nexport * from './pages/about/AboutFixture.js';\n",
    );
    const registry = join(root, 'site/src/fixed-pages.ts');
    await writeFile(
      registry,
      (await readFile(registry, 'utf8'))
        .replace("import type { z } from 'zod';", "import { z } from 'zod';")
        .replace(
          'export const fixedPages: readonly FixedPage[] = [',
          "export const fixedPages: readonly FixedPage[] = [FixedPageSchema.parse({id:'about',path:'/about/',entry:'src/pages/about/index.astro',seo:{title:'介紹獨立SEO',description:'獨立頁資料說明'},mediaRefs:[]}),",
        )
        .replace(
          '= {};',
          '= {about:z.strictObject({heading:z.string().min(1),description:z.string().min(1)})};',
        ),
    );
    await writeFile(
      join(root, 'content/pages/about.json'),
      JSON.stringify({
        heading: '獨立介紹頁',
        description: '來自 strict page schema 的資料',
      }),
    );
    await mkdir(join(root, 'site/src/pages/about'), { recursive: true });
    await writeFile(
      join(root, 'site/src/pages/about/index.astro'),
      `---\nimport {AboutFixture} from '@foliohaven/ui';\nimport BaseLayout from '../../layouts/BaseLayout.astro';\nimport {loadFixedPage} from '../../lib/server/context.js';\nconst model=await loadFixedPage('about');\nconst data=model.data as {heading:string;description:string};\n---\n<BaseLayout site={model.site} seo={model.seo} currentPath="/about/"><AboutFixture data={data}/></BaseLayout>\n`,
    );
    for (const id of [publishedImageId, draftImageId]) {
      const directory = join(root, 'media/source', id);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'meta.json'),
        JSON.stringify({
          schemaVersion: 1,
          id,
          kind: 'image',
          source: 'original.png',
        }),
      );
      await cp(
        join(repository, 'tests/fixtures/site/source.png'),
        join(directory, 'original.png'),
      );
    }
    const jobId = randomUUID();
    const job = join(root, privateResource(root, 'builds'), jobId);
    await mkdir(job, { recursive: true, mode: 0o700 });
    const snapshot = join(job, 'snapshot');
    const inputs = await scanBuildInputs(root);
    await copyBuildSnapshot(root, snapshot, inputs);
    await prepareSnapshotDependencies({
      repositoryRoot: root,
      snapshotRoot: snapshot,
    });
    await runControlledProcess({
      command: process.execPath,
      args: ['scripts/check-dependencies.mjs'],
      cwd: snapshot,
      env: buildProcessEnvironment(),
      timeoutMs: 60_000,
    });
    const run = async (
      args: readonly string[],
      env: Readonly<Record<string, string>> = {},
    ) =>
      runControlledProcess({
        command: 'pnpm',
        args,
        cwd: snapshot,
        env: buildProcessEnvironment(env),
        timeoutMs: 120_000,
      });
    await run([
      'exec',
      'tsc',
      '-b',
      'packages/core/tsconfig.node.json',
      'packages/ui/tsconfig.json',
      'site/tsconfig.registry.json',
    ]);
    await runControlledProcess({
      command: process.execPath,
      args: ['scripts/sync-ui-assets.mjs'],
      cwd: snapshot,
      env: buildProcessEnvironment(),
      timeoutMs: 30_000,
    });
    await run(['exec', 'tsc', '-p', 'server/tsconfig.json']);
    const revision = (await scanBuildInputs(snapshot)).revision;
    return {
      root,
      snapshot,
      jobId,
      revision,
      output: join(job, 'output'),
      cleanup,
      run,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export async function treeText(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function scan(prefix: string) {
    for (const node of await readdir(join(root, prefix), {
      withFileTypes: true,
    })) {
      const path = prefix ? `${prefix}/${node.name}` : node.name;
      if (node.isDirectory()) await scan(path);
      else result[path] = (await readFile(join(root, path))).toString('base64');
    }
  }
  await scan('');
  return result;
}
