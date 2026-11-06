import { FixedPageSchema } from '../schemas/content.js';
import type { FixedPage } from '../models/index.js';
import {
  ContentSourceError,
  readSourceBytes,
  readSourceDirectory,
} from './source.js';

export const SYSTEM_PAGE_ENTRIES: readonly string[] = Object.freeze([
  'src/pages/[...article].astro',
  'src/pages/category/[...category].astro',
  'src/pages/tag/[...tag].astro',
  'src/pages/404.astro',
  'src/pages/rss.xml.ts',
  'src/pages/robots.txt.ts',
  'src/pages/search-index.json.ts',
  'src/pages/[siteManifest].webmanifest.ts',
]);

function ignoredEntryName(name: string): boolean {
  return (
    name.startsWith('_') || (name.startsWith('.') && name !== '.well-known')
  );
}

function entryUrl(entry: string): string {
  const parts = entry.slice('src/pages/'.length, -'.astro'.length).split('/');
  if (parts.at(-1) === 'index') parts.pop();
  return parts.length === 0 ? '/' : `/${parts.join('/')}/`;
}

/** 核對Astro實體入口與Core登錄，不把所有前綴頁面誤判成碰撞。 */
export async function validateFixedPageEntries(
  root: string,
  candidates: readonly FixedPage[],
): Promise<readonly FixedPage[]> {
  const pages: FixedPage[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  const entries = new Set<string>();
  for (const candidate of candidates) {
    const parsed = FixedPageSchema.safeParse(candidate);
    if (!parsed.success)
      throw new ContentSourceError(
        'INVALID_FIXED_PAGE',
        '固定頁登錄不符合共用 Schema。',
        'site/src/fixed-pages.ts',
      );
    const page = parsed.data;
    if (
      !page.entry.startsWith('src/pages/') ||
      page.entry.slice('src/pages/'.length).split('/').some(ignoredEntryName) ||
      ['[', ']', '(', ')'].some((character) =>
        page.entry.includes(character),
      ) ||
      SYSTEM_PAGE_ENTRIES.includes(page.entry)
    ) {
      throw new ContentSourceError(
        'INVALID_FIXED_ENTRY',
        '固定頁必須對應site內的一般Astro頁面入口。',
        'site/src/fixed-pages.ts',
      );
    }
    if (entryUrl(page.entry) !== page.path)
      throw new ContentSourceError(
        'FIXED_ROUTE_MISMATCH',
        '固定頁URL必須與Astro Entry的實際路由一致。',
        'site/src/fixed-pages.ts',
      );
    if (ids.has(page.id) || urls.has(page.path) || entries.has(page.entry))
      throw new ContentSourceError(
        'DUPLICATE_FIXED_PAGE',
        '固定頁識別碼、URL及Entry均不得重複。',
        'site/src/fixed-pages.ts',
      );
    ids.add(page.id);
    urls.add(page.path);
    entries.add(page.entry);
    await readSourceBytes(root, `site/${page.entry}`, 5 * 1024 * 1024);
    pages.push(page);
  }
  async function scan(directory: string): Promise<void> {
    const nodes = await readSourceDirectory(root, `site/${directory}`);
    for (const node of nodes) {
      const resource = `${directory}/${node.name}`;
      if (node.isSymbolicLink())
        throw new ContentSourceError(
          'SOURCE_SYMLINK',
          'Astro Entry目錄不得含符號連結。',
          `site/${resource}`,
        );
      if (ignoredEntryName(node.name)) continue;
      if (node.isDirectory()) {
        await scan(resource);
        continue;
      }
      if (!/\.(astro|ts|js|md|mdx)$/.test(node.name)) continue;
      if (!node.isFile())
        throw new ContentSourceError(
          'SOURCE_NOT_FILE',
          'Astro Entry必須為一般檔案。',
          `site/${resource}`,
        );
      if (!entries.has(resource) && !SYSTEM_PAGE_ENTRIES.includes(resource))
        throw new ContentSourceError(
          'UNREGISTERED_FIXED_ENTRY',
          '新增頁面必須登錄固定頁；動態及輔助入口僅允許明列系統入口。',
          `site/${resource}`,
        );
      await readSourceBytes(root, `site/${resource}`, 5 * 1024 * 1024);
    }
  }
  try {
    await scan('src/pages');
  } catch (error) {
    if (error instanceof ContentSourceError) throw error;
    throw new ContentSourceError(
      'ENTRY_DIRECTORY_UNREADABLE',
      '無法讀取Astro頁面入口目錄。',
      'site/src/pages',
    );
  }
  return pages;
}
