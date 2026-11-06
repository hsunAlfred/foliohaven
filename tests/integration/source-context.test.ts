import { it, expect } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { committedWorkspace } from '../fixtures/build/committed-workspace.js';
import { scanBuildInputs } from '../../server/src/build/inputs.js';

it('uses complete verified build inputs when the Docker source context has no Git metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alfred-source-context-'));
  try {
    for (const path of [
      'content/articles',
      'packages/core',
      'packages/ui',
      'site',
      'studio',
      'server',
      'scripts',
    ])
      await mkdir(join(root, path), { recursive: true });
    for (const [path, value] of Object.entries({
      '.node-version': '26.12.1',
      'package.json': '{"name":"source-context","private":true}',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'pnpm-workspace.yaml': 'packages: []\n',
      'content/site.json': '{"fixture":true}',
      'scripts/native.mjs': 'export const value = 1;',
    }))
      await writeFile(join(root, path), value);
    const context = await committedWorkspace(root);
    try {
      expect((await scanBuildInputs(context.root)).revision).toBe(
        (await scanBuildInputs(root)).revision,
      );
      expect(
        await readFile(join(context.root, 'content/site.json'), 'utf8'),
      ).toBe('{"fixture":true}');
    } finally {
      await context.cleanup();
    }
    await symlink('/etc/hostname', join(root, 'content/unsafe.json'));
    await expect(committedWorkspace(root)).rejects.toMatchObject({
      code: 'RESOURCE_SYMLINK',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
