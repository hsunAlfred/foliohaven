import { z } from 'zod';
import {
  ArticleIdSchema,
  CategoryPathSchema,
  DateTimeSchema,
  HtmlContentSchema,
  HttpUrlSchema,
  LanguageSchema,
  ManagedImagePathSchema,
  NonBlankStringSchema,
  RootPathSchema,
  SiteUrlSchema,
  SlugSchema,
  TimeZoneSchema,
  uniqueStrings,
  ManagedMediaPathSchema,
  RelativeResourceSchema,
  CONTENT_LIMITS,
  utf8ByteLength,
} from './common.js';

const title = NonBlankStringSchema.max(200);
const description = NonBlankStringSchema.max(300);
export const SeoTitleTemplateSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => {
    const remainder = value
      .replaceAll('{title}', '')
      .replaceAll('{siteName}', '');
    return !/[{}]/u.test(remainder);
  }, '標題模板僅接受 {title} 與 {siteName} placeholder');
export const SEO_PAGE_TYPES = [
  'home',
  'article',
  'articles',
  'categoryIndex',
  'category',
  'tagIndex',
  'tag',
  'notFound',
] as const;
export const SeoPageTypeSchema = z.enum(SEO_PAGE_TYPES);
export const PageSeoSettingsSchema = z
  .strictObject({
    titleTemplate: SeoTitleTemplateSchema.nullable().default(null),
    descriptionSource: z
      .enum(['inherit', 'custom', 'content'])
      .default('inherit'),
    description: description.nullable().default(null),
    index: z.boolean().nullable().default(null),
    imageSource: z
      .enum(['inherit', 'custom', 'none', 'featured'])
      .default('inherit'),
    ogImage: ManagedImagePathSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.descriptionSource === 'custom' && value.description === null)
      ctx.addIssue({
        code: 'custom',
        path: ['description'],
        message: '自訂描述時請填寫描述。',
      });
    if (value.imageSource === 'custom' && value.ogImage === null)
      ctx.addIssue({
        code: 'custom',
        path: ['ogImage'],
        message: '指定分享圖片時請選擇圖片。',
      });
  });
export const PageSeoDefaultsSchema = z
  .strictObject({
    home: PageSeoSettingsSchema.prefault({ titleTemplate: '{siteName}' }),
    article: PageSeoSettingsSchema.prefault({
      descriptionSource: 'content',
      imageSource: 'featured',
    }),
    articles: PageSeoSettingsSchema.prefault({
      titleTemplate: '{title}',
      descriptionSource: 'custom',
      description: '瀏覽與搜尋本站的已發布文章。',
    }),
    categoryIndex: PageSeoSettingsSchema.prefault({
      titleTemplate: '{title}',
      descriptionSource: 'custom',
      description: '依分類瀏覽本站文章，尋找感興趣的內容。',
    }),
    category: PageSeoSettingsSchema.prefault({ descriptionSource: 'content' }),
    tagIndex: PageSeoSettingsSchema.prefault({
      titleTemplate: '{title}',
      descriptionSource: 'custom',
      description: '依 Tag 瀏覽文章主題，尋找相關內容。',
    }),
    tag: PageSeoSettingsSchema.prefault({ descriptionSource: 'content' }),
    notFound: PageSeoSettingsSchema.prefault({
      descriptionSource: 'custom',
      description: '此頁面不存在。',
      index: false,
    }),
  })
  .superRefine((value, ctx) => {
    for (const type of SEO_PAGE_TYPES) {
      if (
        value[type].descriptionSource === 'content' &&
        !['home', 'article', 'category', 'tag'].includes(type)
      )
        ctx.addIssue({
          code: 'custom',
          path: [type, 'descriptionSource'],
          message: '只有首頁、文章、分類與 Tag 可以使用內容描述。',
        });
      if (value[type].imageSource === 'featured' && type !== 'article')
        ctx.addIssue({
          code: 'custom',
          path: [type, 'imageSource'],
          message: '只有文章可以使用文章精選圖片。',
        });
    }
  });
