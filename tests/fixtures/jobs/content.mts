import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FixedPageSchema } from '@foliohaven/core';
export const fixedPages = [
  FixedPageSchema.parse({
    id: 'home',
    path: '/',
    entry: 'src/pages/index.astro',
  }),
  FixedPageSchema.parse({
    id: 'articles',
    path: '/articles/',
    entry: 'src/pages/articles/index.astro',
  }),
];
export async function scanContent(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (key: string): Promise<void> => {
    for (const entry of (
      await readdir(join(root, key), { withFileTypes: true })
    ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = `${key}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else {
        const bytes = await readFile(join(root, child));
        hash.update(`${child.length}:${child}:${bytes.length}:`).update(bytes);
      }
    }
  };
  await visit('content');
  return hash.digest('hex');
}
