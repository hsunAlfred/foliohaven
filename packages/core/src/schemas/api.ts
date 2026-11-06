import { z } from 'zod';
import {
  ArticleIdSchema,
  CategoryPathSchema,
  DateTimeSchema,
  ManagedImagePathSchema,
  PageSchema,
  PageSizeSchema,
  RelativeResourceSchema,
  RevisionSchema,
  RootPathSchema,
  SlugSchema,
  UtcDateTimeSchema,
  UuidSchema,
  NonBlankStringSchema,
  HtmlContentSchema,
} from './common.js';
import { ArticleMetaSchema } from './content.js';
import { MediaAssetSchema } from './media.js';

export const DiagnosticSchema = z.strictObject({
  severity: z.enum(['error', 'warning']),
  code: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  message: NonBlankStringSchema.max(2000),
  resource: RelativeResourceSchema.optional(),
  field: z.string().min(1).max(512).optional(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  articleId: ArticleIdSchema.optional(),
});
export const ApiIssueSchema = z.strictObject({
  path: z
    .array(z.union([z.string().max(512), z.number().int().min(0)]))
    .max(50),
  code: z.string().min(1).max(100),
  message: NonBlankStringSchema.max(2000),
});
export const SafeErrorSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  message: NonBlankStringSchema.max(2000),
  retryable: z.boolean(),
  issues: z.array(ApiIssueSchema).default([]),
});
export const ApiErrorSchema = z.strictObject({
  error: SafeErrorSchema.extend({ requestId: UuidSchema }),
});
export const ArticleResourceSchema = z.strictObject({
  id: ArticleIdSchema,
  contentHtml: HtmlContentSchema,
  meta: ArticleMetaSchema,
  diagnostics: z.array(DiagnosticSchema),
});
export const PublicationUpdateSchema = z
  .strictObject({
    status: z.enum(['draft', 'published']),
    publishedAt: DateTimeSchema.nullable(),
    updatedAt: DateTimeSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.status === 'published' &&
      (value.publishedAt === null || value.updatedAt === null)
    )
      ctx.addIssue({ code: 'custom', message: '發布時必須提供發布與更新日期' });
    if (
      value.publishedAt !== null &&
      value.updatedAt !== null &&
      Date.parse(value.updatedAt) < Date.parse(value.publishedAt)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: '更新時間不得早於發布時間',
      });
  });