export const SeoOverrideSchema = z
  .strictObject({
    title: title.nullable().default(null),
    description: description.nullable().default(null),
    index: z.boolean().nullable().default(null),
    ogImage: ManagedImagePathSchema.nullable().default(null),
    imageSource: z.enum(['inherit', 'custom', 'none']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.imageSource === 'custom' && value.ogImage === null)
      ctx.addIssue({
        code: 'custom',
        path: ['ogImage'],
        message: '指定分享圖片時請選擇圖片。',
      });
  });
const seo = SeoOverrideSchema.prefault({});
const draftShape = {
  status: z.literal('draft'),
  title: z.string().max(200).default(''),
  excerpt: z.string().trim().max(300).default(''),
  relatedReading: z
    .strictObject({
      title: NonBlankStringSchema.max(200).default('延伸閱讀'),
      articleIds: z
        .array(ArticleIdSchema)
        .max(20)
        .refine(uniqueStrings, '延伸閱讀文章不可重複')
        .default([]),
    })
    .prefault({}),
  slug: z.string().max(80).default(''),
  category: z.string().max(512).nullable().default(null),
  tags: z
    .array(z.string().max(80))
    .max(20)
    .refine(uniqueStrings, 'Tag 不可重複')
    .default([]),
  publishedAt: DateTimeSchema.nullable().default(null),
  updatedAt: DateTimeSchema.nullable().default(null),
  featuredImage: ManagedImagePathSchema.nullable().default(null),
  featuredImageAlt: z.string().max(300).default(''),
  seo,
};
export const DraftArticleMetaSchema = z.strictObject(draftShape);
export const PublishedArticleMetaSchema = z
  .strictObject({
    ...draftShape,
    status: z.literal('published'),
    title: z.string().trim().min(1).max(200),
    slug: SlugSchema,
    category: CategoryPathSchema,
    tags: z
      .array(SlugSchema)
      .max(20)
      .refine(uniqueStrings, 'Tag 不可重複')
      .default([]),
    publishedAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    // With an image, the author must explicitly supply an alt (an empty alt is valid).
    featuredImageAlt: z.string().max(300).optional(),
    seo,
  })
  .superRefine((value, ctx) => {
    if (Date.parse(value.updatedAt) < Date.parse(value.publishedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: '更新時間不得早於發布時間',
      });
    }
    if (value.featuredImage !== null && value.featuredImageAlt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['featuredImageAlt'],
        message: '有精選圖時必須明確提供 alt，可用空字串表示裝飾',
      });
    }
  })
  .transform((value) => ({
    ...value,
    featuredImageAlt: value.featuredImageAlt ?? '',
  }));
export const ArticleMetaSchema = z.union([
  DraftArticleMetaSchema,
  PublishedArticleMetaSchema,
]);
export const ArticleWriteSchema = z
  .strictObject({ contentHtml: HtmlContentSchema, meta: ArticleMetaSchema })
  .superRefine((value, ctx) => {
    if (
      utf8ByteLength(JSON.stringify(value.meta)) >
      CONTENT_LIMITS.articleMetaBytes
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['meta'],
        message: '文章屬性超過 64 KiB',
      });
    }
  });
export const CategorySchema = z.strictObject({
  path: CategoryPathSchema,
  name: NonBlankStringSchema.max(120),
  description,
  seo,
});
export const TagSchema = z.strictObject({
  slug: SlugSchema,
  name: NonBlankStringSchema.max(120),
  description,
  seo,
});
export const CategoriesSchema = z
  .array(CategorySchema)
  .superRefine((categories, ctx) => {
    const paths = new Set<string>();
    for (const [index, item] of categories.entries()) {
      if (paths.has(item.path))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'path'],
          message: '分類 path 不可重複',
        });
      paths.add(item.path);
    }
    for (const [index, item] of categories.entries()) {
      const parent = item.path.slice(0, item.path.lastIndexOf('/'));
      if (item.path.includes('/') && !paths.has(parent))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'path'],
          message: '每一個父分類都必須明確存在',
        });
    }
  });
