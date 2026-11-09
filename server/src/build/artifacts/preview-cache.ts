import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { asciiCompare, UuidSchema } from '@foliohaven/core';
import { privateResource, safePath, safeRelative } from '../../files/io.js';
import { fileIdentityIsStable } from '../../files/revision-cache.js';

export interface PreviewFingerprint {
  readonly digest: string;
}

function stamp(resource: string, stat: BigIntStats): string {
  return JSON.stringify([
    resource,
    ...[
      stat.dev,
      stat.ino,
      stat.mode,
      stat.uid,
      stat.gid,
      stat.nlink,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].map(String),
  ]);
}

async function scan(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function metadata(resource: string, kind?: 'file' | 'directory') {
    if (!safeRelative(resource) || /\p{Cc}/u.test(resource))
      throw new Error('Invalid preview path');
    const path = join(root, resource);
    const stat = await lstat(path, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      !(stat.isFile() || stat.isDirectory()) ||
      (kind === 'file' && !stat.isFile()) ||
      (kind === 'directory' && !stat.isDirectory())
    )
      throw new Error('Invalid preview entry');
    // Coarse filesystems can report the same stat identity for same-tick writes.
    // A recent or future entry therefore needs the full hash/proof path.
    if (!fileIdentityIsStable(stat))
      throw new Error('Preview metadata is not stable yet');
    return { path, stat, stamp: stamp(resource, stat) };
  }
  async function anchors(): Promise<string[]> {
    return Promise.all(
      ['dist', privateResource(root, 'artifacts')].map(async (resource) => {
        await safePath(root, resource);
        return (await metadata(resource, 'directory')).stamp;
      }),
    );
  }
  // Validate ancestors once per anchor. Descendants come only from readdir,
  // and each directory's identity and entries are checked again after traversal.
  const beforeAnchors = JSON.stringify(await anchors());
  async function directory(
    resource: string,
    visit: (names: readonly string[], device: bigint) => Promise<void>,
    device?: bigint,
  ): Promise<void> {
    const before = await metadata(resource, 'directory');
    if (device !== undefined && before.stat.dev !== device)
      throw new Error('Preview filesystem changed');
    const names = (await readdir(before.path)).sort(asciiCompare);
    const entries = JSON.stringify(names);
    hash.update(before.stamp).update(entries);
    await visit(names, before.stat.dev);
    const after = await metadata(resource, 'directory');
    if (
      after.stamp !== before.stamp ||
      JSON.stringify((await readdir(after.path)).sort(asciiCompare)) !== entries
    )
      throw new Error('Preview directory changed');
  }
  async function tree(resource: string, device: bigint): Promise<void> {
    const entry = await metadata(resource);
    if (entry.stat.dev !== device)
      throw new Error('Preview filesystem changed');
    if (entry.stat.isDirectory()) {
      await directory(
        resource,
        async (names) => {
          for (const name of names) await tree(`${resource}/${name}`, device);
        },
        device,
      );
    } else hash.update(entry.stamp);
  }
  await directory('dist', async (names, device) => {
    for (const name of names) await tree(`dist/${name}`, device);
  });
  // Watch journals without traversing backup/base/prepared media or locks;
  // acquiring the artifact lease must not invalidate a validated preview.
  await directory(privateResource(root, 'artifacts'), async (names) => {
    if (!names.includes('state.json')) throw new Error('Preview state missing');
    for (const name of names) {
      const resource = privateResource(root, `artifacts/${name}`);
      if (
        name === 'state.json' ||
        /^state\.json\.[a-f0-9-]+\.tmp$/u.test(name)
      ) {
        hash.update((await metadata(resource, 'file')).stamp);
      } else {
        if (!UuidSchema.safeParse(name).success)
          throw new Error('Invalid preview journal');
        await directory(resource, async () => {
          hash.update(
            (await metadata(`${resource}/journal.json`, 'file')).stamp,
          );
        });
      }
    }
  });
  if (JSON.stringify(await anchors()) !== beforeAnchors)
    throw new Error('Preview anchors changed');
  return hash.digest('hex');
}

/** Only metadata is read; any uncertainty falls back to full artifact validation. */
export async function capturePreviewFingerprint(
  root: string,
): Promise<PreviewFingerprint | undefined> {
  try {
    const digest = await scan(root);
    return (await scan(root)) === digest ? { digest } : undefined;
  } catch {
    return undefined;
  }
}

export async function previewFingerprintMatches(
  root: string,
  fingerprint: PreviewFingerprint,
): Promise<boolean> {
  return (await capturePreviewFingerprint(root))?.digest === fingerprint.digest;
}
