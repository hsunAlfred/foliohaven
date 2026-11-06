import { spawn } from 'node:child_process';

/** 固定內部命令的程序群組；停止時等待close，五秒後終止殘留子程序。 */
export function managedProcess(command, args, options = {}) {
  const ownsGroup = options.detached !== false;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: ownsGroup,
    stdio: ['ignore', 'inherit', 'inherit', ...(options.ipc ? ['ipc'] : [])],
  });
  let completed = false;
  const done = new Promise((resolve) => {
    child.once('error', () => undefined);
    child.once('close', (code, signal) => {
      completed = true;
      // wrapper被SIGKILL時仍由存活的owner清同group內所有孫程序。
      if (ownsGroup) signalGroup('SIGKILL');
      resolve({ code, signal });
    });
  });
  const signalGroup = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(ownsGroup ? -child.pid : child.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  let shutdown;
  return {
    child,
    done,
    stop() {
      shutdown ??= (async () => {
        if (!completed) signalGroup('SIGTERM');
        const timer = setTimeout(
          () => signalGroup('SIGKILL'),
          options.stopGraceMs ?? 5_000,
        );
        timer.unref();
        try {
          await done;
        } finally {
          clearTimeout(timer);
          // 主程序已離開也不能留下仍持有群組的孫程序。
          signalGroup('SIGKILL');
        }
      })();
      return shutdown;
    },
  };
}
