import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, readFile, readlink, rename } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { buildProcessEnvironment } from '../../../server/src/runtime/environment.js';
import { runControlledProcess } from '../../../server/src/runtime/process.js';

export const devPorts = [4321, 5173, 3001] as const;
export type DevMode = 'all' | 'site' | 'studio' | 'server';
const delay = (milliseconds: number) =>
  new Promise<void>((done) => setTimeout(done, milliseconds));

export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(150);
  }
  throw new Error(`DEV_TEST_TIMEOUT：${label}`);
}
export async function request(port: number, path = '/') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(2_000),
    headers: { 'Cache-Control': 'no-cache' },
  });
  return { status: response.status, text: await response.text() };
}
export async function responds(port: number, path = '/') {
  try {
    return (await request(port, path)).status === 200;
  } catch {
    return false;
  }
}
export async function portAvailable(port: number) {
  const server = createServer();
  return new Promise<boolean>((done) => {
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

/** 僅辨識本測試臨時工作區的程序，不輸出 argv、環境或記憶體 token。 */
export async function ownedProcesses(root: string) {
  if (!/^\/tmp\/alfred-committed-workspace-[A-Za-z0-9]+$/u.test(root))
    throw new Error('DEV_TEST_WORKSPACE_INVALID');
  const owned: { pid: number; parentPid: number; args: readonly string[] }[] =
    [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const cwd = await readlink(`/proc/${entry}/cwd`);
      if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
      const args = (await readFile(`/proc/${entry}/cmdline`))
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      const parentPid = Number(
        (await readFile(`/proc/${entry}/status`, 'utf8')).match(
          /^PPid:\s+(\d+)$/mu,
        )?.[1],
      );
      if (!Number.isSafeInteger(parentPid)) continue;
      owned.push({ pid: Number(entry), parentPid, args });
    } catch {
      // 程序在列舉期間結束，或不屬於可讀取的測試身分。
    }
  }
  return owned;
}
export async function cleanupOwnedProcesses(root: string) {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const { pid } of await ownedProcesses(root)) {
      // 每輪重新比對cwd，避免重用PID或誤碰另一工作區。
      try {
        const cwd = await readlink(`/proc/${pid}/cwd`);
        if (cwd === root || cwd.startsWith(`${root}/`))
          process.kill(pid, signal);
      } catch {
        /* 已結束的自有程序不用再次終止。 */
      }
    }
    await delay(signal === 'SIGTERM' ? 1_000 : 100);
  }
}

type OwnedProcess = Awaited<ReturnType<typeof ownedProcesses>>[number];
function descendsFrom(
  candidate: OwnedProcess,
  ancestor: OwnedProcess,
  processes: readonly OwnedProcess[],
) {
  let current = candidate;
  const visited = new Set<number>();
  while (!visited.has(current.pid)) {
    if (current.parentPid === ancestor.pid) return true;
    visited.add(current.pid);
    const parent = processes.find(
      (process) => process.pid === current.parentPid,
    );
    if (parent === undefined) return false;
    current = parent;
  }
  return false;
}

/** 較長的合法測試影片提供可觀察的真轉碼期間，不加入產品測試hook。 */
export async function replaceSandboxVideo(root: string) {
  const stage = resolve(root, '.alfred/dev-test');
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const output = resolve(stage, 'replacement.mp4');
  await runControlledProcess({
    command: 'ffmpeg',
    args: [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24:duration=12',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-map_metadata',
      '-1',
      '-y',
      output,
    ],
    cwd: root,
    env: buildProcessEnvironment(),
    timeoutMs: 30_000,
  });
  await rename(
    output,
    resolve(
      root,
      'media/source/68789bc2-e491-4dbe-81de-f1a42adb7234/original.mp4',
    ),
  );
}

