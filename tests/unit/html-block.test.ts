import { describe, expect, it } from 'vitest';
import { extractHtmlHeadingBlock } from '../../packages/core/src/html/index.js';

describe('extractHtmlHeadingBlock', () => {
  it('moves a complete wrapped series block with exact author bytes and preserves references', () => {
    const before =
      '<p data-note="</div>">原文 &amp; 標記。</p>\n<!-- <h2 id="series">comment only</h2> -->\n';
    const block =
      '<div class="wp-block-group">\n<!-- series -->\n<section data-layout="custom">\n<h2 id="series">系列文章</h2>\n<div><blockquote><a href="/first/">No1. 第一篇</a></blockquote><blockquote><a href="https://example.test/second/?a=1&amp;b=2">No2. 第二篇</a></blockquote></div>\n<h3 id="series-note">系列附註</h3>\n<p>作者原文不改寫。</p>\n</section>\n</div>';
    const after =
      '\n\n<div><h2 id="references">參考資料</h2><ul><li><a href="https://example.test/source/">原始來源</a></li></ul></div>\n';
    const html = before + block + after;
    const result = extractHtmlHeadingBlock(html, 'series');
    expect(result).toEqual({ contentHtml: before + after, blockHtml: block });
    expect(result?.contentHtml).toContain('id="references"');
    expect(before + result?.blockHtml + after).toBe(html);
  });

  it('rejects blocks that contain another heading at the same or higher level', () => {
    for (const html of [
      '<div><h2 id="series">系列</h2><h2 id="other">另一區</h2></div>',
      '<section><h3 id="series">系列</h3><h2 id="other">較高層級</h2></section>',
      '<div><h2 id="series">系列</h2><template><h2 id="other">另一個原始標題</h2></template></div>',
    ])
      expect(extractHtmlHeadingBlock(html, 'series')).toBeUndefined();
  });

  it('never carries preceding meaningful content or unrelated wrappers into the footer', () => {
    for (const html of [
      '<div>前言<h2 id="series">系列</h2></div>',
      '<div><p>前言</p><section><h2 id="series">系列</h2></section></div>',
      '<section><div></div><div><h2 id="series">系列</h2></div></section>',
      '<div><article><h2 id="series">系列</h2></article></div>',
    ])
      expect(extractHtmlHeadingBlock(html, 'series')).toBeUndefined();
  });

  it('refuses ambiguous, missing, unsupported or incomplete heading blocks', () => {
    for (const html of [
      '<div><h2 id="series">系列</h2></div><section><h2 id="series">重複</h2></section>',
      '<p id="series">重複 ID</p><div><h2 id="series">系列</h2></div>',
      '<div><h2 id="other">沒有目標</h2></div>',
      '<h2 id="series">沒有容器</h2>',
      '<article><div><h2 id="series">非頂層容器</h2></div></article>',
      '<template><div><h2 id="series">隱藏的 template 內容</h2></div></template>',
      '<div><h2 id="series">缺少容器結束標記</h2>',
    ])
      expect(extractHtmlHeadingBlock(html, 'series')).toBeUndefined();
  });
});
