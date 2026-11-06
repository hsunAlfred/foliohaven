import { useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import {
  PageSeoSettingsSchema,
  SEO_PAGE_TITLES,
  SEO_PAGE_TYPES,
  SiteConfigSchema,
} from '@foliohaven/core';
import type {
  PageSeoSettings,
  SeoPageType,
  SiteConfig,
} from '@foliohaven/core';
import type { StudioApi } from './api.js';
import { Field, TextField } from './components.js';
import { ImageSelect } from './ImageSelect.js';
import { SeoEffectivePreview } from './SeoEffectivePreview.js';
import { getSeoFieldDefaults, seoPageTypeLabels } from './seo-defaults.js';
import './seo-settings.css';

function contentLabel(type: SeoPageType) {
  return type === 'home'
    ? '使用網站描述'
    : type === 'article'
      ? '使用文章摘要'
      : type === 'category'
        ? '使用分類描述'
        : '使用 Tag 描述';
}

export function SeoSettingsPanel({
  api,
  value,
  onChange,
  pageType,
  onPageTypeChange,
  disabled,
}: {
  readonly api: StudioApi;
  readonly value: SiteConfig;
  readonly onChange: (value: SiteConfig) => void;
  readonly pageType: SeoPageType;
  readonly onPageTypeChange: (value: SeoPageType) => void;
  readonly disabled: boolean;
}) {
  const tabsId = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const tabId = (type: SeoPageType) => `${tabsId}-${type}-tab`;
  const panelId = (type: SeoPageType) => `${tabsId}-${type}-panel`;
  const navigateTypes = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: SeoPageType,
  ) => {
    const index = SEO_PAGE_TYPES.indexOf(current);
    let nextIndex: number;
    if (event.key === 'ArrowRight')
      nextIndex = (index + 1) % SEO_PAGE_TYPES.length;
    else if (event.key === 'ArrowLeft')
      nextIndex = (index - 1 + SEO_PAGE_TYPES.length) % SEO_PAGE_TYPES.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = SEO_PAGE_TYPES.length - 1;
    else return;
    const next = SEO_PAGE_TYPES[nextIndex];
    if (!next) return;
    event.preventDefault();
    onPageTypeChange(next);
    tabs.current
      ?.querySelector<HTMLButtonElement>(`[data-page-type="${next}"]`)
      ?.focus();
  };
  const settings = value.pageSEO?.[pageType] ?? PageSeoSettingsSchema.parse({});
  const prefix = `pageSEO.${pageType}`;
  const change = (next: PageSeoSettings) =>
    onChange({ ...value, pageSEO: { ...value.pageSEO, [pageType]: next } });
  const parsed = SiteConfigSchema.safeParse(value);
  const contentAvailable = ['home', 'article', 'category', 'tag'].includes(
    pageType,
  );
  const title = SEO_PAGE_TITLES[pageType];
  const preview = parsed.success
    ? getSeoFieldDefaults(parsed.data, {
        kind: pageType === 'article' ? 'article' : 'website',
        pageType,
        title,
        ...(contentAvailable
          ? {
              description:
                pageType === 'home'
                  ? value.siteDescription
                  : pageType === 'article'
                    ? '這是文章摘要的範例內容。'
                    : pageType === 'category'
                      ? '這是分類描述的範例內容。'
                      : '這是 Tag 描述的範例內容。',
            }
          : {}),
        featuredImage: null,
      })
    : null;

  return (
    <>
      <section className="seo-settings-block" aria-label="全域 SEO 預設">
        <header>
          <h4>全域預設</h4>
          <p>各頁面未設定自己的值時，使用這一組 SEO 與社群分享預設。</p>
        </header>
        <TextField
          label="SEO Title Template"
          field="defaultSEO.titleTemplate"
          value={value.defaultSEO.titleTemplate}
          maxLength={500}
          width="wide"
          onChange={(next) =>
            onChange({
              ...value,
              defaultSEO: { ...value.defaultSEO, titleTemplate: next ?? '' },
            })
          }
        />
        <p className="seo-template-help">
          {'{title}'} 是頁面標題，{'{siteName}'} 是網站名稱，例如{' '}
          {'{title} | {siteName}'}。
        </p>
        <TextField
          label="Default Meta Description"
          field="defaultSEO.description"
          value={value.defaultSEO.description}
          maxLength={300}
          multiline
          rows={3}
          width="wide"
          hint="這是獨立的全域 SEO 描述，可以與「網站描述」使用不同文字。"
          onChange={(next) =>
            onChange({
              ...value,
              defaultSEO: { ...value.defaultSEO, description: next ?? '' },
            })
          }
        />
        <div className="settings-field-grid">
          <Field label="Default Indexing" hint="頁面類型及單筆內容可分別覆寫。">
            <select
              data-field="defaultSEO.index"
              value={String(value.defaultSEO.index)}
              onChange={(event) =>
                onChange({
                  ...value,
                  defaultSEO: {
                    ...value.defaultSEO,
                    index: event.target.value === 'true',
                  },
                })
              }
            >
              <option value="true">允許索引</option>
              <option value="false">不允許索引</option>
            </select>
          </Field>
          <TextField
            label="Twitter / X Site"
            hint="網站共用的 X 帳號，例如 @your_account；沒有可留空。"
            field="social.twitterSite"
            value={value.social.twitterSite}
            nullable
            maxLength={16}
            width="medium"
            onChange={(next) =>
              onChange({
                ...value,
                social: { ...value.social, twitterSite: next },
              })
            }
          />
        </div>
        <ImageSelect
          api={api}
          label="Default Social Image"
          preference="social"
          field="social.defaultImage"
          value={value.social.defaultImage}
          onChange={(next) =>
            onChange({
              ...value,
              social: { ...value.social, defaultImage: next },
            })
          }
          emptyLabel="不設定全域預設圖片"
          hint="可選1200 × 630分享尺寸，提供完整補邊與裁切填滿兩種版本。"
          disabled={disabled}
        />
        <TextField
          label="Google Search Console Verification"
          field="googleSiteVerification"
          value={value.googleSiteVerification}
          nullable
          maxLength={512}
          width="wide"
          hint="網站共用的 Google 驗證碼，僅在首頁輸出；沒有可留空。"
          onChange={(next) =>
            onChange({ ...value, googleSiteVerification: next })
          }
        />
      </section>

      <section className="seo-settings-block" aria-label="頁面類型 SEO 預設">
        <header>
          <h4>頁面類型預設</h4>
          <p>
            每個欄位各自繼承。文章、分類與 Tag 仍可在各自管理頁面設定單筆覆寫。
          </p>
        </header>
        <div className="seo-page-type-toolbar">
          <div
            ref={tabs}
            className="seo-page-type-tabs"
            role="tablist"
            aria-label="頁面類型"
            aria-orientation="horizontal"
            data-field="pageSEO"
            tabIndex={-1}
          >
            {SEO_PAGE_TYPES.map((type) => (
              <button
                type="button"
                role="tab"
                id={tabId(type)}
                key={type}
                aria-controls={panelId(type)}
                aria-selected={type === pageType}
                tabIndex={type === pageType ? 0 : -1}
                data-page-type={type}
                onClick={() => onPageTypeChange(type)}
                onKeyDown={(event) => navigateTypes(event, type)}
              >
                {seoPageTypeLabels[type]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => change(PageSeoSettingsSchema.parse({}))}
          >
            清除此類型自訂內容
          </button>
        </div>
        {SEO_PAGE_TYPES.map((type) => (
          <div
            key={type}
            id={panelId(type)}
            role="tabpanel"
            aria-labelledby={tabId(type)}
            hidden={type !== pageType}
            tabIndex={0}
            className="seo-page-type-panel"
          >
            {type === pageType && (
              <>
                <Field label="類型標題設定" width="wide">
                  <select
                    value={
                      settings.titleTemplate === null ? 'inherit' : 'custom'
                    }
                    data-field={`${prefix}.titleTemplateMode`}
                    onChange={(event) =>
                      change({
                        ...settings,
                        titleTemplate:
                          event.target.value === 'inherit'
                            ? null
                            : (settings.titleTemplate ??
                              value.defaultSEO.titleTemplate),
                      })
                    }
                  >
                    <option value="inherit">繼承全域 Title Template</option>
                    <option value="custom">自訂此類型 Title Template</option>
                  </select>
                </Field>
                {settings.titleTemplate !== null && (
                  <TextField
                    label="類型 Title Template"
                    field={`${prefix}.titleTemplate`}
                    value={settings.titleTemplate}
                    maxLength={500}
                    width="wide"
                    hint={`此類型的 {title} 使用頁面標題；範例為「${title}」。`}
                    onChange={(next) =>
                      change({ ...settings, titleTemplate: next ?? '' })
                    }
                  />
                )}
                <Field label="類型描述設定" width="wide">
                  <select
                    value={settings.descriptionSource}
                    data-field={`${prefix}.descriptionSource`}
                    onChange={(event) =>
                      change({
                        ...settings,
                        descriptionSource: event.target
                          .value as PageSeoSettings['descriptionSource'],
                      })
                    }
                  >
                    <option value="inherit">繼承全域 Meta Description</option>
                    {contentAvailable && (
                      <option value="content">{contentLabel(pageType)}</option>
                    )}
                    <option value="custom">自訂此類型 Meta Description</option>
                  </select>
                </Field>
                {settings.descriptionSource === 'content' && (
                  <p className="seo-template-help">
                    內容留白時，自動回退全域 Meta Description。
                  </p>
                )}
                {settings.descriptionSource === 'custom' && (
                  <TextField
                    label="類型 Meta Description"
                    field={`${prefix}.description`}
                    value={settings.description}
                    maxLength={300}
                    multiline
                    rows={3}
                    width="wide"
                    onChange={(next) =>
                      change({ ...settings, description: next })
                    }
                  />
                )}
                <div className="settings-field-grid">
                  <Field
                    label="類型索引設定"
                    width="wide"
                    hint={
                      pageType === 'notFound'
                        ? '404 固定不允許索引，不會被全域設定覆蓋。'
                        : pageType === 'category' || pageType === 'tag'
                          ? '每個欄位獨立繼承；尚無已發布文章的分類或 Tag，仍固定不允許索引。'
                          : '選擇繼承時，保留全域索引設定。'
                    }
                  >
                    <select
                      data-field={`${prefix}.index`}
                      value={
                        settings.index === null
                          ? 'inherit'
                          : String(settings.index)
                      }
                      disabled={pageType === 'notFound'}
                      onChange={(event) =>
                        change({
                          ...settings,
                          index:
                            event.target.value === 'inherit'
                              ? null
                              : event.target.value === 'true',
                        })
                      }
                    >
                      <option value="inherit">
                        {pageType === 'notFound'
                          ? '不允許索引（固定規則）'
                          : '繼承全域索引設定'}
                      </option>
                      <option value="true">允許索引</option>
                      <option value="false">不允許索引</option>
                    </select>
                  </Field>
                  <Field label="類型分享圖片設定" width="wide">
                    <select
                      value={settings.imageSource}
                      data-field={`${prefix}.imageSource`}
                      onChange={(event) => {
                        const source = event.target
                          .value as PageSeoSettings['imageSource'];
                        change({
                          ...settings,
                          imageSource: source,
                          ogImage:
                            source === 'custom' ? settings.ogImage : null,
                        });
                      }}
                    >
                      <option value="inherit">繼承全域分享圖片</option>
                      {pageType === 'article' && (
                        <option value="featured">使用文章精選圖片</option>
                      )}
                      <option value="custom">指定圖片</option>
                      <option value="none">不使用分享圖片</option>
                    </select>
                  </Field>
                </div>
                {settings.imageSource === 'featured' && (
                  <p className="seo-template-help">
                    文章沒有精選圖片時，自動回退全域分享圖片。
                  </p>
                )}
                {settings.imageSource === 'none' && (
                  <p className="seo-template-help">
                    不輸出分享圖片標籤，並停止回退全域圖片。
                  </p>
                )}
                {settings.imageSource === 'custom' && (
                  <ImageSelect
                    api={api}
                    label="類型分享圖片"
                    preference="social"
                    field={`${prefix}.ogImage`}
                    value={settings.ogImage}
                    onChange={(next) =>
                      change({
                        ...settings,
                        ogImage: next,
                        imageSource: next === null ? 'inherit' : 'custom',
                      })
                    }
                    emptyLabel="繼承全域分享圖片"
                    disabled={disabled}
                  />
                )}
                <p className="seo-template-help">
                  以下使用範例標題
                  {pageType === 'home'
                    ? '與目前網站描述'
                    : contentAvailable
                      ? '與範例摘要／描述'
                      : ''}
                  ，不含單筆覆寫。圖片範例不提供文章精選圖。
                </p>
                <SeoEffectivePreview
                  value={preview}
                  title="此類型生效結果（範例內容）"
                />
              </>
            )}
          </div>
        ))}
      </section>
    </>
  );
}