export const EditModeUpdateSchema = z.strictObject({
  mode: z.enum(['studio', 'ide']),
});
export const WorkspaceSchema = z.strictObject({
  revision: RevisionSchema,
  editMode: z.enum(['studio', 'ide']),
  recoveryState: z.enum(['ready', 'recovery-required']),
  diagnostics: z.array(DiagnosticSchema),
  limits: z.strictObject({
    articleMetaBytes: z.number().int().positive(),
    articleHtmlBytes: z.number().int().positive(),
    siteBytes: z.number().int().positive(),
    pageBytes: z.number().int().positive(),
    mediaMetaBytes: z.number().int().positive(),
    taxonomyBytes: z.number().int().positive(),
    articleCount: z.number().int().positive(),
    publishedHtmlBytes: z.number().int().positive(),
    loaderConcurrency: z.number().int().positive(),
    imageSourceBytes: z.number().int().positive(),
    videoSourceBytes: z.number().int().positive(),
  }),
});
const queryInteger = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(PageSchema);
const queryPageSize = queryInteger.pipe(PageSizeSchema);
const paginationQuery = {
  page: queryInteger.prefault('1'),
  pageSize: queryPageSize.prefault('20'),
};
export const ArticleListQuerySchema = z.strictObject({
  ...paginationQuery,
  status: z.enum(['draft', 'published']).optional(),
  category: CategoryPathSchema.optional(),
  tag: SlugSchema.optional(),
  q: z.string().max(200).default(''),
  sort: z
    .enum([
      'published-desc',
      'published-asc',
      'updated-desc',
      'title-asc',
      'id-asc',
    ])
    .default('published-desc'),
});
export const ArticleOptionsQuerySchema = ArticleListQuerySchema.extend({
  selected: z
    .string()
    .max(1620)
    .default('')
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(ArticleIdSchema).max(20)),
});
export const ArticleOptionSchema = z.strictObject({
  id: ArticleIdSchema,
  title: z.string().max(200),
  status: z.enum(['draft', 'published']),
});
export const ArticleOptionsSchema = z.strictObject({
  items: z.array(ArticleOptionSchema),
  selected: z.array(ArticleOptionSchema),
  total: z.number().int().min(0),
  page: PageSchema,
  pageSize: PageSizeSchema,
});
export const MediaListQuerySchema = z.strictObject({
  ...paginationQuery,
  type: z.enum(['image', 'video']).optional(),
  format: z.enum(['svg', 'ico']).optional(),
  q: z.string().max(200).default(''),
});
export const JobListQuerySchema = z.strictObject({
  ...paginationQuery,
  type: z.enum(['media', 'build', 'taxonomy']).optional(),
  status: z
    .enum([
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'interrupted',
    ])
    .optional(),
});
export const PreviewRequestSchema = z.strictObject({
  articleId: ArticleIdSchema.optional(),
  contentHtml: HtmlContentSchema,
  meta: ArticleMetaSchema,
});
export const PreviewResponseSchema = z.strictObject({
  id: UuidSchema,
  documentUrl: z.string().regex(/^\/api\/v1\/previews\/[0-9a-f-]+\/document$/),
  expiresAt: UtcDateTimeSchema,
  diagnostics: z.array(DiagnosticSchema),
});
export const TaxonomyMigrationRequestSchema = z
  .strictObject({
    kind: z.enum(['category', 'tag']),
    from: z.string().min(1).max(512),
    to: z.string().min(1).max(512),
    workspaceRevision: RevisionSchema,
    confirmed: z.boolean(),
    planId: UuidSchema.optional(),
    retryOf: UuidSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const pathSchema =
      value.kind === 'category' ? CategoryPathSchema : SlugSchema;
    for (const field of ['from', 'to'] as const)
      if (!pathSchema.safeParse(value[field]).success)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: '分類 path 或 Tag slug 不合法',
        });
    if (value.from === value.to)
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: '新舊識別不可相同',
      });
    if (value.confirmed && value.planId === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['planId'],
        message: '提交 migration 必須附已確認的 planId',
      });
    if (
      !value.confirmed &&
      (value.planId !== undefined || value.retryOf !== undefined)
    )
      ctx.addIssue({
        code: 'custom',
        message: '影響預覽不可附提交或重試工作識別',
      });
  });
