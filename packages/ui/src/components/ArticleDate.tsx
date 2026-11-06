export interface ArticleDateProps {
  readonly value: string;
  readonly language: string;
  readonly timeZone: string;
  readonly label?: string;
  readonly format?: 'date' | 'date-time';
}
/** 僅呈現 Core 已驗證的 instant，不推測時區或修改來源日期。 */
export function ArticleDate({
  value,
  language,
  timeZone,
  label,
  format = 'date',
}: ArticleDateProps) {
  const instant = new Date(value);
  let display: string;
  if (format === 'date-time') {
    const parts = new Intl.DateTimeFormat(language, {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';
    display = `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
  } else {
    display = new Intl.DateTimeFormat(language, {
      timeZone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(instant);
  }
  return (
    <span className="article-date">
      {label !== undefined && <span>{label} </span>}
      <time dateTime={value}>{display}</time>
    </span>
  );
}
