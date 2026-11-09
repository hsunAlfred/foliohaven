import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runControlledProcess } from '../../server/src/runtime/process.js';
import { buildProcessEnvironment } from '../../server/src/runtime/environment.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
it.each([
  { values: { FOLIOHAVEN_RENDER_OUTPUT: '' }, code: 'RENDER_OUTPUT_INVALID' },
  {
    values: { FOLIOHAVEN_RENDER_OUTPUT: 'relative-output' },
    code: 'RENDER_OUTPUT_INVALID',
  },
  {
    values: { FOLIOHAVEN_RENDER_CONTEXT: '' },
    code: 'RENDER_CONTEXT_REQUIRED',
  },
  {
    values: { FOLIOHAVEN_RENDER_CONTEXT: 'relative-context' },
    code: 'RENDER_CONTEXT_REQUIRED',
  },
])(
  'rejects invalid canonical render value $values without falling back to the legacy value',
  async ({ values, code }) => {
    const result = await runControlledProcess({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      try { await import(${JSON.stringify(new URL('../../site/astro.config.ts', import.meta.url).href)}); }
      catch (error) { console.log(error.message.split('：')[0]); }
    `,
      ],
      cwd: root,
      env: buildProcessEnvironment({
        ALFRED_RENDER_CONTEXT: '/legacy-context-that-must-not-be-read',
        ALFRED_RENDER_OUTPUT: '/legacy-output-that-must-not-be-used',
        FOLIOHAVEN_RENDER_OUTPUT: '/canonical-output',
        ...values,
      }),
      timeoutMs: 15_000,
    });
    expect(result.stdout.toString().trim()).toBe(code);
  },
);
