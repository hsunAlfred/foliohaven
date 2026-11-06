import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StudioApi } from '../../../studio/src/api.js';
import { useCommand } from '../../../studio/src/hooks.js';

export type CommandHarness = ReturnType<typeof useCommand>;
declare global {
  interface Window {
    commandHarness: CommandHarness;
  }
}

function Harness() {
  const [api] = useState(() => new StudioApi());
  const command = useCommand(api);
  useLayoutEffect(() => {
    window.commandHarness = command;
  }, [command]);
  return (
    <p role="status">
      {command.busy ? '執行中' : command.pending ? '結果未確認' : '就緒'}
    </p>
  );
}
const element = document.getElementById('command-root');
if (!element) throw new Error('Command測試缺少掛載點');
createRoot(element).render(<Harness />);
