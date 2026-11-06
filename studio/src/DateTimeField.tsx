import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { captureFocusOwner } from './focus.js';
import type { KeyboardEvent } from 'react';
import { Dialog } from './Dialog.js';
import { Field } from './components.js';
import { Icon } from './Icon.js';
import {
  formatLocalDateTime,
  getLocalDateTime,
  parseDateTimeInput,
  resolveLocalDateTime,
} from './date-time.js';
import type {
  DateTimeCandidate,
  DateTimeInputResult,
  LocalDateTimeParts,
} from './date-time.js';
import './date-time.css';

function candidateFor(result: DateTimeInputResult, epoch: number | null) {
  if (result.status === 'valid') return result.candidate;
  if (result.status === 'ambiguous')
    return result.candidates.find((candidate) => candidate.epochMs === epoch);
  return undefined;
}
function displayValue(value: string | null, timeZone: string | null) {
  if (!value) return '';
  const parts = timeZone ? getLocalDateTime(value, timeZone) : null;
  return parts ? formatLocalDateTime(parts) : value;
}
const epochOf = (value: string | null) => (value ? Date.parse(value) : null);

function OverlapChoice({
  label,
  candidates,
  selected,
  onSelect,
}: {
  label: string;
  candidates: readonly [DateTimeCandidate, DateTimeCandidate];
  selected: number | null;
  onSelect: (candidate: DateTimeCandidate) => void;
}) {
  const name = useId();
  return (
    <fieldset className="date-time-overlap" aria-label={`${label}的重複時段`}>
      <legend>這個時間出現兩次，請選擇時段</legend>
      {candidates.map((candidate, index) => (
        <label key={candidate.iso}>
          <input
            type="radio"
            name={name}
            checked={selected === candidate.epochMs}
            onChange={() => onSelect(candidate)}
          />
          <span>
            {index === 0 ? '第一次' : '第二次'}（{candidate.offsetLabel}）
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function DateTimeField({
  label,
  field,
  value,
  timeZone,
  onChange,
  onPendingChange,
  disabled = false,
  resetKey = 0,
}: {
  label: string;
  field: string;
  value: string | null;
  timeZone: string | null;
  onChange: (next: string | null) => void;
  onPendingChange: (pending: boolean) => void;
  disabled?: boolean;
  resetKey?: number;
}) {
  const id = useId();
  const [text, setText] = useState(() => displayValue(value, timeZone));
  const [edited, setEdited] = useState(false);
  const [chosenEpoch, setChosenEpoch] = useState<number | null>(null);
  const [picker, setPicker] = useState<{
    parts: LocalDateTimeParts;
    epoch: number;
  } | null>(null);
  const [pickerPending, setPickerPending] = useState(false);
  const [zoneNotice, setZoneNotice] = useState('');
  const emitted = useRef<string | null | undefined>(undefined);
  const previous = useRef({ value, timeZone, resetKey });
  const usableZone = Boolean(
    timeZone && getLocalDateTime(new Date().toISOString(), timeZone),
  );
  const result = useMemo(
    () => parseDateTimeInput(text, timeZone ?? ''),
    [text, timeZone],
  );
  const selected = candidateFor(result, chosenEpoch ?? epochOf(value));
  const invalidInput =
    edited &&
    (result.status === 'invalid' ||
      (result.status === 'ambiguous' && !selected));
  const pending = invalidInput || pickerPending;

  useEffect(() => {
    const old = previous.current;
    previous.current = { value, timeZone, resetKey };
    if (
      emitted.current === value &&
      old.timeZone === timeZone &&
      old.resetKey === resetKey
    ) {
      emitted.current = undefined;
      return;
    }
    emitted.current = undefined;
    setText(displayValue(value, timeZone));
    setEdited(false);
    setChosenEpoch(null);
    if (old.timeZone !== timeZone) {
      setPicker(null);
      setPickerPending(false);
      if (old.timeZone !== null)
        setZoneNotice('網站時區已變更，已重新顯示原時間；請重新選擇。');
    }
  }, [value, timeZone, resetKey]);
  useEffect(() => onPendingChange(pending), [onPendingChange, pending]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  const emit = (next: string | null) => {
    if (next === null ? value === null : epochOf(value) === Date.parse(next))
      return;
    emitted.current = next;
    onChange(next);
  };
  const inputChanged = (next: string) => {
    setText(next);
    setEdited(true);
    setChosenEpoch(null);
    setZoneNotice('');
    const parsed = parseDateTimeInput(next, timeZone ?? '');
    if (parsed.status === 'empty') emit(null);
    else {
      const candidate = candidateFor(parsed, epochOf(value));
      if (candidate) emit(candidate.iso);
    }
  };
  const apply = (candidate: DateTimeCandidate | null) => {
    emit(candidate?.iso ?? null);
    setText(displayValue(candidate?.iso ?? null, timeZone));
    setEdited(false);
    setChosenEpoch(candidate?.epochMs ?? null);
    setPicker(null);
    setPickerPending(false);
  };
  const normalize = () => {
    if (result.status === 'empty') {
      setText('');
      setEdited(false);
    } else if (selected && timeZone) {
      setText(displayValue(selected.iso, timeZone));
      setEdited(false);
    }
  };
  return (
    <div className="field date-time-field">
      <label htmlFor={id}>{label}</label>
      <div className="date-time-input-row">
        <input
          id={id}
          value={text}
          data-field={field}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          placeholder="YYYY-MM-DD HH:mm:ss"
          aria-invalid={invalidInput || undefined}
          aria-describedby={`${id}-format ${id}-zone${invalidInput ? ` ${id}-error` : ''}`}
          disabled={disabled || !usableZone}
          onChange={(event) => inputChanged(event.target.value)}
          onBlur={normalize}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              normalize();
            }
          }}
        />
        <button
          type="button"
          className="date-time-trigger"
          aria-label={`選擇${label}`}
          aria-haspopup="dialog"
          aria-expanded={picker !== null}
          disabled={disabled || !usableZone}
          onClick={() => {
            if (!timeZone) return;
            const initialValue = value ?? new Date().toISOString();
            const parts =
              getLocalDateTime(initialValue, timeZone) ??
              getLocalDateTime(new Date().toISOString(), timeZone);
            if (parts) {
              setZoneNotice('');
              setPicker({ parts, epoch: Date.parse(initialValue) });
            }
          }}
        >
          <Icon name="calendar" />
        </button>
      </div>
      <small id={`${id}-format`}>
        可直接輸入年-月-日 時:分，秒數可省略；也可開啟日曆選擇。
      </small>
      <small id={`${id}-zone`} className="date-time-zone">
        {usableZone
          ? `網站時區：${timeZone}${selected ? `（${selected.offsetLabel}）` : ''}`
          : '目前無法取得有效的網站時區，請先至全站設定確認。'}
      </small>
      {zoneNotice && <small role="status">{zoneNotice}</small>}
      {invalidInput && (
        <small id={`${id}-error`} className="date-time-error" role="alert">
          {result.status === 'invalid'
            ? result.message
            : '這個時間有兩個時段，請先選擇要使用哪一次。'}
        </small>
      )}
      {result.status === 'ambiguous' && (
        <OverlapChoice
          label={label}
          candidates={result.candidates}
          selected={selected?.epochMs ?? null}
          onSelect={(candidate) => {
            setChosenEpoch(candidate.epochMs);
            emit(candidate.iso);
          }}
        />
      )}
      {picker && timeZone && (
        <DateTimePicker
          label={label}
          timeZone={timeZone}
          initial={picker.parts}
          preferredEpoch={picker.epoch}
          disabled={disabled}
          onApply={apply}
          onPendingChange={setPickerPending}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function calendarDate(parts: LocalDateTimeParts) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}
function daysInMonth(year: number, month: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}
function shiftMonth(parts: LocalDateTimeParts, difference: number) {
  const index = parts.year * 12 + parts.month - 1 + difference;
  if (index < 0 || index >= 120_000) return parts;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return {
    ...parts,
    year,
    month,
    day: Math.min(parts.day, daysInMonth(year, month)),
  };
}
function calendarKey(parts: LocalDateTimeParts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function monthCells(parts: LocalDateTimeParts) {
  const first = calendarDate({ ...parts, day: 1 });
  first.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(first.getUTCDate() + index);
    const year = date.getUTCFullYear();
    return year < 0 || year > 9999
      ? null
      : {
          ...parts,
          year,
          month: date.getUTCMonth() + 1,
          day: date.getUTCDate(),
        };
  });
}

function DateTimePicker({
  label,
  timeZone,
  initial,
  preferredEpoch,
  disabled,
  onApply,
  onPendingChange,
  onClose,
}: {
  label: string;
  timeZone: string;
  initial: LocalDateTimeParts;
  preferredEpoch: number;
  disabled: boolean;
  onApply: (candidate: DateTimeCandidate | null) => void;
  onPendingChange: (pending: boolean) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [chosenEpoch, setChosenEpoch] = useState<number | null>(null);
  const dayButtons = useRef(new Map<string, HTMLButtonElement>());
  const resolution = useMemo(
    () => resolveLocalDateTime(draft, timeZone),
    [draft, timeZone],
  );
  const candidate = candidateFor(resolution, chosenEpoch ?? preferredEpoch);
  const initialCandidate = useMemo(
    () => candidateFor(resolveLocalDateTime(initial, timeZone), preferredEpoch),
    [initial, preferredEpoch, timeZone],
  );
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(initial) ||
    candidate?.epochMs !== initialCandidate?.epochMs;
  useEffect(() => onPendingChange(dirty), [dirty, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  const close = () => {
    if (dirty && !window.confirm('放棄尚未套用的日期與時間？')) return;
    onClose();
  };
  const update = (next: LocalDateTimeParts, focus = false) => {
    const ownsFocus = captureFocusOwner(document);
    setDraft(next);
    setChosenEpoch(null);
    if (focus)
      requestAnimationFrame(() => {
        if (ownsFocus()) dayButtons.current.get(calendarKey(next))?.focus();
      });
  };
  const dayKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    day: LocalDateTimeParts,
  ) => {
    let next: LocalDateTimeParts;
    if (event.key === 'PageUp' || event.key === 'PageDown')
      next = shiftMonth(
        day,
        (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1),
      );
    else {
      const date = calendarDate(day);
      const weekday = (date.getUTCDay() + 6) % 7;
      const movement: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -7,
        ArrowDown: 7,
        Home: -weekday,
        End: 6 - weekday,
      };
      const difference = movement[event.key];
      if (difference === undefined) return;
      date.setUTCDate(date.getUTCDate() + difference);
      const year = date.getUTCFullYear();
      if (year < 0 || year > 9999) return;
      next = {
        ...day,
        year,
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      };
    }
    event.preventDefault();
    update(next, true);
  };
  const today = getLocalDateTime(new Date().toISOString(), timeZone);
  const cells = monthCells(draft);
  const yearStart = Math.max(0, draft.year - 100);
  const yearEnd = Math.min(9999, draft.year + 100);
  return (
    <Dialog
      open
      title={`選擇${label}`}
      className="date-time-dialog"
      onClose={close}
      actions={
        <div className="date-time-picker-actions">
          <button
            type="button"
            className="quiet"
            disabled={disabled}
            onClick={() => onApply(null)}
          >
            清除
          </button>
          <div className="date-time-picker-actions-end">
            <button type="button" onClick={close}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={disabled || !candidate}
              onClick={() => {
                if (candidate) onApply(candidate);
              }}
            >
              套用時間
            </button>
          </div>
        </div>
      }
    >
      <fieldset
        disabled={disabled}
        style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
      >
        <legend className="sr-only">選擇日期與時間</legend>
        <p className="date-time-zone">
          網站時區：{timeZone}。套用後仍需保存文章。
        </p>
        <div className="date-time-picker-header">
          <button
            type="button"
            aria-label="上一個月"
            disabled={draft.year === 0 && draft.month === 1}
            onClick={() => update(shiftMonth(draft, -1))}
          >
            <Icon name="chevronLeft" />
          </button>
          <Field label="年份">
            <select
              value={draft.year}
              onChange={(event) => {
                const year = Number(event.target.value);
                update({
                  ...draft,
                  year,
                  day: Math.min(draft.day, daysInMonth(year, draft.month)),
                });
              }}
            >
              {Array.from(
                { length: yearEnd - yearStart + 1 },
                (_, index) => yearStart + index,
              ).map((year) => (
                <option key={year} value={year}>
                  {String(year).padStart(4, '0')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="月份">
            <select
              value={draft.month}
              onChange={(event) => {
                const month = Number(event.target.value);
                update({
                  ...draft,
                  month,
                  day: Math.min(draft.day, daysInMonth(draft.year, month)),
                });
              }}
            >
              {Array.from({ length: 12 }, (_, index) => index + 1).map(
                (month) => (
                  <option key={month} value={month}>
                    {month} 月
                  </option>
                ),
              )}
            </select>
          </Field>
          <button
            type="button"
            aria-label="下一個月"
            disabled={draft.year === 9999 && draft.month === 12}
            onClick={() => update(shiftMonth(draft, 1))}
          >
            <Icon name="chevronRight" />
          </button>
        </div>
        <table
          className="date-time-calendar"
          role="grid"
          aria-label={`${draft.year}年${draft.month}月`}
        >
          <thead>
            <tr>
              {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
                <th key={day} scope="col">
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }, (_, week) => (
              <tr key={week}>
                {cells.slice(week * 7, week * 7 + 7).map((day, column) => {
                  const selected =
                    day !== null && calendarKey(day) === calendarKey(draft);
                  return (
                    <td
                      key={day ? calendarKey(day) : column}
                      role="gridcell"
                      aria-selected={selected}
                    >
                      {day && (
                        <button
                          type="button"
                          className={`date-time-day${selected ? ' is-selected' : ''}${day.month !== draft.month ? ' is-outside' : ''}${today && calendarKey(today) === calendarKey(day) ? ' is-today' : ''}`}
                          aria-label={`${day.year}年${day.month}月${day.day}日`}
                          aria-current={
                            today && calendarKey(today) === calendarKey(day)
                              ? 'date'
                              : undefined
                          }
                          aria-pressed={selected}
                          tabIndex={selected ? 0 : -1}
                          ref={(element) => {
                            if (element)
                              dayButtons.current.set(calendarKey(day), element);
                            else dayButtons.current.delete(calendarKey(day));
                          }}
                          onKeyDown={(event) => dayKey(event, day)}
                          onClick={() => update(day, true)}
                        >
                          {day.day}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="date-time-clock-heading">
          <h3>
            <Icon name="clock" /> 時間
          </h3>
          <button
            type="button"
            className="quiet"
            onClick={() => {
              const now = getLocalDateTime(new Date().toISOString(), timeZone);
              if (now) update(now);
            }}
          >
            現在
          </button>
        </div>
        <div className="date-time-clock">
          {(['hour', 'minute', 'second'] as const).map((part, index) => (
            <Field key={part} label={['小時', '分鐘', '秒'][index] ?? ''}>
              <select
                value={draft[part]}
                onChange={(event) =>
                  update({ ...draft, [part]: Number(event.target.value) })
                }
              >
                {Array.from(
                  { length: part === 'hour' ? 24 : 60 },
                  (_, value) => (
                    <option key={value} value={value}>
                      {String(value).padStart(2, '0')}
                    </option>
                  ),
                )}
              </select>
            </Field>
          ))}
        </div>
        {resolution.status === 'invalid' && (
          <p className="date-time-error" role="alert">
            {resolution.message}
          </p>
        )}
        {resolution.status === 'ambiguous' && (
          <OverlapChoice
            label={label}
            candidates={resolution.candidates}
            selected={candidate?.epochMs ?? null}
            onSelect={(selected) => setChosenEpoch(selected.epochMs)}
          />
        )}
        <div className="date-time-preview" aria-live="polite">
          將設定為
          <strong>{formatLocalDateTime(draft)}</strong>
          <small>
            {timeZone}
            {candidate ? ` · ${candidate.offsetLabel}` : ' · 請先選擇有效時段'}
          </small>
        </div>
      </fieldset>
    </Dialog>
  );
}
