import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FixedPageSchema } from '@foliohaven/core';
import { validateFixedPageEntries } from '@foliohaven/core/node';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-entries-'));
  roots.push(root);
  await mkdir(join(root, 'site/src/pages'), { recursive: true });
  return root;
}
async function entry(root: string, path: string) {
  const target = join(root, 'site', path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, '---\n---\n');
}
const page = (id: string, path: string, entry: string) =>
  FixedPageSchema.parse({ id, path, entry, seo: {}, mediaRefs: [] });
describe('固定頁入口與路由登錄一致性', () => {
  it.each([
    ['src/pages/_hidden.astro', '/_hidden/'],
    ['src/pages/private/_hidden/index.astro', '/private/_hidden/'],
    ['src/pages/.hidden.astro', '/.hidden/'],
    ['src/pages/private/.draft/index.astro', '/private/.draft/'],
  ])('Astro忽略的Entry不得登錄成會生成的路由：%s', async (entryPath, path) => {
    const root = await fixture();
    await entry(root, entryPath);
    await expect(
      validateFixedPageEntries(root, [page('hidden', path, entryPath)]),
    ).rejects.toMatchObject({ code: 'INVALID_FIXED_ENTRY' });
    expect(await validateFixedPageEntries(root, [])).toEqual([]);
  });
  it('依Astro正式例外允許.well-known目錄內的已登錄頁', async () => {
    const root = await fixture();
    const p = page(
      'well-known',
      '/.well-known/status/',
      'src/pages/.well-known/status.astro',
    );
    await entry(root, p.entry);
    expect(await validateFixedPageEntries(root, [p])).toEqual([p]);
  });

  it('即使未登錄任何頁，也拒絕pages祖先目錄symlink', async () => {
    const root = await fixture();
    await rm(join(root, 'site/src/pages'), { recursive: true });
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, 'site/src/pages'));
    await expect(validateFixedPageEntries(root, [])).rejects.toMatchObject({
      code: 'SOURCE_SYMLINK',
    });
  });

  it('首頁／一般頁／巢狀子頁合法共存，系統動態與endpoint明確例外', async () => {
    const root = await fixture();
    const pages = [
      page('home', '/', 'src/pages/index.astro'),
      page('about', '/about/', 'src/pages/about/index.astro'),
      page('team', '/about/team/', 'src/pages/about/team.astro'),
    ];
    for (const p of pages) await entry(root, p.entry);
    for (const p of [
      'src/pages/[...article].astro',
      'src/pages/category/[...category].astro',
      'src/pages/tag/[...tag].astro',
      'src/pages/404.astro',
      'src/pages/rss.xml.ts',
      'src/pages/robots.txt.ts',
      'src/pages/search-index.json.ts',
    ])
      await entry(root, p);
    expect(await validateFixedPageEntries(root, pages)).toEqual(pages);
  });
  it('未登錄的一般頁不能悄悄進入公開產物', async () => {
    const root = await fixture();
    await entry(root, 'src/pages/about.astro');
    await expect(validateFixedPageEntries(root, [])).rejects.toMatchObject({
      code: 'UNREGISTERED_FIXED_ENTRY',
    });
  });
  it('登錄Entry缺失須失敗', async () => {
    const root = await fixture();
    await expect(
      validateFixedPageEntries(root, [
        page('about', '/about/', 'src/pages/about.astro'),
      ]),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });
  it('URL與實體Astro路由不一致時拒絕', async () => {
    const root = await fixture();
    await entry(root, 'src/pages/about.astro');
    await expect(
      validateFixedPageEntries(root, [
        page('about', '/different/', 'src/pages/about.astro'),
      ]),
    ).rejects.toMatchObject({ code: 'FIXED_ROUTE_MISMATCH' });
  });
  it('重複ID／URL／Entry皆不可登錄', async () => {
    const root = await fixture();
    await entry(root, 'src/pages/about.astro');
    const p = page('about', '/about/', 'src/pages/about.astro');
    await expect(validateFixedPageEntries(root, [p, p])).rejects.toMatchObject({
      code: 'DUPLICATE_FIXED_PAGE',
    });
  });
  it('系統404與動態入口不可作為一般固定頁', async () => {
    const root = await fixture();
    await entry(root, 'src/pages/404.astro');
    await expect(
      validateFixedPageEntries(root, [
        page('error', '/404/', 'src/pages/404.astro'),
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_FIXED_ENTRY' });
  });
  it('入口與子目錄symlink拒絕，不讀取外部來源', async () => {
    const root = await fixture();
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, 'site/src/pages/linked'));
    await expect(validateFixedPageEntries(root, [])).rejects.toMatchObject({
      code: 'SOURCE_SYMLINK',
    });
  });
  it('新endpoint與Markdown不得繞過入口登錄', async () => {
    const root = await fixture();
    await entry(root, 'src/pages/private.ts');
    await expect(validateFixedPageEntries(root, [])).rejects.toMatchObject({
      code: 'UNREGISTERED_FIXED_ENTRY',
    });
  });
});
