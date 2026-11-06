import { describe, expect, it } from 'vitest';
import { runControlledProcess } from '../../server/src/runtime/process.js';

const run = (
  code: string,
  options: Partial<Parameters<typeof runControlledProcess>[0]> = {},
) =>
  runControlledProcess({
    command: process.execPath,
    args: ['-e', code],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    ...options,
  });

describe('controlled build subprocess', () => {
  it('passes binary stdin without shell interpolation', async () => {
    const input = Buffer.from([0, 1, 2, 255, 10]);
    const result = await run('process.stdin.pipe(process.stdout)', { input });
    expect(result.stdout).toEqual(input);
  });
  it('captures bounded output and waits for close', async () => {
    const result = await run(
      "process.stdout.write('ready');process.stderr.write('diagnostic')",
    );
    expect(result.stdout.toString()).toBe('ready');
    expect(result.stderr.toString()).toBe('diagnostic');
  });
  it('returns safe failures without disclosing stderr or private command arguments', async () => {
    await expect(
      run("process.stderr.write('PRIVATE_SENTINEL');process.exit(9)"),
    ).rejects.toMatchObject({ code: 'PROCESS_EXITED' });
    try {
      await run("process.stderr.write('PRIVATE_SENTINEL');process.exit(9)");
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_SENTINEL');
    }
  });
  it('kills an actual process on timeout and after an abort', async () => {
    await expect(
      run('setInterval(()=>{},1000)', { timeoutMs: 40 }),
    ).rejects.toMatchObject({ code: 'PROCESS_TIMEOUT' });
    const controller = new AbortController();
    const pending = run(
      "process.stdout.write('ready');setInterval(()=>{},1000)",
      {
        signal: controller.signal,
        onOutput: () => controller.abort(),
      },
    );
    await expect(pending).rejects.toMatchObject({ code: 'PROCESS_CANCELLED' });
  });
  it('enforces output limits and handles observer failure without uncaught exceptions', async () => {
    await expect(
      run("process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)", {
        maxOutputBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_OUTPUT_LIMIT' });
    await expect(
      run("process.stdout.write('ready');setInterval(()=>{},1000)", {
        onOutput: () => {
          throw new Error('private observer');
        },
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_OBSERVER_FAILED' });
  });
  it('handles unavailable tools and pre-aborted work without spawning persistent children', async () => {
    await expect(
      run('', { command: '/unavailable-build-tool' }),
    ).rejects.toMatchObject({ code: 'PROCESS_UNAVAILABLE' });
    await expect(
      run('', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'PROCESS_CANCELLED' });
  });
  it('sends TERM then KILL to a resistant child and waits for its actual close', async () => {
    let pid: number | undefined;
    const controller = new AbortController();
    await expect(
      run(
        "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)",
        {
          signal: controller.signal,
          onOutput: (_, bytes) => {
            pid = Number(bytes.toString());
            controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'PROCESS_CANCELLED' });
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
  });
});
