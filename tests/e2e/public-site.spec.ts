import { test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createStaticPreview } from '@foliohaven/server';
import {
  expectSearchPublicSite,
  expectStaticPublicSite,
  publicSiteExpected,
} from '../fixtures/public-site/assertions.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
let preview: ReturnType<typeof createStaticPreview>;
let expected: Awaited<ReturnType<typeof publicSiteExpected>>;
let url: string;
test.beforeAll(async () => {
  expected = await publicSiteExpected(repositoryRoot);
  preview = createStaticPreview({ repositoryRoot });
  url = (await preview.listen({ port: 0 })).url;
});
test.afterAll(async () => {
  await preview?.close();
  await expected?.cleanup();
});

test('the actual root dist follows current public source models without JavaScript at 375px', async ({
  browser,
}) => {
  await expectStaticPublicSite(browser, url, expected);
});

test('the actual search hydrates once and follows Core query, pagination and history rules', async ({
  page,
}) => {
  await expectSearchPublicSite(page, url, expected);
});
