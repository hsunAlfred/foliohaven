import { DateTimeSchema, TimeZoneSchema } from '@foliohaven/core';

export interface LocalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

export interface DateTimeCandidate {
  readonly iso: string;
  readonly epochMs: number;
  readonly offsetLabel: string;
}

type InvalidReason = 'format' | 'date' | 'nonexistent' | 'timezone' | 'range';
interface InvalidDateTime {
  readonly status: 'invalid';
  readonly reason: InvalidReason;
  readonly message: string;
}
export type DateTimeResolution =
  | { readonly status: 'valid'; readonly candidate: DateTimeCandidate }
  | {
      readonly status: 'ambiguous';
      readonly candidates: readonly [DateTimeCandidate, DateTimeCandidate];
    }
  | InvalidDateTime;
export type DateTimeInputResult =
  DateTimeResolution | { readonly status: 'empty' };

const partNames = [
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'millisecond',
] as const;
const hourMs = 3_600_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
const messages: Record<InvalidReason, string> = {
  format:
    '請輸入 YYYY-MM-DD HH:mm，可加上秒與最多三位毫秒，或貼上含時區的日期時間。',
  date: '請輸入真實日期與有效時間；時為0–23，分與秒為0–59。',
  nonexistent: '這個時刻因時區調整而不存在，請選擇其他時間。',
  timezone: '網站時區無效，請先在全站設定中選擇有效的時區。',
  range: '日期與換算後的時間都必須位於西元0000至9999年。',
};
const invalid = (reason: InvalidReason): InvalidDateTime => ({
  status: 'invalid',
  reason,
  message: messages[reason],
});

/** Date.UTC treats years 0–99 as 1900–1999; setting the full year avoids that rule. */
function wallEpoch(parts: LocalDateTimeParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}

function validateParts(parts: LocalDateTimeParts): InvalidDateTime | null {
  if (!partNames.every((name) => Number.isInteger(parts[name])))
    return invalid('format');
  if (parts.year < 0 || parts.year > 9999) return invalid('range');
  const leap =
    parts.year % 4 === 0 && (parts.year % 100 !== 0 || parts.year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > (days[parts.month - 1] ?? 0) ||
    parts.hour < 0 ||
    parts.hour > 23 ||
    parts.minute < 0 ||
    parts.minute > 59 ||
    parts.second < 0 ||
    parts.second > 59 ||
    parts.millisecond < 0 ||
    parts.millisecond > 999
  )
    return invalid('date');
  return null;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const known = formatters.get(timeZone);
  if (known) return known;
  if (!TimeZoneSchema.safeParse(timeZone).success) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function localParts(
  epochMs: number,
  formatter: Intl.DateTimeFormat,
): LocalDateTimeParts {
  const fields = new Map<string, string>(
    formatter.formatToParts(epochMs).map(({ type, value }) => [type, value]),
  );
  const year = Number(fields.get('year'));
  return {
    // Intl uses era years (1 BC), whereas ISO uses astronomical years (0000).
    year: fields.get('era') === 'BC' ? 1 - year : year,
    month: Number(fields.get('month')),
    day: Number(fields.get('day')),
    hour: Number(fields.get('hour')),
    minute: Number(fields.get('minute')),
    second: Number(fields.get('second')),
    millisecond: ((epochMs % 1000) + 1000) % 1000,
  };
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');
function offsetLabel(offsetMs: number): string {
  const seconds = Math.abs(Math.round(offsetMs / 1000));
  return `UTC${offsetMs < 0 ? '-' : '+'}${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}${seconds % 60 ? `:${pad(seconds % 60)}` : ''}`;
}

function candidateAt(
  epochMs: number,
  formatter: Intl.DateTimeFormat,
): DateTimeCandidate | null {
  if (!Number.isFinite(epochMs)) return null;
  const iso = new Date(epochMs).toISOString();
  const parts = localParts(epochMs, formatter);
  if (!DateTimeSchema.safeParse(iso).success || validateParts(parts))
    return null;
  return {
    iso,
    epochMs,
    offsetLabel: offsetLabel(wallEpoch(parts) - epochMs),
  };
}

/** Interpret an existing, explicitly zoned ISO value in the website's time zone. */
export function getLocalDateTime(
  value: string,
  timeZone: string,
): LocalDateTimeParts | null {
  const formatter = formatterFor(timeZone);
  if (!formatter || !DateTimeSchema.safeParse(value).success) return null;
  const parts = localParts(Date.parse(value), formatter);
  return validateParts(parts) ? null : parts;
}

export function formatLocalDateTime(parts: LocalDateTimeParts): string {
  if (validateParts(parts)) return '';
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${parts.millisecond ? `.${pad(parts.millisecond, 3)}` : ''}`;
}

/** Resolve a wall-clock time without guessing the earlier/later side of an overlap. */
export function resolveLocalDateTime(
  parts: LocalDateTimeParts,
  timeZone: string,
): DateTimeResolution {
  const error = validateParts(parts);
  if (error) return error;
  const formatter = formatterFor(timeZone);
  if (!formatter) return invalid('timezone');
  const wall = wallEpoch(parts);
  const offsets = new Set<number>();
  // IANA transitions may change an offset by half an hour or a whole day.
  // Read both sides across four days; never assume a fixed one-hour DST shift.
  for (let hour = -48; hour <= 48; hour++) {
    const instant = wall + hour * hourMs;
    offsets.add(wallEpoch(localParts(instant, formatter)) - instant);
  }
  const candidates: DateTimeCandidate[] = [];
  let outsideRange = false;
  for (const offset of offsets) {
    const instant = wall - offset;
    const actual = localParts(instant, formatter);
    if (!partNames.every((name) => actual[name] === parts[name])) continue;
    const candidate = candidateAt(instant, formatter);
    if (candidate) candidates.push(candidate);
    else outsideRange = true;
  }
  if (outsideRange) return invalid('range');
  candidates.sort((left, right) => left.epochMs - right.epochMs);
  const [first, second] = candidates;
  if (!first) return invalid('nonexistent');
  if (!second) return { status: 'valid', candidate: first };
  if (candidates.length > 2) return invalid('timezone');
  return { status: 'ambiguous', candidates: [first, second] };
}

function partsFromMatch(match: RegExpExecArray): LocalDateTimeParts {
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    millisecond: Number((match[7] ?? '').padEnd(3, '0')),
  };
}

export function parseDateTimeInput(
  text: string,
  timeZone: string,
): DateTimeInputResult {
  const value = text.trim();
  if (!value) return { status: 'empty' };
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      value,
    );
  if (match) return resolveLocalDateTime(partsFromMatch(match), timeZone);
  const explicit =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (explicit) {
    const error = validateParts(partsFromMatch(explicit));
    if (error) return error;
  }
  if (!DateTimeSchema.safeParse(value).success) return invalid('format');
  const formatter = formatterFor(timeZone);
  if (!formatter) return invalid('timezone');
  // Date.parse is used only after Core validates an explicit offset or Z.
  const candidate = candidateAt(Date.parse(value), formatter);
  return candidate ? { status: 'valid', candidate } : invalid('range');
}
