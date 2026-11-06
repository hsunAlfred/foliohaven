import ts from 'typescript';

let cachedSource: string | undefined;
let cachedScript: string | undefined;

/** Compile the standalone bootstrap once per source version, during rendering. */
export function compileReadingHistory(source: string): string {
  if (cachedSource === source && cachedScript !== undefined)
    return cachedScript;
  const result = ts.transpileModule(source, {
    fileName: 'reading-history.ts',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleDetection: ts.ModuleDetectionKind.Legacy,
      removeComments: true,
    },
  });
  const errors = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors?.length)
    throw new Error(
      errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        )
        .join('\n'),
    );
  cachedSource = source;
  // Static project code embedded in an HTML script, never author content.
  cachedScript = result.outputText.replace(/<\/script/giu, '<\\/script');
  return cachedScript;
}
