import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CONTENT_LIMITS } from '@foliohaven/core';
import {
  ContentSourceError,
  loadContent,
  readSourceBytes,
  readSourceJson,
  sourcePath,
} from '@foliohaven/core/node';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const draft = { status: 'draft' };
const published = {
  status: 'published',
  title: '已發布範例',
  slug: 'hello',
  category: 'notes',
  tags: [],
  publishedAt: '2026-10-23T08:00:00+08:00',
  updatedAt: '2026-10-23T08:00:00+08:00',
  seo: { description: '這是測試說明。' },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-loader-'));
  roots.push(root);
  await mkdir(join(root, 'content/articles'), { recursive: true });
  await writeFile(
    join(root, 'content/site.json'),
    JSON.stringify({
      siteName: '測試站',
      siteDescription: '測試說明',
      siteUrl: 'https://example.invalid/',
      author: { name: '測試作者' },
    }),
  );
  await writeFile(join(root, 'content/categories.json'), '[]');
  await writeFile(join(root, 'content/tags.json'), '[]');
  return root;
}
async function article(root: string, id: string, meta: unknown, html?: string) {
  await mkdir(join(root, 'content/articles', id));
  await writeFile(
    join(root, 'content/articles', id, 'meta.json'),
    JSON.stringify(meta),
  );
  if (html !== undefined)
    await writeFile(join(root, 'content/articles', id, 'content.html'), html);
}
function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('正式來源 Loader 的資料、隔離與安全邊界', () => {
  it('不截斷超限站台／taxonomy與頁面資料', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'content/site.json'),
      ' '.repeat(CONTENT_LIMITS.siteBytes + 1),
    );
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'SOURCE_TOO_LARGE',
    });
    await writeFile(
      join(root, 'content/site.json'),
      JSON.stringify({
        siteName: '測試站',
        siteDescription: '說明',
        siteUrl: 'https://example.invalid/',
        author: { name: '作者' },
      }),
    );
    await writeFile(
      join(root, 'content/tags.json'),
      ' '.repeat(CONTENT_LIMITS.taxonomyBytes + 1),
    );
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'SOURCE_TOO_LARGE',
    });
    await writeFile(join(root, 'content/tags.json'), '[]');
    await mkdir(join(root, 'content/pages'));
    await writeFile(
      join(root, 'content/pages/about.json'),
      ' '.repeat(CONTENT_LIMITS.pageBytes + 1),
    );
    await expect(
      loadContent(root, {
        pageSchemas: { about: z.strictObject({ title: z.string() }) },
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
  });
  it('正文總量超過256 MiB明確拒絕，沒有截斷文章集合', async () => {
    const root = await fixture();
    const chunk = 'a'.repeat(CONTENT_LIMITS.articleHtmlBytes);
    for (let i = 0; i < 52; i++)
      await article(root, `large-${i}`, published, chunk);
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'PUBLISHED_HTML_LIMIT_EXCEEDED',
    });
  });
  it('保留正文UTF-8 BOM字元，不默默重寫作者文字', async () => {
    const root = await fixture();
    const html = '\ufeff<p>原始文字</p>';
    await article(root, 'bom', published, html);
    expect((await loadContent(root)).articles[0]?.contentHtml).toBe(html);
  });

  it('接受空集合與.gitkeep，缺省只在模型補值且不改寫來源', async () => {
    const root = await fixture();
    await writeFile(join(root, 'content/articles/.gitkeep'), '');
    const before = await readFile(join(root, 'content/site.json'));
    const loaded = await loadContent(root);
    expect(loaded.articles).toEqual([]);
    expect(loaded.pages).toEqual({});
    expect(loaded.site.language).toBe('zh-Hant');
    expect(loaded.site.defaultSEO.index).toBe(true);
    expect(digest(await readFile(join(root, 'content/site.json')))).toBe(
      digest(before),
    );
  });
  it('正式排除已驗證草稿，不讀缺失或不完整的草稿正文', async () => {
    const root = await fixture();
    await article(root, 'incomplete-draft', draft);
    await article(root, 'bad-html-draft', draft, '<h1>草稿尚未完成');
    expect((await loadContent(root)).articles).toEqual([]);
    await expect(loadContent(root, { mode: 'preview' })).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    });
  });
  it('本機可讀取未完成草稿正文與語意，沒有假發布URL', async () => {
    const root = await fixture();
    await article(root, 'draft-one', draft, '<h2>尚未完成');
    const loaded = await loadContent(root, { mode: 'preview' });
    expect(loaded.articles[0]?.meta.status).toBe('draft');
    expect(loaded.articles[0]?.contentHtml).toBe('<h2>尚未完成');
  });
  it('讀取已發布正文、保留offset日期與原始文字且不回寫兩檔', async () => {
    const root = await fixture();
    const html = '<h2 id="原文">原文</h2>\n<p>空白  保留。</p>\n';
    await article(root, 'published-one', published, html);
    const originalMeta = await readFile(
      join(root, 'content/articles/published-one/meta.json'),
    );
    const result = await loadContent(root);
    expect(result.articles[0]?.contentHtml).toBe(html);
    expect(result.articles[0]?.meta.publishedAt).toBe(published.publishedAt);
    expect(
      await readFile(join(root, 'content/articles/published-one/meta.json')),
    ).toEqual(originalMeta);
    expect(
      await readFile(
        join(root, 'content/articles/published-one/content.html'),
        'utf8',
      ),
    ).toBe(html);
  });
  it.each([
    {},
    { status: 'unknown' },
    { status: 'draft', extra: true },
    { status: 'draft', publishedAt: '2026-02-30T00:00:00Z' },
  ])('不以草稿為由吞掉錯誤metadata：%j', async (meta) => {
    const root = await fixture();
    await article(root, 'invalid-one', meta);
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'INVALID_SOURCE_DATA',
    });
  });
  it('壞JSON明確拒絕而非回傳空集合', async () => {
    const root = await fixture();
    await article(root, 'bad-json', draft);
    await writeFile(join(root, 'content/articles/bad-json/meta.json'), '{');
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'INVALID_JSON',
    });
  });
  it('缺meta及已發布缺正文分別報必要檔案缺失', async () => {
    const root = await fixture();
    await mkdir(join(root, 'content/articles/missing-meta'));
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    });
    await rm(join(root, 'content/articles/missing-meta'), { recursive: true });
    await article(root, 'missing-html', published);
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    });
  });
  it.each(['<p>CRLF</p>\r\n', '<p>NUL\0</p>'])(
    '拒絕CRLF／NUL且不自動改寫',
    async (html) => {
      const root = await fixture();
      await article(root, 'bad-html', published, html);
      await expect(loadContent(root)).rejects.toBeInstanceOf(
        ContentSourceError,
      );
      expect(
        await readFile(
          join(root, 'content/articles/bad-html/content.html'),
          'utf8',
        ),
      ).toBe(html);
    },
  );
  it('拒絕無效UTF-8', async () => {
    const root = await fixture();
    await article(root, 'invalid-utf8', published, '');
    await writeFile(
      join(root, 'content/articles/invalid-utf8/content.html'),
      Buffer.from([0xc3, 0x28]),
    );
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'INVALID_UTF8',
    });
  });
  it('拒絕超過64 KiB的metadata與超過5 MiB的正文', async () => {
    const root = await fixture();
    await article(root, 'large', draft);
    await writeFile(
      join(root, 'content/articles/large/meta.json'),
      ' '.repeat(CONTENT_LIMITS.articleMetaBytes + 1),
    );
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'SOURCE_TOO_LARGE',
    });
    await writeFile(
      join(root, 'content/articles/large/meta.json'),
      JSON.stringify(published),
    );
    await writeFile(
      join(root, 'content/articles/large/content.html'),
      'a'.repeat(CONTENT_LIMITS.articleHtmlBytes + 1),
    );
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'SOURCE_TOO_LARGE',
    });
  });
  it('拒絕文章目錄symlink、巢狀目錄及非預期來源', async () => {
    const root = await fixture();
    await article(root, 'valid', published, '<p>正文</p>');
    await symlink(
      join(root, 'content/articles/valid'),
      join(root, 'content/articles/linked'),
    );
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'INVALID_ARTICLE_DIRECTORY',
    });
    await rm(join(root, 'content/articles/linked'));
    await mkdir(join(root, 'content/articles/valid/nested'));
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'INVALID_ARTICLE_FILE',
    });
  });
  it('拒絕metadata與祖先目錄symlink', async () => {
    const root = await fixture();
    await article(root, 'valid', published, '<p>正文</p>');
    await writeFile(join(root, 'outside.json'), JSON.stringify(published));
    await rm(join(root, 'content/articles/valid/meta.json'));
    await symlink(
      join(root, 'outside.json'),
      join(root, 'content/articles/valid/meta.json'),
    );
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'SOURCE_SYMLINK',
    });
    await mkdir(join(root, 'real'));
    await writeFile(join(root, 'real/file'), 'x');
    await symlink(join(root, 'real'), join(root, 'linked'));
    await expect(
      readSourceBytes(root, 'linked/file', 100),
    ).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  });
  it.each(['../private', '/etc/passwd', 'a/../b', 'a\\b', 'a\0b', 'a//b'])(
    '拒絕不安全資源識別：%s',
    (resource) => {
      expect(() => sourcePath('/tmp/workspace', resource)).toThrow(
        ContentSourceError,
      );
    },
  );
  it('頁面專用資料須登錄strict schema，支援獨立頁面資料契約', async () => {
    const root = await fixture();
    await mkdir(join(root, 'content/pages'));
    await writeFile(
      join(root, 'content/pages/about.json'),
      JSON.stringify({ headline: '關於本站' }),
    );
    await expect(loadContent(root)).rejects.toMatchObject({
      code: 'UNREGISTERED_PAGE_DATA',
    });
    const options = {
      pageSchemas: { about: z.strictObject({ headline: z.string() }) },
    };
    expect((await loadContent(root, options)).pages.about).toEqual({
      headline: '關於本站',
    });
    await writeFile(
      join(root, 'content/pages/about.json'),
      JSON.stringify({ headline: '關於本站', extra: true }),
    );
    await expect(loadContent(root, options)).rejects.toMatchObject({
      code: 'INVALID_SOURCE_DATA',
    });
  });
  it('相對診斷不洩漏絕對工作路徑或Node錯誤細節', async () => {
    const root = await fixture();
    await article(root, 'invalid', { status: 'published' });
    try {
      await loadContent(root);
      throw new Error('預期拒絕');
    } catch (error) {
      expect(error).toBeInstanceOf(ContentSourceError);
      const safe = error as ContentSourceError;
      expect(
        JSON.stringify({
          message: safe.message,
          diagnostics: safe.diagnostics,
        }),
      ).not.toContain(root);
      expect(safe.diagnostics[0]?.resource).toBe(
        'content/articles/invalid/meta.json',
      );
    }
    expect(await readSourceJson(root, 'content/tags.json', 100)).toEqual([]);
  });
});
