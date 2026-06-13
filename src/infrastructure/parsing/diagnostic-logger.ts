import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "./diagnostic-collector.js";

const DEFAULT_LOG_FILENAME = "typocop-diagnostics.log";

function resolveLogPath(): string {
  const envPath = process.env["TYPOCOP_LOG_FILE"];
  if (envPath) return envPath;
  return join(process.cwd(), DEFAULT_LOG_FILENAME);
}

function serializeDiagnostic(diagnostic: Diagnostic): string {
  const entry: Record<string, string | number> = {
    filePath: diagnostic.filePath,
    line: diagnostic.line,
    col: diagnostic.col,
    message: diagnostic.message,
  };
  if (diagnostic.snippet !== undefined) {
    entry["snippet"] = diagnostic.snippet;
  }
  return JSON.stringify(entry);
}

/**
 * Write all diagnostics to a log file in NDJSON format.
 * Overwrites the file on each run. On write failure, emits a console.warn
 * with the reason and returns without throwing.
 */
export async function logDiagnostics(diagnostics: Diagnostic[]): Promise<void> {
  const logPath = resolveLogPath();
  const content = diagnostics.map(serializeDiagnostic).join("\n") + "\n";

  try {
    await writeFile(logPath, content, { encoding: "utf8", flag: "a" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[parser] Failed to write diagnostics log to ${logPath}: ${reason}`);
  }
}
