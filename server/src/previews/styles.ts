import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { RepositoryError } from '../files/io.js';
import { fileIdentity, fileIdentityIsStable } from '../files/revision-cache.js';

const maximumBytes = 2 * 1024 * 1024;

interface StylesheetDependency {
  readonly reference: string;
  readonly path: string;
  readonly identity: string;
  readonly sha256: string;
  readonly stable: boolean;
}
interface StylesheetBundle {
  readonly entry: string;
  readonly root: string;
  readonly bytes: Buffer;
  readonly dependencies: readonly StylesheetDependency[];
}
async function current(
  bundle: StylesheetBundle,
  verifyRecent = false,
): Promise<boolean> {
  try {
    if (dirname(await realpath(bundle.entry)) !== bundle.root) return false;
    for (const dependency of bundle.dependencies) {
      const path = await realpath(dependency.reference);
      if (path !== dependency.path || dirname(path) !== bundle.root)
        return false;
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || fileIdentity(stat) !== dependency.identity)
          return false;
        if (!fileIdentityIsStable(stat)) {
          if (!verifyRecent) return false;
          const bytes = await handle.readFile();
          if (
            createHash('sha256').update(bytes).digest('hex') !==
              dependency.sha256 ||
            fileIdentity(await handle.stat({ bigint: true })) !==
              dependency.identity
          )
            return false;
        }
      } finally {
        await handle.close();
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** One bounded bundle, revalidated against every import before reuse. */
export class PreviewStylesCache {
  #bundle: StylesheetBundle | undefined;
  async read(entry: string): Promise<Buffer> {
    const cached = this.#bundle;
    this.#bundle = undefined;
    if (cached?.entry === entry && (await current(cached))) {
      this.#bundle = cached;
      return cached.bytes;
    }
    const bundle = await loadPreviewStyles(entry);
    if (bundle.dependencies.every((dependency) => dependency.stable))
      this.#bundle = bundle;
    return bundle.bytes;
  }
}

/** Bundle only the trusted UI package's same-directory CSS imports for the sandbox. */
export async function bundlePreviewStyles(entry: string): Promise<Buffer> {
  return (await loadPreviewStyles(entry)).bytes;
}
async function loadPreviewStyles(entry: string): Promise<StylesheetBundle> {
  try {
    const root = dirname(await realpath(entry));
    const dependencies: StylesheetDependency[] = [];
    let bytes = 0;
    let files = 0;
    const expand = async (
      name: string,
      ancestors: ReadonlySet<string>,
    ): Promise<string> => {
      if (
        !/^[a-z0-9-]+\.css$/u.test(name) ||
        ancestors.has(name) ||
        ++files > 64
      )
        throw new Error('Unsupported preview stylesheet graph');
      const reference = join(root, name);
      const path = await realpath(reference);
      if (dirname(path) !== root)
        throw new Error('Stylesheet escaped package directory');
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let source: string;
      try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.size > BigInt(maximumBytes))
          throw new Error('Invalid preview stylesheet');
        source = await handle.readFile('utf8');
        dependencies.push({
          reference,
          path,
          identity: fileIdentity(stat),
          sha256: createHash('sha256').update(source).digest('hex'),
          stable: fileIdentityIsStable(stat),
        });
      } finally {
        await handle.close();
      }
      bytes += Buffer.byteLength(source);
      if (bytes > maximumBytes) throw new Error('Preview stylesheet limit');
      const stack = new Set([...ancestors, name]);
      const imports = [...source.matchAll(/@import\s+(['"])([^'"]+)\1\s*;/gu)];
      let output = '';
      let cursor = 0;
      for (const match of imports) {
        const reference = match[2];
        if (
          reference === undefined ||
          !/^\.\/[a-z0-9-]+\.css$/u.test(reference)
        )
          throw new Error('Unsupported preview stylesheet import');
        output += source.slice(cursor, match.index);
        output += await expand(reference.slice(2), stack);
        cursor = match.index + match[0].length;
      }
      output += source.slice(cursor);
      if (/@import\b/iu.test(output))
        throw new Error('Unresolved preview stylesheet import');
      return output;
    };
    const result = Buffer.from(
      await expand(basename(entry), new Set()),
      'utf8',
    );
    if (result.byteLength > maximumBytes)
      throw new Error('Preview stylesheet limit');
    const bundle = { entry, root, bytes: result, dependencies };
    if (!(await current(bundle, true))) throw new Error('Stylesheets changed');
    return bundle;
  } catch {
    throw new RepositoryError(
      'PREVIEW_STYLES_INVALID',
      '預覽共用樣式無法完整載入，請確認套件樣式完整且沒有不支援的引用。',
      503,
    );
  }
}
