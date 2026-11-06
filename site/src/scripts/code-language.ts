export interface CodeLanguageHints {
  readonly codeLanguage?: string | null;
  readonly codeClass?: string;
  readonly preLanguage?: string | null;
  readonly preClass?: string;
}

const languageNames = new Map<string, string>([
  ['bash', 'Bash'],
  ['sh', 'Shell'],
  ['shell', 'Shell'],
  ['zsh', 'Zsh'],
  ['powershell', 'PowerShell'],
  ['ps1', 'PowerShell'],
  ['rust', 'Rust'],
  ['rs', 'Rust'],
  ['python', 'Python'],
  ['py', 'Python'],
  ['javascript', 'JavaScript'],
  ['js', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['ts', 'TypeScript'],
  ['jsx', 'JSX'],
  ['tsx', 'TSX'],
  ['json', 'JSON'],
  ['jsonc', 'JSONC'],
  ['yaml', 'YAML'],
  ['yml', 'YAML'],
  ['toml', 'TOML'],
  ['html', 'HTML'],
  ['xml', 'XML'],
  ['css', 'CSS'],
  ['scss', 'SCSS'],
  ['sql', 'SQL'],
  ['docker', 'Dockerfile'],
  ['dockerfile', 'Dockerfile'],
  ['nginx', 'Nginx'],
  ['apache', 'Apache'],
  ['apacheconf', 'Apache'],
  ['go', 'Go'],
  ['golang', 'Go'],
  ['java', 'Java'],
  ['php', 'PHP'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['c++', 'C++'],
  ['csharp', 'C#'],
  ['c#', 'C#'],
  ['cs', 'C#'],
  ['text', '純文字'],
  ['txt', '純文字'],
  ['plain', '純文字'],
  ['plaintext', '純文字'],
  ['none', '純文字'],
]);

function explicitLabel(hint: string | null | undefined): string | undefined {
  const token = hint
    ?.trim()
    .replace(/^(?:language|lang)-/iu, '')
    .toLowerCase();
  if (!token) return undefined;
  if (!/^[a-z0-9_+#.-]+$/u.test(token)) return '純文字';
  return languageNames.get(token) ?? token.toUpperCase();
}

function classHint(classes: string | undefined): string | undefined {
  return /(?:^|\s)(?:language|lang)-([a-z0-9_+#.-]+)(?=\s|$)/iu.exec(
    classes ?? '',
  )?.[1];
}

/** Author hints win; infer only distinctive Rust/Python syntax when absent. */
export function resolveCodeLanguage(
  source: string,
  hints: CodeLanguageHints = {},
): string {
  for (const hint of [
    hints.codeLanguage,
    classHint(hints.codeClass),
    hints.preLanguage,
    classHint(hints.preClass),
  ]) {
    const label = explicitLabel(hint);
    if (label !== undefined) return label;
  }

  const rustFunction =
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+[a-z_]\w*(?:\s*<[^{};]*>)?\s*\(/mu;
  const rustSyntax =
    /(?:->|:\s*(?:[uif]\d+|usize|isize|bool|&|Vec\b)|\blet\s+mut\b)/u;
  if (
    rustFunction.test(source) &&
    rustSyntax.test(source) &&
    source.includes('{')
  )
    return 'Rust';

  const pythonImport = /^\s*(?:import\s+[\w.]+|from\s+[\w.]+\s+import\s+)/mu;
  const pythonDefinition = /^\s*(?:async\s+)?(?:def|class)\s+\w+[^\n]*:\s*$/mu;
  if (pythonImport.test(source) && pythonDefinition.test(source))
    return 'Python';

  return '純文字';
}
