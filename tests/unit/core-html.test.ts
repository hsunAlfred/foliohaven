import { describe, expect, it } from 'vitest';
import type { MediaManifest } from '../../packages/core/src/models/index.js';
import {
  analyzeHtml,
  enhanceHtmlMedia,
} from '../../packages/core/src/html/index.js';

const imageId = 'c854748f-5d6f-42b7-aebc-cbdf42cb711a';
const videoId = '241e8f33-07ef-46ce-97ba-8e4f3d8f54f0';
const image = `/media/${imageId}/image.webp`;
const small = `/media/${imageId}/image-480.webp`;
const large = `/media/${imageId}/image-1920.webp`;
const video = `/media/${videoId}/video.webm`;
const poster = `/media/${videoId}/poster.webp`;
const sha = 'a'.repeat(64);
const manifest: MediaManifest = {
  schemaVersion: 1,
  assets: [
    {
      id: imageId,
      kind: 'image',
      sourceSha256: sha,
      presetVersion: 'article-image-v1',
      tools: { sharp: '0.35.5' },
      outputs: [
        {
          publicPath: image,
          mimeType: 'image/webp',
          width: 1280,
          height: 640,
          byteSize: 10,
          sha256: sha,
        },
        {
          publicPath: small,
          mimeType: 'image/webp',
          width: 480,
          height: 240,
          byteSize: 10,
          sha256: sha,
        },
        {
          publicPath: large,
          mimeType: 'image/webp',
          width: 1920,
          height: 960,
          byteSize: 10,
          sha256: sha,
        },
      ],
    },
    {
      id: videoId,
      kind: 'video',
      sourceSha256: sha,
      presetVersion: 'article-video-v1',
      tools: { ffmpeg: '7.1', ffprobe: '7.1' },
      outputs: [
        {
          publicPath: video,
          mimeType: 'video/webm',
          width: 1280,
          height: 720,
          byteSize: 10,
          sha256: sha,
          durationSeconds: 2,
        },
        {
          publicPath: poster,
          mimeType: 'image/webp',
          width: 1280,
          height: 720,
          byteSize: 10,
          sha256: sha,
        },
      ],
    },
  ],
};

function errors(html: string): readonly string[] {
  return analyzeHtml(html)
    .diagnostics.filter((item) => item.severity === 'error')
    .map((item) => item.code);
}

