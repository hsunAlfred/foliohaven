import { inputIssues } from './validation.js';
import type { InputIssue } from './validation.js';
import { SEO_PAGE_TYPES } from '@foliohaven/core';
import type { SeoPageType } from '@foliohaven/core';
import { seoPageTypeLabels } from './seo-defaults.js';

const labels: Readonly<Record<string, string>> = {
  siteName: '網站名稱',
  siteDescription: '網站描述',
  siteUrl: '網站網址',
  favicon: '主圖（Favicon）',
  icons: '網站圖示',
  'icons.enabled': '產生多尺寸圖示',
  'icons.appleTouch': 'Apple Touch 圖示',
  'icons.manifest': 'Web App Manifest',
  'icons.maskIcon': 'Safari pinned tab 圖示',
  'icons.maskColor': 'Safari 圖示色彩',
  'icons.themeLight': '淺色模式瀏覽器色彩',
  'icons.themeDark': '深色模式瀏覽器色彩',
  'icons.backgroundColor': '啟動畫面背景色',
  'icons.appName': 'App 名稱',
  'icons.shortName': 'App 短名稱',
  'icons.display': 'App 顯示模式',
  'author.name': '作者名稱',
  'author.url': '作者網址',
  language: '語言',
  timeZone: '顯示時區',
  'defaultSEO.titleTemplate': 'SEO Title Template',
  'defaultSEO.description': 'Default Meta Description',
  'defaultSEO.index': 'Default Indexing',
  pageSEO: '頁面類型 SEO 預設',
  'pageSEO.titleTemplate': '類型 Title Template',
  'pageSEO.descriptionSource': '類型描述設定',
  'pageSEO.description': '類型 Meta Description',
  'pageSEO.index': '類型索引設定',
  'pageSEO.imageSource': '類型分享圖片設定',
  'pageSEO.ogImage': '類型分享圖片',
  'social.twitterSite': 'Twitter / X Site',
  'social.defaultImage': 'Default Social Image',
  googleSiteVerification: 'Google Search Console Verification',
  'pagination.category': '分類每頁篇數',
  'pagination.tag': 'Tag 每頁篇數',
  'pagination.articles': '文章總覽每頁篇數',
  'home.latestCount': '首頁最新文章篇數',
  'home.featuredCaption': '精選文章小字',
  'home.featuredArticleIds': '首頁精選文章',
  'rss.title': 'RSS 標題',
  'rss.description': 'RSS 描述',
  'rss.maxItems': 'RSS 最多篇數',
  navigation: '導覽',
};

const messages = {
  siteName: '請填寫網站名稱，最多120個字元。',
  siteDescription: '網站描述最多300個字元，可留白。',
  siteUrl:
    '請填寫完整的 HTTP(S) 網站根網址，例如 https://example.invalid/；結尾需有 /，不可包含子路徑、查詢參數、#片段或帳密，最多2048個字元。',
  favicon: '請從媒體庫選擇網站圖示；清除選擇時使用瀏覽器預設圖示。',
  icons: '請檢查網站圖示設定。',
  'icons.enabled': '請選擇是否產生多尺寸圖示。',
  'icons.appleTouch': '請選擇是否提供 Apple Touch 圖示。',
  'icons.manifest': '請選擇是否提供 Web App Manifest。',
  'icons.maskIcon': '請從媒體庫選擇 SVG 圖形；留空時依主圖自動選用。',
  'icons.maskColor': 'Safari 圖示色彩需使用六位 HEX 色碼，例如 #404040。',
  'icons.themeLight': '淺色模式瀏覽器色彩需使用六位 HEX 色碼，例如 #ffffff。',
  'icons.themeDark': '深色模式瀏覽器色彩需使用六位 HEX 色碼，例如 #262626。',
  'icons.backgroundColor': '啟動畫面背景色需使用六位 HEX 色碼，例如 #ffffff。',
  'icons.appName': 'App 名稱可留白；填寫時最多120個字元，留白時使用網站名稱。',
  'icons.shortName':
    'App 短名稱可留白；填寫時最多40個字元，留白時使用網站名稱。',
  'icons.display': '請選擇獨立視窗、精簡瀏覽器介面或一般瀏覽器。',
  'author.name': '請填寫作者名稱，最多120個字元。',
  'author.url':
    '作者網址可留白；填寫時請使用不含帳密的完整 HTTP(S) 網址，最多2048個字元。',
  language: '請填寫有效的語言代碼，例如 zh-Hant，最多100個字元。',
  timeZone: '請填寫有效的時區名稱，例如 Asia/Taipei，最多100個字元。',
  'defaultSEO.titleTemplate':
    '請填寫1–500個字元的標題模板；變數只能使用 {title} 與 {siteName}。',
  'defaultSEO.description': '請填寫全域 SEO 描述，最多300個字元。',
  'defaultSEO.index': '請選擇是否允許搜尋引擎索引。',
  pageSEO: '請檢查頁面類型的 SEO 預設設定。',
  'pageSEO.titleTemplate':
    '請填寫1–500個字元的標題模板；變數只能使用 {title} 與 {siteName}，繼承時請選擇「繼承全域 Title Template」。',
  'pageSEO.descriptionSource': '請選擇繼承、自訂或此類型可使用的內容來源。',
  'pageSEO.description': '請填寫此類型的 Meta Description，最多300個字元。',
  'pageSEO.index': '請選擇繼承、允許索引或不允許索引。',
  'pageSEO.imageSource': '請選擇此類型可使用的分享圖片來源。',
  'pageSEO.ogImage': '請從媒體庫選擇分享圖片；不指定圖片時可改為繼承或不使用。',
  'social.twitterSite':
    'X 帳號需以 @ 開頭，後接1–15個英文字母、數字或底線；不設定時可留白。',
  'social.defaultImage': '請從媒體庫選擇圖片；不使用預設分享圖時可清除選擇。',
  googleSiteVerification:
    '驗證碼最多512個字元，且不可只含空白；不設定時可留白。',
  'pagination.category': '分類每頁篇數需為1–100的整數。',
  'pagination.tag': 'Tag 每頁篇數需為1–100的整數。',
  'pagination.articles': '文章總覽每頁篇數需為1–100的整數。',
  'home.latestCount': '首頁最新文章篇數需為1–20的整數。',
  'home.featuredCaption': '精選文章小字最多120個字元，可留白。',
  'home.featuredArticleIds':
    '請從文章選單選擇首頁精選文章，最多20篇，且不可重複。',
  'rss.title': '請填寫 RSS 標題，最多120個字元。',
  'rss.description': 'RSS 描述最多300個字元，可留白。',
  'rss.maxItems': 'RSS 最多篇數需為1–10000的整數。',
  navigation: '導覽最多20個項目。',
  'navigation.item': '請檢查這個導覽項目的名稱與連結。',
  'navigation.label': '請填寫導覽名稱，最多80個字元。',
  'navigation.href':
    '站內連結需以 / 開頭及結尾，不含查詢參數或#片段；外部連結需為不含帳密的完整 HTTP(S) 網址，最多2048個字元。',
} as const;

