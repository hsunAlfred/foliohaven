import { describe, expect, it } from 'vitest';
import { DateTimeSchema } from '@foliohaven/core';
import {
  formatLocalDateTime,
  getLocalDateTime,
  parseDateTimeInput,
  resolveLocalDateTime,
} from '../../studio/src/date-time.js';
import type { LocalDateTimeParts } from '../../studio/src/date-time.js';

const parts = (
  overrides: Partial<LocalDateTimeParts> = {},
): LocalDateTimeParts => ({
  year: 2026,
  month: 10,
  day: 24,
  hour: 9,
  minute: 5,
  second: 7,
  millisecond: 0,
  ...overrides,
});

describe('Studio website-local date and time', () => {
  it('converts Taipei across a UTC date boundary without using the host zone', () => {
    const value = getLocalDateTime('2026-10-23T23:05:07Z', 'Asia/Taipei');
    expect(value).toEqual(parts({ hour: 7 }));
    expect(value && formatLocalDateTime(value)).toBe('2026-10-24 07:05:07');
    const resolved = resolveLocalDateTime(parts({ hour: 0 }), 'Asia/Taipei');
    expect(resolved).toMatchObject({
      status: 'valid',
      candidate: {
        iso: '2026-10-23T16:05:07.000Z',
        epochMs: Date.parse('2026-10-23T16:05:07.000Z'),
        offsetLabel: 'UTC+08:00',
      },
    });
  });

  it('formats UTC midnight with hour zero rather than hour 24', () => {
    expect(getLocalDateTime('2026-01-01T00:00:00Z', 'UTC')).toEqual(
      parts({ month: 1, day: 1, hour: 0, minute: 0, second: 0 }),
    );
    expect(parseDateTimeInput('2026-01-01 00:00', 'UTC')).toMatchObject({
      status: 'valid',
      candidate: { iso: '2026-01-01T00:00:00.000Z', offsetLabel: 'UTC+00:00' },
    });
  });

  it('rejects the New York spring gap rather than silently moving the time', () => {
    expect(
      parseDateTimeInput('2026-03-08 02:30', 'America/New_York'),
    ).toMatchObject({
      status: 'invalid',
      reason: 'nonexistent',
    });
    expect(
      parseDateTimeInput('2026-03-08 01:30', 'America/New_York'),
    ).toMatchObject({
      status: 'valid',
      candidate: { iso: '2026-03-08T06:30:00.000Z', offsetLabel: 'UTC-05:00' },
    });
    expect(
      parseDateTimeInput('2026-03-08 03:30', 'America/New_York'),
    ).toMatchObject({
      status: 'valid',
      candidate: { iso: '2026-03-08T07:30:00.000Z', offsetLabel: 'UTC-04:00' },
    });
  });

  it('returns both New York autumn candidates in instant order and preserves milliseconds', () => {
    const value = parseDateTimeInput(
      '2026-11-01 01:30:00.125',
      'America/New_York',
    );
    expect(value).toMatchObject({
      status: 'ambiguous',
      candidates: [
        { iso: '2026-11-01T05:30:00.125Z', offsetLabel: 'UTC-04:00' },
        { iso: '2026-11-01T06:30:00.125Z', offsetLabel: 'UTC-05:00' },
      ],
    });
    if (value.status !== 'ambiguous') throw new Error('Expected an overlap');
    expect(value.candidates[1].epochMs - value.candidates[0].epochMs).toBe(
      3_600_000,
    );
    for (const candidate of value.candidates) {
      expect(DateTimeSchema.safeParse(candidate.iso).success).toBe(true);
      expect(getLocalDateTime(candidate.iso, 'America/New_York')).toEqual(
        parts({
          month: 11,
          day: 1,
          hour: 1,
          minute: 30,
          second: 0,
          millisecond: 125,
        }),
      );
    }
  });

  it('handles Lord Howe half-hour autumn overlap', () => {
    const value = parseDateTimeInput('2026-04-05 01:45', 'Australia/Lord_Howe');
    expect(value).toMatchObject({
      status: 'ambiguous',
      candidates: [
        { iso: '2026-04-04T14:45:00.000Z', offsetLabel: 'UTC+11:00' },
        { iso: '2026-04-04T15:15:00.000Z', offsetLabel: 'UTC+10:30' },
      ],
    });
    if (value.status !== 'ambiguous') throw new Error('Expected an overlap');
    expect(value.candidates[1].epochMs - value.candidates[0].epochMs).toBe(
      1_800_000,
    );
  });

  it('rejects Lord Howe half-hour spring gap', () => {
    expect(
      parseDateTimeInput('2026-10-04 02:15', 'Australia/Lord_Howe'),
    ).toMatchObject({
      status: 'invalid',
      reason: 'nonexistent',
    });
    expect(
      parseDateTimeInput('2026-10-04 02:30', 'Australia/Lord_Howe'),
    ).toMatchObject({
      status: 'valid',
      candidate: { iso: '2026-10-03T15:30:00.000Z', offsetLabel: 'UTC+11:00' },
    });
  });

  it('rejects an entire skipped calendar date in Apia', () => {
    expect(
      parseDateTimeInput('2011-12-30 12:00', 'Pacific/Apia'),
    ).toMatchObject({
      status: 'invalid',
      reason: 'nonexistent',
    });
  });

  it.each([
    '2025-02-29 10:00',
    '1900-02-29 10:00',
    '2026-04-31 10:00',
    '2026-00-10 10:00',
    '2026-13-10 10:00',
    '2026-01-00 10:00',
    '2026-01-01 24:00',
    '2026-01-01 12:60',
    '2026-01-01 12:00:60',
  ])('rejects impossible calendar/time input %s', (value) => {
    expect(parseDateTimeInput(value, 'Asia/Taipei')).toMatchObject({
      status: 'invalid',
      reason: 'date',
    });
  });

  it.each(['2000-02-29 10:00', '2024-02-29 10:00', '0000-02-29 10:00'])(
    'accepts a Gregorian leap date %s',
    (value) => {
      expect(parseDateTimeInput(value, 'UTC').status).toBe('valid');
    },
  );

  it.each(['0000', '0001', '0099', '0100', '9999'])(
    'preserves ISO year %s without the Date.UTC century shortcut or Intl era error',
    (year) => {
      const iso = `${year}-02-01T10:05:07.009Z`;
      const local = getLocalDateTime(iso, 'UTC');
      expect(local).toEqual(
        parts({
          year: Number(year),
          month: 2,
          day: 1,
          hour: 10,
          millisecond: 9,
        }),
      );
      expect(local && formatLocalDateTime(local)).toBe(
        `${year}-02-01 10:05:07.009`,
      );
      expect(
        parseDateTimeInput(`${year}-02-01 10:05:07.009`, 'UTC'),
      ).toMatchObject({
        status: 'valid',
        candidate: { iso },
      });
    },
  );

  it('keeps millisecond precision, including negative epoch instants', () => {
    expect(formatLocalDateTime(parts())).toBe('2026-10-24 09:05:07');
    expect(formatLocalDateTime(parts({ millisecond: 1 }))).toBe(
      '2026-10-24 09:05:07.001',
    );
    expect(formatLocalDateTime(parts({ millisecond: 120 }))).toBe(
      '2026-10-24 09:05:07.120',
    );
    expect(
      getLocalDateTime('1969-12-31T23:59:59.007Z', 'UTC')?.millisecond,
    ).toBe(7);
    expect(parseDateTimeInput('2026-10-24T09:05:07.1', 'UTC')).toMatchObject({
      status: 'valid',
      candidate: { iso: '2026-10-24T09:05:07.100Z' },
    });
  });

  it('accepts explicit offsets and labels them using the website zone at that instant', () => {
    const first = parseDateTimeInput(
      '2026-11-01T01:30:00-04:00',
      'Asia/Taipei',
    );
    const equivalent = parseDateTimeInput(
      '2026-11-01T05:30:00Z',
      'Asia/Taipei',
    );
    expect(first).toEqual(equivalent);
    expect(first).toMatchObject({
      status: 'valid',
      candidate: { iso: '2026-11-01T05:30:00.000Z', offsetLabel: 'UTC+08:00' },
    });
    expect(
      parseDateTimeInput('2026-11-01T01:30:00-05:00', 'America/New_York'),
    ).toMatchObject({
      status: 'valid',
      candidate: { iso: '2026-11-01T06:30:00.000Z', offsetLabel: 'UTC-05:00' },
    });
  });

  it('treats pasted, explicitly zoned instants as instants even during a local gap', () => {
    expect(
      parseDateTimeInput('2026-03-08T02:30:00-05:00', 'America/New_York'),
    ).toMatchObject({
      status: 'valid',
      candidate: { iso: '2026-03-08T07:30:00.000Z', offsetLabel: 'UTC-04:00' },
    });
  });

  it.each(['', ' ', '\n\t'])(
    'allows clearing %j even when the configured zone is unavailable',
    (value) =>
      expect(parseDateTimeInput(value, 'Invalid/Zone')).toEqual({
        status: 'empty',
      }),
  );

  it.each(['Invalid/Zone', '', '+08:00'])(
    'returns an invalid-zone result rather than guessing or throwing for %j',
    (zone) => {
      expect(parseDateTimeInput('2026-10-24 09:05', zone)).toMatchObject({
        status: 'invalid',
        reason: 'timezone',
      });
      expect(parseDateTimeInput('2026-10-24T09:05:00Z', zone)).toMatchObject({
        status: 'invalid',
        reason: 'timezone',
      });
      expect(getLocalDateTime('2026-10-24T09:05:00Z', zone)).toBeNull();
    },
  );

  it.each([
    '2026/10/24 09:05',
    '10/24/2026 09:05',
    '2026-10-24',
    '2026-10-24 9:05',
    '2026-10-24 09:05.123',
    '2026-10-24 09:05:07.1234',
    '2026-10-24T09:05:07+24:00',
  ])('rejects malformed or Core-invalid explicit input %s', (value) => {
    expect(parseDateTimeInput(value, 'UTC')).toMatchObject({
      status: 'invalid',
      reason: 'format',
    });
    expect(getLocalDateTime(value, 'UTC')).toBeNull();
  });

  it('reports impossible dates in explicit ISO input as dates rather than formatting errors', () => {
    for (const value of [
      '2026-02-30T09:05:07Z',
      '2026-04-31T09:05:07+08:00',
      '2026-10-24T24:05:07Z',
    ]) {
      expect(parseDateTimeInput(value, 'UTC')).toMatchObject({
        status: 'invalid',
        reason: 'date',
      });
      expect(getLocalDateTime(value, 'UTC')).toBeNull();
    }
  });

  it('rejects dates outside both the editable and persistable four-digit year range', () => {
    for (const value of [
      parseDateTimeInput('0000-01-01 00:00', 'Asia/Taipei'),
      parseDateTimeInput('9999-12-31 23:30', 'America/New_York'),
      parseDateTimeInput('0000-01-01T00:00:00+23:00', 'UTC'),
      parseDateTimeInput('9999-12-31T23:00:00-23:00', 'UTC'),
      parseDateTimeInput('9999-12-31T23:00:00Z', 'Asia/Taipei'),
      resolveLocalDateTime(parts({ year: -1 }), 'UTC'),
      resolveLocalDateTime(parts({ year: 10000 }), 'UTC'),
    ])
      expect(value).toMatchObject({ status: 'invalid', reason: 'range' });
    expect(getLocalDateTime('9999-12-31T23:00:00Z', 'Asia/Taipei')).toBeNull();
  });

  it('handles invalid numeric parts without throwing or normalizing them into another date', () => {
    for (const value of [parts({ year: NaN }), parts({ hour: 1.5 })]) {
      expect(resolveLocalDateTime(value, 'UTC')).toMatchObject({
        status: 'invalid',
        reason: 'format',
      });
      expect(formatLocalDateTime(value)).toBe('');
    }
    expect(
      resolveLocalDateTime(parts({ millisecond: 1000 }), 'UTC'),
    ).toMatchObject({ status: 'invalid', reason: 'date' });
    expect(formatLocalDateTime(parts({ day: 32 }))).toBe('');
  });
});