export const TagsSchema = z.array(TagSchema).superRefine((tags, ctx) => {
  const seen = new Set<string>();
  for (const [index, item] of tags.entries()) {
    if (seen.has(item.slug))
      ctx.addIssue({
        code: 'custom',
        path: [index, 'slug'],
        message: 'Tag slug 不可重複',
      });
    seen.add(item.slug);
  }
});
export const TaxonomySchema = z.strictObject({
  categories: CategoriesSchema,
  tags: TagsSchema,
});
export const NavigationItemSchema = z.strictObject({
  label: NonBlankStringSchema.max(80),
  href: z.union([RootPathSchema, HttpUrlSchema]),
});
const titleTemplate = SeoTitleTemplateSchema.default('{title} | {siteName}');
const iconColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, '請使用六位 HEX 色碼，例如 #404040');
export const SiteIconsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  appleTouch: z.boolean().default(true),
  manifest: z.boolean().default(true),
  maskIcon: ManagedImagePathSchema.refine(
    (value) => value.endsWith('.svg'),
    'Safari 圖示必須使用受管 SVG',
  )
    .nullable()
    .default(null),
  maskColor: iconColor.default('#404040'),
  themeLight: iconColor.default('#ffffff'),
  themeDark: iconColor.default('#262626'),
  backgroundColor: iconColor.default('#ffffff'),
  appName: NonBlankStringSchema.max(120).nullable().default(null),
  shortName: NonBlankStringSchema.max(40).nullable().default(null),
  display: z
    .enum(['standalone', 'minimal-ui', 'browser'])
    .default('standalone'),
});
const siteBase = z.strictObject({
  siteName: NonBlankStringSchema.max(120),
  siteDescription: description,
  favicon: ManagedImagePathSchema.nullable().default(null),
  icons: SiteIconsSchema.prefault({}),
  siteUrl: SiteUrlSchema,
  language: LanguageSchema.default('zh-Hant'),
  timeZone: TimeZoneSchema.default('Asia/Taipei'),
  author: z.strictObject({
    name: NonBlankStringSchema.max(120),
    url: HttpUrlSchema.nullable().default(null),
  }),
  navigation: z.array(NavigationItemSchema).max(20).default([]),
  defaultSEO: z
    .strictObject({
      titleTemplate,
      description: description.optional(),
      index: z.boolean().default(true),
    })
    .prefault({}),
  pageSEO: PageSeoDefaultsSchema.prefault({}),
  pagination: z
    .strictObject({
      category: z.number().int().min(1).max(100).default(10),
      tag: z.number().int().min(1).max(100).default(10),
      articles: z.number().int().min(1).max(100).default(10),
    })
    .prefault({}),
  home: z
    .strictObject({
      featuredCaption: z.string().max(120).default('精選文章'),
      featuredArticleIds: z
        .array(ArticleIdSchema)
        .max(20)
        .refine(uniqueStrings, '精選文章 ID 不可重複')
        .default([]),
      latestCount: z.number().int().min(1).max(20).default(5),
    })
    .prefault({}),
  rss: z
    .strictObject({
      title: NonBlankStringSchema.max(120).optional(),
      description: description.optional(),
      maxItems: z.number().int().min(1).max(10_000).default(100),
    })
    .prefault({}),
  social: z
    .strictObject({
      defaultImage: ManagedImagePathSchema.nullable().default(null),
      twitterSite: z
        .string()
        .regex(/^@[A-Za-z0-9_]{1,15}$/)
        .nullable()
        .default(null),
    })
    .prefault({}),
  googleSiteVerification: NonBlankStringSchema.max(512)
    .nullable()
    .default(null),
});
export const SiteConfigSchema = siteBase.transform((value) => ({
  ...value,
  defaultSEO: {
    ...value.defaultSEO,
    description: value.defaultSEO.description ?? value.siteDescription,
  },
  rss: {
    ...value.rss,
    title: value.rss.title ?? value.siteName,
    description: value.rss.description ?? value.siteDescription,
  },
}));
export const FixedPageSchema = z.strictObject({
  id: ArticleIdSchema,
  path: RootPathSchema,
  entry: RelativeResourceSchema.refine(
    (value) => value.endsWith('.astro'),
    '固定入口必須為 Astro 檔案',
  ),
  seo,
  mediaRefs: z
    .array(ManagedMediaPathSchema)
    .refine(uniqueStrings, '媒體引用不可重複')
    .default([]),
});
