import type { SeoFieldDefaults, SeoResultField } from './seo-defaults.js';
import { seoSourceLabel } from './seo-defaults.js';
import './seo-settings.css';

/** A read-only projection of Core's resolved fields, including their provenance. */
export function SeoEffectivePreview({
  value,
  title = '目前生效結果',
}: {
  readonly value: SeoFieldDefaults | null;
  readonly title?: string;
}) {
  const fields: readonly {
    field: SeoResultField;
    label: string;
    value: string;
  }[] = value
    ? [
        { field: 'title', label: 'SEO 標題', value: value.title || '未設定' },
        {
          field: 'description',
          label: 'Meta Description',
          value: value.description || '未設定',
        },
        {
          field: 'image',
          label: '分享圖片',
          value: value.ogImage ?? '不輸出分享圖片',
        },
        {
          field: 'index',
          label: '索引設定',
          value: value.index ? '允許索引' : '不允許索引',
        },
      ]
    : [];
  return (
    <section className="seo-effective-preview" aria-label={title}>
      <h4>{title}</h4>
      {value ? (
        <dl>
          {fields.map((item) => (
            <div key={item.field} data-seo-effective={item.field}>
              <dt>{item.label}</dt>
              <dd>
                <span className="seo-effective-value">{item.value}</span>
                <span
                  className="seo-effective-source"
                  data-seo-source={item.field}
                >
                  來源：
                  {seoSourceLabel(
                    value.sources[item.field],
                    item.field,
                    value.pageType,
                    value.sourceLayers[item.field],
                  )}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">目前無法取得生效值，請確認網站設定與欄位內容。</p>
      )}
    </section>
  );
}
