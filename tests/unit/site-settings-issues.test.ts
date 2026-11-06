import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../../studio/src/api.js';
import {
  siteSettingsFieldLabel,
  siteSettingsIssues,
} from '../../studio/src/site-settings-validation.js';

describe('Studio site settings validation display', () => {
  it.each([
    ['siteName', '網站名稱'],
    ['siteDescription', '網站描述'],
    ['siteUrl', '網站網址'],
    ['author.name', '作者名稱'],
    ['author.url', '作者網址'],
    ['language', '語言'],
    ['timeZone', '顯示時區'],
    ['defaultSEO.titleTemplate', 'SEO Title Template'],
    ['defaultSEO.description', 'Default Meta Description'],
    ['defaultSEO.index', 'Default Indexing'],
    ['social.twitterSite', 'Twitter / X Site'],
    ['social.defaultImage', 'Default Social Image'],
    ['googleSiteVerification', 'Google Search Console Verification'],
    ['pagination.category', '分類每頁篇數'],
    ['pagination.tag', 'Tag 每頁篇數'],
    ['pagination.articles', '文章總覽每頁篇數'],
    ['home.latestCount', '首頁最新文章篇數'],
    ['home.featuredArticleIds', '首頁精選文章'],
    ['rss.title', 'RSS 標題'],
    ['rss.description', 'RSS 描述'],
    ['rss.maxItems', 'RSS 最多篇數'],
    ['navigation', '導覽'],
  ])('uses the current field label for %s', (field, label) => {
    expect(siteSettingsFieldLabel(field.split('.'))).toBe(label);
  });

  it('labels array items without changing their numeric paths', () => {
    expect(siteSettingsFieldLabel(['navigation', 0, 'label'])).toBe(
      '導覽 1 名稱',
    );
    expect(siteSettingsFieldLabel(['navigation', 12, 'href'])).toBe(
      '導覽 13 連結',
    );
    expect(siteSettingsFieldLabel(['navigation', 2])).toBe('導覽 3');
    expect(siteSettingsFieldLabel(['home', 'featuredArticleIds', 2])).toBe(
      '首頁精選文章',
    );
    expect(siteSettingsFieldLabel(['navigation', -1, 'href'])).toBe('全站設定');
    expect(siteSettingsFieldLabel(['author.name'])).toBe('全站設定');
    expect(siteSettingsFieldLabel(['unknown'])).toBe('全站設定');
    expect(siteSettingsFieldLabel([])).toBe('全站設定');
  });

  it('combines duplicate site URL format errors into one actionable issue', () => {
    const issues = siteSettingsIssues({
      issues: [
        { path: ['siteUrl'], message: '必須為不含帳密的 HTTP(S) URL' },
        {
          path: ['siteUrl'],
          message: '網站網址必須為帶尾斜線、無子路徑或查詢的 origin',
        },
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: ['siteUrl'] });
    expect(issues[0]?.message).toContain('https://example.invalid/');
    expect(issues[0]?.message).toContain('子路徑、查詢參數、#片段或帳密');
  });

  it.each([
    [['author', 'url'], 'Invalid URL', '完整 HTTP(S) 網址'],
    [['language'], '語言必須為有效 BCP 47', 'zh-Hant'],
    [['timeZone'], '時區必須為有效 IANA 名稱', 'Asia/Taipei'],
    [
      ['social', 'twitterSite'],
      'Invalid string: must match pattern /^@[A-Za-z0-9_]{1,15}$/',
      '1–15個英文字母、數字或底線',
    ],
    [
      ['defaultSEO', 'titleTemplate'],
      '標題模板僅接受 {title} 與 {siteName} placeholder',
      '{title} 與 {siteName}',
    ],
    [['siteName'], '不可只含空白', '最多120個字元'],
    [
      ['author', 'name'],
      'Invalid input: expected string, received number',
      '作者名稱',
    ],
    [
      ['siteDescription'],
      'Too big: expected string to have <=300 characters',
      '最多300個字元',
    ],
    [['googleSiteVerification'], '不可只含空白', '最多512個字元'],
    [
      ['pagination', 'category'],
      'Too small: expected number to be >=1',
      '1–100的整數',
    ],
    [
      ['pagination', 'tag'],
      'Too big: expected number to be <=100',
      '1–100的整數',
    ],
    [
      ['pagination', 'articles'],
      'Invalid input: expected int, received number',
      '1–100的整數',
    ],
    [
      ['home', 'latestCount'],
      'Too big: expected number to be <=20',
      '1–20的整數',
    ],
    [
      ['rss', 'maxItems'],
      'Too big: expected number to be <=10000',
      '1–10000的整數',
    ],
    [
      ['navigation'],
      'Too big: expected array to have <=20 items',
      '最多20個項目',
    ],
    [['navigation', 3, 'label'], '不可只含空白', '最多80個字元'],
    [['social', 'defaultImage'], '必須引用受管圖片', '媒體庫'],
  ])('humanizes a known issue at %j', (path, message, expected) => {
    const issues = siteSettingsIssues({ issues: [{ path, message }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(path);
    expect(issues[0]?.message).toContain(expected);
  });

  it('flattens union branches and deduplicates their complete indexed path', () => {
    const issues = siteSettingsIssues({
      issues: [
        {
          code: 'invalid_union',
          path: ['navigation', 1, 'href'],
          message: 'Invalid input',
          errors: [
            [{ path: [], message: '頁面 URL 必須為有尾斜線的站內絕對路徑' }],
            [{ path: [], message: '必須為不含帳密的 HTTP(S) URL' }],
          ],
        },
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['navigation', 1, 'href']);
    expect(issues[0]?.message).toContain('站內連結需以 / 開頭及結尾');
    expect(siteSettingsFieldLabel(issues[0]?.path ?? [])).toBe('導覽 2 連結');
  });

  it('retains more specific API 422 business issues over generic format hints', () => {
    const business = '此導覽連結指向尚未建立的頁面，請先新增該頁面。';
    const error = new ApiFailure(
      422,
      'VALIDATION_ERROR',
      '網站設定無法保存。',
      [
        {
          path: ['navigation', 0, 'href'],
          code: 'invalid_union',
          message: 'Invalid input',
        },
        {
          path: ['navigation', 0, 'href'],
          code: 'NAVIGATION_TARGET_MISSING',
          message: business,
        },
        {
          path: ['social', 'defaultImage'],
          code: 'MEDIA_NOT_READY',
          message: '圖片尚未處理完成，請先處理媒體。',
        },
        {
          path: ['siteUrl'],
          code: 'SITE_URL_CONFLICT',
          message: '此網站網址與既有內容衝突。',
        },
      ],
    );
    expect(siteSettingsIssues(error)).toEqual([
      { path: ['navigation', 0, 'href'], message: business },
      {
        path: ['social', 'defaultImage'],
        message: '圖片尚未處理完成，請先處理媒體。',
      },
      { path: ['siteUrl'], message: '此網站網址與既有內容衝突。' },
    ]);
  });

  it('keeps unknown paths and nonstandard English business messages intact', () => {
    const issues = siteSettingsIssues({
      issues: [
        { path: ['unknown', 2], message: 'Invalid input' },
        {
          path: ['siteName'],
          message: 'The site name is reserved by another workspace.',
        },
        {
          path: ['siteUrl'],
          message: 'Invalid input: domain ownership must be confirmed',
        },
      ],
    });
    expect(issues).toEqual([
      { path: ['unknown', 2], message: 'Invalid input' },
      {
        path: ['siteName'],
        message: 'The site name is reserved by another workspace.',
      },
      {
        path: ['siteUrl'],
        message: 'Invalid input: domain ownership must be confirmed',
      },
    ]);
    expect(siteSettingsFieldLabel(issues[0]?.path ?? [])).toBe('全站設定');
  });

  it('preserves duplicate-article detail and stable order without mutating input', () => {
    const path = Object.freeze(['home', 'featuredArticleIds']);
    const first = Object.freeze({ path, message: 'Invalid input' });
    const second = Object.freeze({ path, message: '精選文章 ID 不可重複' });
    const error = Object.freeze({ issues: Object.freeze([first, second]) });
    expect(siteSettingsIssues(error)).toEqual([
      { path, message: '首頁精選文章不可重複，請移除重複選取。' },
    ]);
    expect(error.issues).toEqual([first, second]);
  });

  it.each([null, undefined, new Error('unrelated error'), {}, { issues: [] }])(
    'does not fabricate validation results for %j',
    (error) => expect(siteSettingsIssues(error)).toEqual([]),
  );
});
