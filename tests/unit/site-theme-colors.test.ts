import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const component = readFileSync(
  new URL('../../site/src/components/SeoHead.astro', import.meta.url),
  'utf8',
);
const matchedScript = component.match(
  /<script\s+is:inline\s+data-site-theme-colors\s*>([\s\S]*?)<\/script>/u,
)?.[1];
if (!matchedScript) throw new Error('Theme color bootstrap script is missing');
const script = matchedScript;

function fixture(initialTheme?: string) {
  const root = { dataset: { theme: initialTheme } };
  const metas = ['light', 'dark'].map((theme) => {
    const attributes = new Map([
      ['data-site-theme-color', theme],
      ['media', `(prefers-color-scheme: ${theme})`],
      ['content', theme === 'light' ? '#ede8df' : '#252a33'],
    ]);
    return {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
    };
  });
  let changed = () => {};
  let observed: unknown;
  class Observer {
    constructor(callback: () => void) {
      changed = callback;
    }
    observe(target: unknown, options: unknown) {
      observed = { target, options };
    }
  }
  runInNewContext(script, {
    document: {
      documentElement: root,
      querySelectorAll: () => metas,
    },
    MutationObserver: Observer,
  });
  return {
    root,
    metas,
    media: () => metas.map((meta) => meta.getAttribute('media')),
    observed: () => observed,
    change: (theme: string) => {
      root.dataset.theme = theme;
      changed();
    },
  };
}

describe('theme color follows the visible page theme', () => {
  it('keeps OS media queries until the page chooses a theme', () => {
    const page = fixture();
    expect(page.media()).toEqual([
      '(prefers-color-scheme: light)',
      '(prefers-color-scheme: dark)',
    ]);
    page.change('dark');
    expect(page.media()).toEqual(['not all', 'all']);
  });

  it('uses an already restored manual theme without consulting OS or storage', () => {
    const page = fixture('dark');
    expect(page.media()).toEqual(['not all', 'all']);
    expect(page.observed()).toEqual({
      target: page.root,
      options: { attributes: true, attributeFilter: ['data-theme'] },
    });
  });

  it('updates both manual toggle directions without changing the configured colors', () => {
    const page = fixture('light');
    expect(page.media()).toEqual(['all', 'not all']);
    page.change('dark');
    expect(page.media()).toEqual(['not all', 'all']);
    page.change('light');
    expect(page.media()).toEqual(['all', 'not all']);
    expect(page.metas.map((meta) => meta.getAttribute('content'))).toEqual([
      '#ede8df',
      '#252a33',
    ]);
  });
});