const schemaFormatMessages = new Set([
  '不可只含空白',
  '必須為不含帳密的 HTTP(S) URL',
  '網站網址必須為帶尾斜線、無子路徑或查詢的 origin',
  '語言必須為有效 BCP 47',
  '時區必須為有效 IANA 名稱',
  '標題模板僅接受 {title} 與 {siteName} placeholder',
  '頁面 URL 必須為有尾斜線的站內絕對路徑',
  '必須引用受管圖片',
  'Safari 圖示必須使用受管 SVG',
  '請使用六位 HEX 色碼，例如 #404040',
]);

const genericZodMessage =
  /^(?:Invalid input(?:: expected .+, received .+)?$|Invalid URL$|Invalid string: must match pattern |Invalid option: expected |Too (?:small|big): expected |Unrecognized keys?: |Expected .+, received .+$|Required$|String must contain at (?:least|most) |Number must be (?:greater|less) than )/u;

function navigationIndex(path: readonly (string | number)[]): number | null {
  const index = path[1];
  return path[0] === 'navigation' &&
    typeof index === 'number' &&
    Number.isSafeInteger(index) &&
    index >= 0
    ? index
    : null;
}

function fieldKey(
  path: readonly (string | number)[],
): keyof typeof messages | null {
  if (path[0] === 'pageSEO') {
    if (path.length === 1) return 'pageSEO';
    if (!SEO_PAGE_TYPES.some((type) => type === path[1])) return null;
    if (path.length === 2) return 'pageSEO';
    if (path.length === 3 && typeof path[2] === 'string') {
      const key = `pageSEO.${path[2]}`;
      return Object.hasOwn(messages, key)
        ? (key as keyof typeof messages)
        : null;
    }
    return null;
  }
  if (navigationIndex(path) !== null) {
    if (path.length === 2) return 'navigation.item';
    if (path.length === 3 && path[2] === 'label') return 'navigation.label';
    if (path.length === 3 && path[2] === 'href') return 'navigation.href';
    return null;
  }
  if (
    path.length === 3 &&
    path[0] === 'home' &&
    path[1] === 'featuredArticleIds' &&
    typeof path[2] === 'number' &&
    Number.isSafeInteger(path[2]) &&
    path[2] >= 0
  )
    return 'home.featuredArticleIds';
  if (path.some((part) => typeof part !== 'string' || part.includes('.')))
    return null;
  const key = path.join('.');
  return Object.hasOwn(messages, key) ? (key as keyof typeof messages) : null;
}

export function siteSettingsFieldLabel(
  path: readonly (string | number)[],
): string {
  if (
    path[0] === 'pageSEO' &&
    SEO_PAGE_TYPES.some((type) => type === path[1])
  ) {
    const key = fieldKey(path);
    return `${seoPageTypeLabels[path[1] as SeoPageType]} · ${(key && labels[key]) || 'SEO 預設'}`;
  }
  const index = navigationIndex(path);
  if (index !== null) {
    if (path.length === 2) return `導覽 ${index + 1}`;
    if (path.length === 3 && path[2] === 'label')
      return `導覽 ${index + 1} 名稱`;
    if (path.length === 3 && path[2] === 'href')
      return `導覽 ${index + 1} 連結`;
  }
  const key = fieldKey(path);
  return (key && labels[key]) || '全站設定';
}

/** Formats existing validation results; schema and API remain the validators. */
export function siteSettingsIssues(error: unknown): readonly InputIssue[] {
  const unique = new Map<string, { issue: InputIssue; priority: number }>();
  for (const issue of inputIssues(error)) {
    const key = fieldKey(issue.path);
    const duplicateFeatured =
      key === 'home.featuredArticleIds' &&
      issue.message === '精選文章 ID 不可重複';
    const generic =
      key !== null &&
      (genericZodMessage.test(issue.message) ||
        schemaFormatMessages.has(issue.message));
    const formatted = {
      path: issue.path,
      message: duplicateFeatured
        ? '首頁精選文章不可重複，請移除重複選取。'
        : generic && key !== null
          ? messages[key]
          : issue.message,
    };
    const priority = generic ? 1 : 2;
    const pathKey = JSON.stringify(issue.path);
    const previous = unique.get(pathKey);
    if (!previous || priority > previous.priority)
      unique.set(pathKey, { issue: formatted, priority });
  }
  return [...unique.values()].map(({ issue }) => issue);
}