export const ChangedUrlSchema = z.strictObject({
  articleId: ArticleIdSchema,
  from: RootPathSchema,
  to: RootPathSchema,
});
export const TaxonomyMigrationPlanSchema = z.strictObject({
  planId: UuidSchema,
  kind: z.enum(['category', 'tag']),
  from: z.string().min(1).max(512),
  to: z.string().min(1).max(512),
  workspaceRevision: RevisionSchema,
  expiresAt: UtcDateTimeSchema,
  affectedArticleIds: z.array(ArticleIdSchema),
  affectedCategoryPaths: z.array(CategoryPathSchema),
  navigationReferences: z.array(z.number().int().min(0).max(19)),
  changedUrls: z.array(ChangedUrlSchema),
});
export const MediaJobRequestSchema = z.strictObject({
  sourceId: UuidSchema,
  preset: z.enum(['article-image', 'article-video', 'site-icons']),
  retryOf: UuidSchema.optional(),
});
export const BuildJobRequestSchema = z.strictObject({
  retryOf: UuidSchema.optional(),
});
export const JobRetryInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('build') }),
  z.strictObject({
    type: z.literal('media'),
    sourceId: UuidSchema,
    preset: z.enum(['article-image', 'article-video', 'site-icons']),
  }),
  z.strictObject({
    type: z.literal('taxonomy'),
    kind: z.enum(['category', 'tag']),
    from: z.string().min(1).max(512),
    to: z.string().min(1).max(512),
  }),
]);
export const CancellationRequestSchema = z.strictObject({
  requested: z.literal(true),
});
export const BuildResultSchema = z.strictObject({
  outputDirectory: z.literal('dist'),
  snapshotRevision: RevisionSchema,
  routeCount: z.number().int().min(0),
  fileCount: z.number().int().min(0),
  warnings: z.array(DiagnosticSchema),
});
/** 目前實際 dist 的來源證據；歷史成功 Job 不能代替此資源。 */
export const CurrentArtifactSchema = z.strictObject({
  recoveryState: z.enum(['ready', 'recovery-required']),
  current: z
    .strictObject({
      digest: RevisionSchema,
      build: z
        .strictObject({
          jobId: UuidSchema,
          committedAt: UtcDateTimeSchema,
          result: BuildResultSchema,
        })
        .nullable(),
    })
    .nullable(),
});
export const MediaResultSchema = z.strictObject({
  sourceId: UuidSchema,
  asset: MediaAssetSchema,
});
export const TaxonomyResultSchema = z.strictObject({
  kind: z.enum(['category', 'tag']),
  from: z.string().min(1).max(512),
  to: z.string().min(1).max(512),
  affectedArticleIds: z.array(ArticleIdSchema),
  changedUrls: z.array(ChangedUrlSchema),
});
const jobBase = {
  id: UuidSchema,
  status: z.enum([
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  stage: NonBlankStringSchema.max(120),
  progress: z
    .strictObject({
      completed: z.number().int().min(0),
      total: z.number().int().min(0).nullable(),
    })
    .refine(
      (value) => value.total === null || value.completed <= value.total,
      '完成數不得大於總數',
    ),
  createdAt: UtcDateTimeSchema,
  startedAt: UtcDateTimeSchema.nullable(),
  finishedAt: UtcDateTimeSchema.nullable(),
  snapshotRevision: RevisionSchema.nullable(),
  error: SafeErrorSchema.nullable(),
};
export const JobSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...jobBase,
      type: z.literal('build'),
      result: BuildResultSchema.nullable(),
    }),
    z.strictObject({
      ...jobBase,
      type: z.literal('media'),
      result: MediaResultSchema.nullable(),
    }),
    z.strictObject({
      ...jobBase,
      type: z.literal('taxonomy'),
      result: TaxonomyResultSchema.nullable(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      value.status === 'succeeded' &&
      (value.result === null ||
        value.error !== null ||
        value.startedAt === null)
    )
      ctx.addIssue({
        code: 'custom',
        message: '成功工作必須有開始時間與結果且沒有錯誤',
      });
    if (value.status !== 'succeeded' && value.result !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['result'],
        message: '只有成功工作可有結果',
      });
    if (
      (value.status === 'failed' || value.status === 'interrupted') &&
      value.error === null
    )
      ctx.addIssue({
        code: 'custom',
        path: ['error'],
        message: '失敗或中斷工作必須有安全錯誤',
      });
    const active = value.status === 'queued' || value.status === 'running';
    if (active !== (value.finishedAt === null))
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: '終止狀態必須有完成時間，執行中不得填完成時間',
      });
    if (
      (value.status === 'queued' && value.startedAt !== null) ||
      (value.status === 'running' && value.startedAt === null)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: '開始時間與工作狀態不符',
      });
    if (
      (value.startedAt !== null &&
        Date.parse(value.startedAt) < Date.parse(value.createdAt)) ||
      (value.finishedAt !== null &&
        Date.parse(value.finishedAt) <
          Date.parse(value.startedAt ?? value.createdAt))
    )
      ctx.addIssue({ code: 'custom', message: '工作時間順序不正確' });
  });
