import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSiteOutput } from '../../server/src/build/render/validate.js';
import { RenderError } from '../../server/src/build/render/context.js';
import { uiModels } from '../fixtures/ui-models.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function bundleDiagnostics(packageName: string) {
  const root = await mkdtemp(join(tmpdir(), 'foliohaven-bundle-boundary-'));
  roots.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(
    join(root, 'assets/probe.js'),
    `globalThis.packageReference = ${JSON.stringify(packageName)};`,
  );
  try {
    await validateSiteOutput({
      outputDirectory: root,
      model: uiModels().model,
      manifest: { schemaVersion: 1, assets: [] },
    });
    throw new Error(
      'The deliberately incomplete output should fail validation.',
    );
  } catch (error) {
    if (!(error instanceof RenderError)) throw error;
    expect(error.code).toBe('OUTPUT_VALIDATION_FAILED');
    // This fixture isolates a real JavaScript file. Missing-page/feed errors
    // are expected; only the browser-boundary diagnostic is asserted below.
    return error.diagnostics;
  }
}

describe('public JavaScript bundle namespace boundary', () => {
  it.each([
    '@alfred-wiki/server',
    '@alfred-wiki/server/runtime',
    '@foliohaven/server',
    '@foliohaven/server/runtime',
  ])(
    'rejects private server references from both product names: %s',
    async (name) => {
      expect(await bundleDiagnostics(name)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'PRIVATE_BROWSER_BUNDLE',
            resource: 'dist/assets/probe.js',
          }),
        ]),
      );
    },
  );

  it.each(['@foliohaven/ui', '@foliohaven/core'])(
    'does not mistake a public package label for a private server: %s',
    async (name) => {
      expect(
        (await bundleDiagnostics(name)).filter(
          (diagnostic) => diagnostic.code === 'PRIVATE_BROWSER_BUNDLE',
        ),
      ).toEqual([]);
    },
  );
});
