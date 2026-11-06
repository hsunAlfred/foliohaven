import { afterEach, describe, expect, it } from 'vitest';
import {
  lstat,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundlePreviewStyles,
  PreviewStylesCache,
} from '../../server/src/previews/styles.js';

const fixtures: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-preview-styles-'));
  fixtures.push(root);
  return root;
}
afterEach(async () => {
  for (const root of fixtures.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('sandbox preview stylesheet bundling', () => {
  it('reuses a bundle only while every dependency is current and never falls back after invalid imports', async () => {
    const root = await fixture();
    const entry = join(root, 'index.css');
    const imported = join(root, 'article.css');
    await writeFile(entry, "@import './article.css';");
    await writeFile(imported, '.first {color:red}');
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const cache = new PreviewStylesCache();
    const first = await cache.read(entry);
    expect(await cache.read(entry)).toBe(first);
    const before = await lstat(imported);
    await writeFile(imported, '.other {color:red}');
    await utimes(imported, before.atime, before.mtime);
    expect((await cache.read(entry)).toString()).toContain('.other');
    await rm(imported);
    await expect(cache.read(entry)).rejects.toMatchObject({
      code: 'PREVIEW_STYLES_INVALID',
    });
    await writeFile(entry, '.fixed {color:red}');
    expect((await cache.read(entry)).toString()).toContain('.fixed');
    await writeFile(join(root, 'private.css'), '.private {}');
    const directory = join(root, 'nested');
    await mkdir(directory);
    const nestedEntry = join(directory, 'index.css');
    await writeFile(nestedEntry, '.safe {}');
    await cache.read(nestedEntry);
    await writeFile(nestedEntry, "@import './outside.css';");
    await symlink(join(root, 'private.css'), join(directory, 'outside.css'));
    await expect(cache.read(nestedEntry)).rejects.toMatchObject({
      code: 'PREVIEW_STYLES_INVALID',
    });
  });
  it('limits the imported stylesheet graph before accepting a preview bundle', async () => {
    const root = await fixture();
    const imports = Array.from(
      { length: 64 },
      (_, index) => `part-${index}.css`,
    );
    await writeFile(
      join(root, 'index.css'),
      imports.map((name) => `@import './${name}';`).join('\n'),
    );
    await Promise.all(
      imports.map((name) =>
        writeFile(join(root, name), '.bounded { color: inherit; }'),
      ),
    );
    await expect(
      bundlePreviewStyles(join(root, 'index.css')),
    ).rejects.toMatchObject({ code: 'PREVIEW_STYLES_INVALID' });
  });

  it('inlines nested local imports in cascade order without additional requests', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'index.css'),
      "@import './base.css';\n@import './article.css';\n.last {color:red}",
    );
    await writeFile(join(root, 'base.css'), '.first {display:flex}\n');
    await writeFile(
      join(root, 'article.css'),
      "@import './tokens.css';\n.article {display:grid}\n",
    );
    await writeFile(join(root, 'tokens.css'), ':root {--ink: #343944}\n');
    const css = (await bundlePreviewStyles(join(root, 'index.css'))).toString();
    expect(css).not.toContain('@import');
    expect(css.indexOf('.first')).toBeLessThan(css.indexOf(':root'));
    expect(css.indexOf(':root')).toBeLessThan(css.indexOf('.article'));
    expect(css.indexOf('.article')).toBeLessThan(css.indexOf('.last'));
  });

  it.each([
    "@import '../private.css';",
    "@import 'https://example.invalid/private.css';",
    "@import url('./other.css');",
  ])('rejects unsupported or escaping import %s', async (source) => {
    const root = await fixture();
    await writeFile(join(root, 'index.css'), source);
    await expect(
      bundlePreviewStyles(join(root, 'index.css')),
    ).rejects.toMatchObject({ code: 'PREVIEW_STYLES_INVALID' });
  });

  it('rejects cycles, missing imports and symlinks outside the trusted styles directory', async () => {
    const root = await fixture();
    const styles = join(root, 'styles');
    await mkdir(styles);
    await writeFile(join(styles, 'index.css'), "@import './cycle.css';");
    await writeFile(join(styles, 'cycle.css'), "@import './index.css';");
    await expect(
      bundlePreviewStyles(join(styles, 'index.css')),
    ).rejects.toMatchObject({ code: 'PREVIEW_STYLES_INVALID' });
    await writeFile(join(styles, 'index.css'), "@import './missing.css';");
    await expect(
      bundlePreviewStyles(join(styles, 'index.css')),
    ).rejects.toMatchObject({ code: 'PREVIEW_STYLES_INVALID' });
    await writeFile(join(root, 'private.css'), 'DO_NOT_EXPOSE');
    await symlink(join(root, 'private.css'), join(styles, 'outside.css'));
    await writeFile(join(styles, 'index.css'), "@import './outside.css';");
    await expect(
      bundlePreviewStyles(join(styles, 'index.css')),
    ).rejects.toMatchObject({ code: 'PREVIEW_STYLES_INVALID' });
  });

  it('enforces a total size limit across imported files', async () => {
    const root = await fixture();
    await writeFile(join(root, 'index.css'), "@import './large.css';");
    await writeFile(join(root, 'large.css'), ' '.repeat(2 * 1024 * 1024));
    await expect(
      bundlePreviewStyles(join(root, 'index.css')),
    ).rejects.toMatchObject({ code: 'PREVIEW_STYLES_INVALID' });
  });
});