export const OperationSchema = z.strictObject({
  id: UuidSchema,
  status: z.enum(['reserved', 'committed', 'failed']),
  resourceUrl: z
    .string()
    .regex(/^\/api\/v1\/[a-z0-9/-]+$/)
    .nullable(),
  jobUrl: z
    .string()
    .regex(/^\/api\/v1\/jobs\/[a-f0-9-]+$/)
    .nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  error: SafeErrorSchema.nullable(),
});
export const RecoveryChoiceSchema = z.enum([
  'keep-current',
  'restore-backup',
  'apply-prepared',
  'restore-trash',
  'purge-trash',
]);
export const RecoveryRevisionSchema = z.strictObject({
  resourceKey: RelativeResourceSchema,
  revision: RevisionSchema.nullable(),
});
export const RecoveryResolutionSchema = z
  .strictObject({
    choice: RecoveryChoiceSchema,
    revisions: z.array(RecoveryRevisionSchema).min(1),
  })
  .refine(
    (value) =>
      new Set(value.revisions.map((revision) => revision.resourceKey)).size ===
      value.revisions.length,
    '復原資源不可重複',
  );
export const RecoveryFileSchema = z.strictObject({
  fileId: UuidSchema,
  mimeType: z.enum([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/svg+xml',
    'image/x-icon',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'application/octet-stream',
  ]),
  byteSize: z.number().int().min(0),
  sha256: RevisionSchema,
  downloadUrl: z
    .string()
    .regex(/^\/api\/v1\/recoveries\/[a-f0-9-]+\/files\/[a-f0-9-]+$/),
});
export const RecoveryVersionSchema = z
  .strictObject({
    revision: RevisionSchema.nullable(),
    text: z.string().nullable(),
    binary: RecoveryFileSchema.nullable(),
  })
  .refine(
    (value) => !(value.text !== null && value.binary !== null),
    '同一版本不可同時含文字與二進位資料',
  );
export const RecoveryResourceSchema = z.strictObject({
  resourceKey: RelativeResourceSchema,
  base: RecoveryVersionSchema,
  current: RecoveryVersionSchema,
  prepared: RecoveryVersionSchema,
  /** 競態中另行保留的版本；可能超過通常的三個比較版本。 */
  preserved: z.array(RecoveryVersionSchema).default([]),
});
export const RecoveryDetailSchema = z.strictObject({
  id: UuidSchema,
  kind: z.enum(['transaction', 'build', 'trash']),
  status: z.enum(['pending', 'available', 'resolved']),
  createdAt: UtcDateTimeSchema,
  resources: z.array(RecoveryResourceSchema).min(1),
  choices: z.array(RecoveryChoiceSchema).min(1),
});
export const SearchImageSchema = z.strictObject({
  src: ManagedImagePathSchema,
  alt: z.string().max(300),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  srcset: z.string().max(4000).nullable(),
  sizes: z.string().max(2000).nullable(),
});
export const SearchDocumentSchema = z.strictObject({
  id: ArticleIdSchema,
  title: NonBlankStringSchema.max(200),
  url: RootPathSchema,
  slug: SlugSchema,
  category: z.strictObject({
    path: CategoryPathSchema,
    name: NonBlankStringSchema.max(120),
  }),
  tags: z
    .array(
      z.strictObject({ slug: SlugSchema, name: NonBlankStringSchema.max(120) }),
    )
    .max(20),
  description: NonBlankStringSchema.max(300),
  publishedAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
  featuredImage: SearchImageSchema.nullable(),
});
export const SearchIndexSchema = z.strictObject({
  version: z.literal(1),
  articles: z.array(SearchDocumentSchema),
});
export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    total: z.number().int().min(0),
    page: PageSchema,
    pageSize: PageSizeSchema,
  });
}