describe('HTML-01: fragment structure, TOC and safe references', () => {
  it('extracts Unicode IDs, decoded plain text and only H2/H3 without changing input', () => {
    const html =
      '<!-- keep  spacing -->\n<h2 id="開始">A &amp; <em>B</em></h2>\n<h3 id="child">Child</h3><h4 id="deep">Deep</h4><p id="target">Body</p>';
    const result = analyzeHtml(html, {
      articleId: 'example',
      mode: 'published',
    });
    expect(result.toc).toEqual([
      { id: '開始', text: 'A & B', level: 2 },
      { id: 'child', text: 'Child', level: 3 },
    ]);
    expect(result.ids).toEqual(['開始', 'child', 'deep', 'target']);
    expect(result.diagnostics).toEqual([]);
    expect(html).toContain('<!-- keep  spacing -->');
    expect(analyzeHtml('<p>Without headings</p>').toc).toEqual([]);
  });

  it.each([
    ['<!doctype html><p>X</p>', 'HTML_DOCUMENT_FORBIDDEN'],
    [
      '<html><head><title>X</title></head><body><p>X</p></body></html>',
      'HTML_DOCUMENT_FORBIDDEN',
    ],
    ['<p>X</p><head></head>', 'HTML_DOCUMENT_FORBIDDEN'],
    ['<h1>Main</h1>', 'HTML_H1_FORBIDDEN'],
    ['<h2>Heading</h2>', 'HTML_HEADING_ID_REQUIRED'],
    ['<h2 id="bad id">Heading</h2>', 'HTML_ID_INVALID'],
    ['<h2 id="x">A</h2><p id="x">B</p>', 'HTML_ID_DUPLICATE'],
    ['<p id="ui-navigation">Reserved</p>', 'HTML_ID_RESERVED'],
    ['<div><em>X</div>', 'HTML_END_TAG_REQUIRED'],
    ['<h2 id="x">Missing closing<h3 id="y">Y</h3>', 'HTML_END_TAG_REQUIRED'],
    ['<div/>', 'HTML_PARSE_ERROR'],
    ['<p a="1" a="2">X</p>', 'HTML_PARSE_ERROR'],
    ['<p>X</bogus>', 'HTML_UNMATCHED_END_TAG'],
    ['<p>X</p>\r\n', 'HTML_LINE_ENDINGS'],
  ])('rejects %s with %s', (html, code) => {
    expect(errors(html)).toContain(code);
  });

  it('does not mistake escaped text, comments or script raw text for Document tags', () => {
    const html =
      '<p>&lt;body&gt;</p><!-- <head> --><script>const example="<html><body>";</script>';
    expect(errors(html)).toEqual([]);
  });

  it.each([
    '<ul><li>First<li>Second</ul>',
    '<dl><dt>Name<dd>Definition<dt>Another<dd>Last</dl>',
    '<p>Intro<div>Block</div>',
    '<ruby>字<rt>zi<rp>)</ruby>',
    '<select><optgroup label="A"><option>First<option>Second<optgroup label="B"><option>Third</select>',
    '<table><colgroup><col><tbody><tr><td>One<td>Two<tr><th>Three<th>Four</table>',
    '<table><thead><tr><th>Name<tbody><tr><td>Body<tfoot><tr><td>End</table>',
    '<svg viewBox="0 0 10 10"><path d="M0 0L10 10" /></svg>',
    '<math><mi>x</mi><mspace width="1em" /></math>',
  ])(
    'accepts real legal optional endings or foreign self closing: %s',
    (html) => {
      expect(errors(html)).toEqual([]);
    },
  );

  it.each([
    '<dl><dt>Last term</dl>',
    '<table><thead><tr><th>Only heading</table>',
    '<div><custom-element>Missing</div>',
    '<a><p>No paragraph closing</a>',
    '<svg><path d="M0 0"></svg>',
  ])(
    'requires a close where the optional-tag condition is not satisfied: %s',
    (html) => {
      expect(errors(html)).toContain('HTML_END_TAG_REQUIRED');
    },
  );

  it('reports jumps as warning and precise parser/heading source locations', () => {
    const result = analyzeHtml('<p>Intro</p>\n<h4>Skipped</h4>', {
      articleId: 'sample',
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'HTML_HEADING_LEVEL_JUMP',
        severity: 'warning',
        line: 2,
        column: 1,
        articleId: 'sample',
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'HTML_HEADING_ID_REQUIRED',
        severity: 'error',
        line: 2,
        column: 1,
      }),
    );
    expect(
      analyzeHtml('<p>Intro</p>\n<p a="1" a="2">Body</p>').diagnostics,
    ).toContainEqual(
      expect.objectContaining({ code: 'HTML_PARSE_ERROR', line: 2 }),
    );
    expect(
      analyzeHtml('<h2>Incomplete draft', { mode: 'draft' }).diagnostics.some(
        (item) => item.severity === 'error',
      ),
    ).toBe(true);
  });

  it('collects href locations and allows supported local/external schemes', () => {
    const hrefs = [
      '/notes/example/#part',
      '#開始',
      '#',
      '#%E9%96%8B%E5%A7%8B',
      '/articles/?q=hello&page=2',
      'https://example.com/path',
      'http://example.com/',
      'mailto:author@example.com',
      'tel:+886123456',
    ];
    const result = analyzeHtml(
      hrefs
        .map((href) => `<a href="${href.replaceAll('&', '&amp;')}">Link</a>`)
        .join('\n'),
    );
    expect(result.links.map((link) => link.href)).toEqual(hrefs);
    expect(result.links[1]).toMatchObject({ line: 2, column: 4 });
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    'next/',
    '../example/',
    '//evil.invalid/',
    'javascript:alert(1)',
    'data:text/html,hello',
    '/foo/../bar/',
    '/%2e%2e/bar/',
    '/%5cprivate/',
    '#%ZZ',
    'https://user:password@example.com/',
  ])('rejects ambiguous or unsafe href %s', (href) => {
    expect(errors(`<a href="${href}">Link</a>`)).toContain('HTML_LINK_INVALID');
  });

  it('collects image/video/source/srcset/poster paths once and requires explicit alt', () => {
    const html = `<picture><source srcset="${small} 480w, ${image} 1280w"><img src="${image}" alt=""></picture><video src="${video}" poster="${poster}"></video>`;
    const result = analyzeHtml(html);
    expect(result.mediaRefs).toEqual([small, image, video, poster]);
    expect(result.diagnostics).toEqual([]);
    expect(errors(`<img src="${image}">`)).toContain('MEDIA_ALT_REQUIRED');
    expect(
      errors('<img src="https://example.com/photo.webp" alt="remote">'),
    ).toContain('MEDIA_REFERENCE_INVALID');
  });

  it.each([
    `${small} 0w`,
    `${small} 480w, ${image} 480w`,
    `${small} 1x, ${image} 1280w`,
    `${small} 1x, ${image} 1.0x`,
    `${small} 480w,`,
  ])('rejects invalid srcset %s', (srcset) => {
    expect(errors(`<img src="${image}" alt="" srcset="${srcset}">`)).toContain(
      'MEDIA_SRCSET_INVALID',
    );
  });

  it('accepts valid numeric srcset spellings and rejects duplicate normalized widths', () => {
    expect(
      errors(
        `<img src="${image}" alt="" srcset="${small} 0480w, ${image} 1280w">`,
      ),
    ).toEqual([]);
    expect(
      errors(`<img src="${image}" alt="" srcset="${small} 1e0x, ${image} 2x">`),
    ).toEqual([]);
    expect(
      errors(
        `<img src="${image}" alt="" srcset="${small} 0480w, ${image} 480w">`,
      ),
    ).toContain('MEDIA_SRCSET_INVALID');
  });

  it('walks deeply nested valid markup without a recursive JavaScript stack', () => {
    const html =
      '<div>'.repeat(2000) + '<h2 id="deep">Deep</h2>' + '</div>'.repeat(2000);
    const result = analyzeHtml(html);
    expect(result.toc).toEqual([{ id: 'deep', text: 'Deep', level: 2 }]);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('MEDIA-01: source-offset media enhancement', () => {
  it('adds real dimensions and responsive candidates while preserving every existing byte', () => {
    const original = `<!-- unchanged -->\n<p  class='raw'>A &amp; B</p>\n<img  src='${image}' alt='A &quot;quote&quot;' data-x=" > ">\n<h2 id="開始">Keep</h2>`;
    const before = JSON.stringify(manifest);
    const result = enhanceHtmlMedia(original, manifest);
    expect(result.diagnostics).toEqual([]);
    expect(result.contentHtml).toContain(
      `width="1280" height="640" srcset="${small} 480w, ${image} 1280w, ${large} 1920w" sizes="(max-width: 1280px) 100vw, 1280px"`,
    );
    const insertion = result.contentHtml.slice(
      original.indexOf('>\n<h2'),
      result.contentHtml.indexOf('>\n<h2'),
    );
    expect(result.contentHtml.replace(insertion, '')).toBe(original);
    expect(result.mediaRefs).toEqual([image, small, large]);
    expect(JSON.stringify(manifest)).toBe(before);
    expect(enhanceHtmlMedia(result.contentHtml, manifest).contentHtml).toBe(
      result.contentHtml,
    );
  });

  it('preserves given attributes and derives only the missing proportional dimension', () => {
    const html = `<img src="${image}" alt="" width="400" srcset="${small} 480w" sizes="100vw" loading="lazy" />`;
    const result = enhanceHtmlMedia(html, manifest);
    expect(result.diagnostics).toEqual([]);
    expect(result.contentHtml).toBe(html.replace(' />', '  height="200"/>'));
    expect(
      enhanceHtmlMedia(`<img src="${image}" alt="" height="200">`, manifest)
        .contentHtml,
    ).toContain('width="400"');
  });

  it('validates dimensions, aspect ratio, missing outputs, MIME and true srcset widths', () => {
    const bad = enhanceHtmlMedia(
      `<img src="${image}" alt="" width="100%" height="30"><img src="${image}" alt="" width="800" height="100"><img src="${image}" alt="" srcset="${small} 500w"><img src="${video}" alt=""><img src="/media/${imageId}/image-999.webp" alt="">`,
      manifest,
    );
    expect(bad.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'MEDIA_DIMENSION_INVALID',
        'MEDIA_ASPECT_RATIO',
        'MEDIA_SRCSET_WIDTH',
        'MEDIA_TYPE_MISMATCH',
        'MEDIA_NOT_FOUND',
      ]),
    );
    expect(bad.contentHtml).toContain('width="100%" height="30"');
    expect(bad.contentHtml).toContain('width="800" height="100"');
  });

  it('supports picture sources and density candidates without replacing author srcset', () => {
    const html = `<picture><source type="image/webp" srcset="${small} 480w, ${image} 1280w"><img src="${small}" alt="" srcset="${small} 1x, ${image} 2x"></picture>`;
    const result = enhanceHtmlMedia(html, manifest);
    expect(result.diagnostics).toEqual([]);
    expect(result.contentHtml).toContain(`srcset="${small} 1x, ${image} 2x"`);
    expect(result.contentHtml).toContain('<source type="image/webp"');
  });

  it('adds video dimensions/poster, including a source child, and expands poster dependencies', () => {
    const result = enhanceHtmlMedia(
      `<video controls><source src="${video}" type="video/webm"></video>`,
      manifest,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.contentHtml).toBe(
      `<video controls width="1280" height="720" poster="${poster}"><source src="${video}" type="video/webm"></video>`,
    );
    expect(result.mediaRefs).toEqual([video, poster]);
    const custom = enhanceHtmlMedia(
      `<video src="${video}" poster="${image}"></video>`,
      manifest,
    );
    expect(custom.contentHtml).toContain(`poster="${image}"`);
    expect(custom.mediaRefs).toEqual([video, image, poster]);
  });

  it('rejects invalid contexts/types and never rewrites an invalid manifest', () => {
    const result = enhanceHtmlMedia(
      `<video src="${video}"><source src="${video}" type="image/webp"></video><source src="${image}">`,
      manifest,
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['MEDIA_TYPE_MISMATCH', 'MEDIA_SOURCE_CONTEXT']),
    );
    const html = `<img src="${image}" alt="">`;
    const firstAsset = manifest.assets[0];
    if (firstAsset === undefined)
      throw new Error('The fixture requires an image asset.');
    const invalid = enhanceHtmlMedia(html, {
      schemaVersion: 1,
      assets: [{ ...firstAsset, outputs: [] }],
    });
    expect(invalid.contentHtml).toBe(html);
    expect(invalid.diagnostics.map((item) => item.code)).toContain(
      'MEDIA_MANIFEST_INVALID',
    );
  });
});