export function startDev(root: string, mode: DevMode) {
  const child: ChildProcess = spawn(
    'pnpm',
    [mode === 'all' ? 'dev' : `dev:${mode}`],
    {
      cwd: resolve(root),
      env: buildProcessEnvironment(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let exited = false;
  const collect = (chunk: Buffer) => {
    if (output.length < 4 * 1024 * 1024) output += chunk.toString('utf8');
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((complete) => {
    child.once('error', () => undefined);
    child.once('close', (code, signal) => {
      exited = true;
      complete({ code, signal });
    });
  });
  const supervisor = async () => {
    const processes = await ownedProcesses(root);
    return processes.find((process) => process.args.includes('scripts/dev.mjs'))
      ?.pid;
  };
  return {
    done,
    get exited() {
      return exited;
    },
    get ready() {
      return output.includes('開發環境已就緒');
    },
    get safeCodes() {
      return [...new Set(output.match(/\bDEV_[A-Z_]+\b/gu) ?? [])];
    },
    async readyOrFail() {
      await waitUntil(
        () => {
          if (exited)
            throw new Error(`DEV_TEST_EXITED：${this.safeCodes.join(',')}`);
          return this.ready;
        },
        `啟動${mode}`,
        100_000,
      );
    },
    async signal(signal: NodeJS.Signals) {
      const pid = await supervisor();
      if (pid === undefined) throw new Error('DEV_TEST_SUPERVISOR_MISSING');
      process.kill(pid, signal);
    },
    async killTypesTask() {
      const processes = await ownedProcesses(root);
      const wrapper = processes.find(
        (candidate) =>
          candidate.args.includes('scripts/dev-task.mjs') &&
          processes.some(
            (inner) =>
              inner.parentPid === candidate.pid &&
              inner.args.includes('node_modules/typescript/bin/tsc') &&
              inner.args.includes('--watch'),
          ),
      );
      if (wrapper === undefined) throw new Error('DEV_TEST_TYPES_TASK_MISSING');
      process.kill(wrapper.pid, 'SIGKILL');
    },
    async killDuringBootstrap() {
      let guardian: OwnedProcess | undefined;
      await waitUntil(
        async () => {
          if (exited || this.ready)
            throw new Error('DEV_TEST_BOOTSTRAP_WINDOW_MISSED');
          const processes = await ownedProcesses(root);
          const compiler = processes.find(
            (candidate) =>
              !candidate.args.includes('--watch') &&
              candidate.args.some((argument) =>
                /(?:^|\/)typescript\/bin\/tsc$/u.test(argument),
              ),
          );
          const packageCommand = processes.find((candidate) =>
            candidate.args.includes('build:packages'),
          );
          guardian = processes.find(
            (candidate) =>
              candidate.args.includes('scripts/dev-task.mjs') &&
              packageCommand?.parentPid === candidate.pid &&
              compiler !== undefined &&
              descendsFrom(compiler, candidate, processes),
          );
          return guardian !== undefined;
        },
        '真正bootstrap guardian與編譯器執行中',
        30_000,
      );
      if (guardian === undefined || this.ready)
        throw new Error('DEV_TEST_BOOTSTRAP_NOT_OBSERVED');
      await this.signal('SIGKILL');
    },
    async killRenderTaskDuringTranscode() {
      let guardian: OwnedProcess | undefined;
      await waitUntil(
        async () => {
          if (exited)
            throw new Error('DEV_TEST_RENDER_EXITED_BEFORE_TRANSCODE');
          const processes = await ownedProcesses(root);
          const renderer = processes.find(
            (candidate) =>
              candidate.args.includes('scripts/render-dev.mjs') &&
              candidate.args.includes('--once') &&
              candidate.args.includes('--parent-pipe'),
          );
          const transcode = processes.find((candidate) =>
            candidate.args.includes('libvpx-vp9'),
          );
          const watcher = processes.find(
            (candidate) =>
              candidate.args.includes('scripts/render-dev.mjs') &&
              !candidate.args.includes('--once'),
          );
          guardian = processes.find(
            (candidate) =>
              candidate.args.includes('scripts/dev-task.mjs') &&
              watcher?.parentPid === candidate.pid &&
              renderer !== undefined &&
              renderer.parentPid === watcher.pid &&
              transcode !== undefined &&
              descendsFrom(transcode, renderer, processes),
          );
          return guardian !== undefined;
        },
        '單次render與真正VP9轉碼執行中',
        45_000,
      );
      if (guardian === undefined)
        throw new Error('DEV_TEST_RENDER_TASK_MISSING');
      process.kill(guardian.pid, 'SIGKILL');
    },
    async stop() {
      if (!exited) {
        const pid = await supervisor();
        if (pid !== undefined) process.kill(pid, 'SIGTERM');
      }
      await waitUntil(() => exited, '協調器停止', 20_000);
      return done;
    },
  };
}
