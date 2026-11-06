import { describe, expect, it } from 'vitest';
import {
  filterJobs,
  filterMediaSources,
  JobListQuerySchema,
  MediaListQuerySchema,
  paginateRecoveries,
} from '../../packages/core/src/index.js';

const jobs = [
  {
    id: 'b',
    type: 'build' as const,
    status: 'queued' as const,
    createdAt: '2026-10-23T01:00:00Z',
  },
  {
    id: 'a',
    type: 'media' as const,
    status: 'queued' as const,
    createdAt: '2026-10-23T01:00:00Z',
  },
  {
    id: 'c',
    type: 'build' as const,
    status: 'failed' as const,
    createdAt: '2026-10-23T02:00:00Z',
  },
];
const media = [
  { id: 'b', kind: 'image' as const, displayName: 'Ｂeta 筆記' },
  { id: 'a', kind: 'video' as const, displayName: 'Alpha 工具' },
  { id: 'c', kind: 'image' as const, displayName: 'Beta 筆記' },
];
describe('shared management collection rules', () => {
  it('merges recovery sources with one chronological order and stable pagination', () => {
    const rows = jobs.map(({ id, createdAt }) => ({ id, createdAt }));
    const result = paginateRecoveries(rows, { page: 1, pageSize: 2 });
    expect(result.items.map((row) => row.id)).toEqual(['c', 'a']);
    expect(result.total).toBe(3);
    expect(rows.map((row) => row.id)).toEqual(['b', 'a', 'c']);
    expect(paginateRecoveries(rows, { page: 3, pageSize: 2 }).validPage).toBe(
      false,
    );
  });
  it('orders jobs by newest instant and ASCII ID without mutating input', () => {
    const original = structuredClone(jobs);
    expect(
      filterJobs(jobs, JobListQuerySchema.parse({ pageSize: '2' })).items.map(
        (job) => job.id,
      ),
    ).toEqual(['c', 'a']);
    expect(jobs).toEqual(original);
  });
  it('filters both job fields and reports out-of-range pages explicitly', () => {
    const result = filterJobs(
      jobs,
      JobListQuerySchema.parse({ type: 'build', status: 'queued', page: '2' }),
    );
    expect(result.total).toBe(1);
    expect(result.items).toEqual([]);
    expect(result.validPage).toBe(false);
  });
  it('normalizes media query and names, uses AND matching and stable ID ties', () => {
    const original = structuredClone(media);
    const result = filterMediaSources(
      media,
      MediaListQuerySchema.parse({ q: ' ＢＥＴＡ  筆記 ', type: 'image' }),
    );
    expect(result.items.map((source) => source.id)).toEqual(['b', 'c']);
    expect(media).toEqual(original);
  });
  it('supports metadata-first paging and rejects overlong normalized queries', () => {
    expect(
      filterMediaSources(
        media,
        MediaListQuerySchema.parse({ page: '2', pageSize: '1' }),
      ).items[0]?.id,
    ).toBe('b');
    expect(() =>
      filterMediaSources(media, { page: 1, pageSize: 20, q: 'a'.repeat(201) }),
    ).toThrow();
  });
});
