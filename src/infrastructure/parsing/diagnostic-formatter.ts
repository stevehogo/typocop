import type { Diagnostic } from "./diagnostic-collector.js";

const MAX_DIAGNOSTICS = 10;

function formatWarning(diagnostic: Diagnostic): string {
  const header = `[parser] ${diagnostic.filePath}:${diagnostic.line}:${diagnostic.col} — ${diagnostic.message}`;
  return diagnostic.snippet !== undefined
    ? `${header}\n${diagnostic.snippet}`
    : header;
}

function formatTruncation(remaining: number, filePath: string): string {
  return `[parser] … and ${remaining} more error(s) in ${filePath}`;
}

/**
 * Emits one console.warn per diagnostic, capped at 10.
 * Appends a truncation line when diagnostics.length > 10.
 */
export function emitDiagnostics(
  diagnostics: Diagnostic[],
  filePath: string,
): void {
  const visible = diagnostics.slice(0, MAX_DIAGNOSTICS);

  for (const diagnostic of visible) {
    console.warn(formatWarning(diagnostic));
  }

  if (diagnostics.length > MAX_DIAGNOSTICS) {
    const remaining = diagnostics.length - MAX_DIAGNOSTICS;
    console.warn(formatTruncation(remaining, filePath));
  }
}
