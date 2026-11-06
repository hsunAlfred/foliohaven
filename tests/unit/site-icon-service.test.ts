import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { SiteConfigSchema } from '@foliohaven/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FileRepository } from '../../server/src/files/index.js';
import { MediaService } from '../../server/src/media/index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-site-icons-'));
  roots.push(root);
  const repository = new FileRepository({ repositoryRoot: root });
  await repository.initialize();
  const service = new MediaService({ repositoryRoot: root, repository });
  const original = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="25" fill="#404040"/></svg>',
  );
  const source = (
    await service.register(
      await service.stageSource(Readable.from([original]), {
        filename: 'icon.svg',
        mimeType: 'image/svg+xml',
        displayName: 'Site icon',
      }),
    )
  ).value;
  return { root, repository, service, source, original };
}
describe('website icon processing and immutable receipts', () => {
  it('protects an active separate Safari source and ignores a disabled retained selection', async () => {
    const { root, service, source } = await fixture();
    await mkdir(join(root, 'content/articles'), { recursive: true });
    await writeFile(join(root, 'content/categories.json'), '[]');
    await writeFile(join(root, 'content/tags.json'), '[]');
    const site = SiteConfigSchema.parse({
      siteName: 'Icons fixture',
      siteDescription: 'Notes',
      siteUrl: 'https://example.invalid/',
      author: { name: 'Author' },
      icons: { enabled: true, maskIcon: `/media/${source.id}/image.svg` },
    });
    const sitePath = join(root, 'content/site.json');
    await writeFile(sitePath, JSON.stringify(site));
    await expect(
      service.remove(source.id, (await service.get(source.id)).etag),
    ).rejects.toMatchObject({ code: 'MEDIA_IN_USE' });
    await writeFile(
      sitePath,
      JSON.stringify({ ...site, icons: { ...site.icons, enabled: false } }),
    );
    await service.remove(source.id, (await service.get(source.id)).etag);
    await expect(service.get(source.id)).rejects.toMatchObject({
      code: 'MEDIA_NOT_FOUND',
    });
  });
  it('separates the new preset, replays its completion and automatically resolves icon references', async () => {
    const { root, service, source, original } = await fixture();
    const regular = await service.process(source.id);
    expect(regular.presetVersion).toBe('article-image-v3');
    const jobId = randomUUID();
    const packed = await service.process(source.id, {
      preset: 'site-icons',
      jobId,
    });
    expect(packed.presetVersion).toBe('site-icons-v1');
    const path = `/media/${source.id}/icon-512.png`;
    expect(
      packed.outputs.find((output) => output.publicPath === path),
    ).toMatchObject({ mimeType: 'image/png', width: 512, height: 512 });
    expect(
      packed.outputs.some((output) =>
        output.publicPath.endsWith('/mask-icon.svg'),
      ),
    ).toBe(true);
    expect(
      await service.process(source.id, { preset: 'site-icons', jobId }),
    ).toEqual(packed);
    await expect(
      service.process(source.id, { preset: 'article-image', jobId }),
    ).rejects.toMatchObject({ code: 'MEDIA_JOB_RECEIPT_MISMATCH' });
    expect(await service.processReferences([path])).toMatchObject({
      assets: [{ presetVersion: 'site-icons-v1' }],
    });
    expect(
      await readFile(join(root, 'media/source', source.id, 'original.svg')),
    ).toEqual(original);
    const file = await service.openVariant(source.id, 'icon-512.png');
    expect(file.headers['Content-Type']).toBe('image/png');
    for await (const _chunk of file.stream) {
      /* Drain the verified file. */
    }
  }, 30000);
});
