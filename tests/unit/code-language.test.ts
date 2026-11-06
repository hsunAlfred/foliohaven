import { describe, expect, it } from 'vitest';
import { resolveCodeLanguage } from '../../site/src/scripts/code-language.js';

const genericRust = `fn outer<T: Clone>(value: T) -> T {
    fn inner<U: Clone>(input: U) -> U {
        input.clone()
    }
    let result: T = inner(value);
    result
}`;

describe('resolveCodeLanguage', () => {
  it('prefers code attributes, code classes, pre attributes and pre classes in that order', () => {
    expect(
      resolveCodeLanguage(genericRust, {
        codeLanguage: 'python',
        codeClass: 'highlight language-rust',
        preLanguage: 'bash',
        preClass: 'language-json',
      }),
    ).toBe('Python');
    expect(
      resolveCodeLanguage(genericRust, {
        codeLanguage: null,
        codeClass: 'highlight lang-rs extra',
        preLanguage: 'python',
        preClass: 'language-json',
      }),
    ).toBe('Rust');
    expect(
      resolveCodeLanguage(genericRust, {
        preLanguage: 'toml',
        preClass: 'language-json',
      }),
    ).toBe('TOML');
    expect(
      resolveCodeLanguage(genericRust, {
        preClass: 'highlight language-json',
      }),
    ).toBe('JSON');
  });

  it('keeps the established explicit aliases and distinguishes Bash from Shell', () => {
    for (const [hint, label] of [
      ['rs', 'Rust'],
      ['bash', 'Bash'],
      ['sh', 'Shell'],
      ['shell', 'Shell'],
      ['py', 'Python'],
      ['json', 'JSON'],
      ['toml', 'TOML'],
    ] as const)
      expect(resolveCodeLanguage('example', { codeLanguage: hint }), hint).toBe(
        label,
      );
  });

  it('never overrides an explicit plain-text hint with source inference', () => {
    for (const hint of ['text', 'txt', 'plaintext', 'plain', 'none'])
      expect(
        resolveCodeLanguage(genericRust, {
          codeLanguage: hint,
          codeClass: 'language-rust',
          preLanguage: 'python',
        }),
        hint,
      ).toBe('純文字');
    expect(
      resolveCodeLanguage('{"rounds":10000}', {
        codeClass: 'language-text',
        preLanguage: 'json',
      }),
    ).toBe('純文字');
  });

  it('preserves an explicit unknown language identifier instead of guessing', () => {
    expect(resolveCodeLanguage(genericRust, { codeLanguage: 'sql' })).toBe(
      'SQL',
    );
    expect(resolveCodeLanguage(genericRust, { preClass: 'lang-diff' })).toBe(
      'DIFF',
    );
  });

  it('recognizes Rust with nested generic functions and typed parameters without hints', () => {
    expect(resolveCodeLanguage(genericRust)).toBe('Rust');
  });

  it('recognizes Python only when imports accompany function syntax', () => {
    const source = `import json
from pathlib import Path

def read_config(path: Path) -> dict:
    return json.loads(path.read_text())`;
    expect(resolveCodeLanguage(source)).toBe('Python');
  });

  it('leaves ambiguous settings, data, diagrams, prose, pseudocode and commands as plain text', () => {
    for (const source of [
      'rounds = 10000\nworkers = 4',
      '{"rounds":10000,"enabled":true}',
      '[package]\nname = "example"\nversion = "0.1.0"',
      'Client\n  |\nCloudflare -> Origin\n',
      'Use fn main() in Rust and import tools in Python.',
      'BEGIN\n  READ balance\n  IF balance >= amount THEN\n    WRITE balance - amount\n  END IF\nCOMMIT',
      'python3 scripts/build.py\ncargo run --release\ndocker compose up -d',
      'import os\nprint(os.getcwd())',
    ])
      expect(resolveCodeLanguage(source), source).toBe('純文字');
  });
});
