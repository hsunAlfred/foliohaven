import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../../server/src/jobs/index.js';

const fixtures: { root: string; jobs: JobManager }[] = [];
const releases: (() => void)[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alfred-jobs-idle-'));
  const jobs = new JobManager({ repositoryRoot: root });
  fixtures.push({ root, jobs });
  await jobs.initialize();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return jobs;
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const { jobs } of fixtures) await jobs.close();
  vi.useRealTimers();
  for (const { root } of fixtures.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('idle job scheduler backoff', () => {
  it('reduces idle history scans while retaining a five-second safety poll for other processes', async () => {
    const jobs = await fixture();
    const claim = vi.spyOn(jobs, 'runNext').mockResolvedValue(null);
    jobs.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim.mock.calls.length).toBeLessThanOrEqual(12);
    await vi.advanceTimersByTimeAsync(6_750);
    const calls = claim.mock.calls.length;
    // Four workers at a fixed 250ms would have made over 120 scans by now.
    expect(calls).toBeLessThanOrEqual(24);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(claim).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(calls + 4);
  });

  it('wakes idle workers immediately after a real queued job is durably created', async () => {
    const jobs = await fixture();
    const claim = vi.spyOn(jobs, 'runNext').mockResolvedValue(null);
    jobs.start();
    await vi.advanceTimersByTimeAsync(7_750);
    const calls = claim.mock.calls.length;
    const clock = Date.now();
    const queued = await jobs.create({
      type: 'build',
      payload: {},
      sourceRevision: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(Date.now()).toBe(clock);
    expect(claim.mock.calls.length).toBeGreaterThan(calls);
    expect(await jobs.get(queued.id)).toMatchObject({ status: 'queued' });
  });

  it('does not lose a create notification while workers are still finishing an empty claim', async () => {
    const jobs = await fixture();
    let release: () => void = () => undefined;
    const pendingClaim = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.push(release);
    let calls = 0;
    vi.spyOn(jobs, 'runNext').mockImplementation(async () => {
      if (++calls <= 4) await pendingClaim;
      return null;
    });
    jobs.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(4);
    const clock = Date.now();
    await jobs.create({ type: 'build', payload: {}, sourceRevision: null });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(Date.now()).toBe(clock);
    expect(calls).toBeGreaterThanOrEqual(8);
  });

  it('closes idle workers without waiting for the five-second backoff timer', async () => {
    const jobs = await fixture();
    vi.spyOn(jobs, 'runNext').mockResolvedValue(null);
    jobs.start();
    await vi.advanceTimersByTimeAsync(7_750);
    const clock = Date.now();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await jobs.close();
    expect(Date.now()).toBe(clock);
    expect(vi.getTimerCount()).toBe(0);
  });
});
