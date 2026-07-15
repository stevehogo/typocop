/**
 * Self-shadowing recursion REPORT (no DB).
 *
 * Walks a repo, parses + resolves in memory (producing `overrides` edges), runs
 * the pure detector, and renders a compact table of suspect locations + the
 * offending call text. Read-only; persists nothing.
 */
import { walkFileTree } from "./structure/index.js";
import { extractAllSymbols } from "./parsing/index.js";
import { resolveReferences } from "./resolution/index.js";
import { detectRecursionSuspects } from "./resolution/recursion-suspects.js";
import type { Symbol, Language } from "../../core/domain.js";

export interface RecursionFinding {
  readonly index: number;
  readonly filePath: string;
  readonly line: number;     // 1-based
  readonly methodName: string;
  readonly buggyCall: string;
}

// Fallback render of the self-call when the parser didn't capture callText.
const SELF_CALL: Partial<Record<Language, (m: string) => string>> = {
  typescript: (m) => `this.${m}()`,   javascript: (m) => `this.${m}()`,
  java: (m) => `this.${m}()`,         swift: (m) => `self.${m}()`,
  python: (m) => `self.${m}()`,       php: (m) => `$this->${m}()`,
  csharp: (m) => `this.${m}()`,       cpp: (m) => `this->${m}()`,
  ruby: (m) => m,
};
const defaultSelfCall = (m: string) => `this.${m}()`;

export interface ScanRecursionOptions {
  /** Index `vendor/` too, so signal A can resolve framework base classes. Slow. */
  readonly includeVendor?: boolean;
}

export async function scanRecursionSuspects(
  rootPath: string,
  options: ScanRecursionOptions = {},
): Promise<RecursionFinding[]> {
  const fileNodes = await walkFileTree(rootPath, undefined, { includeVendor: options.includeVendor });
  const { symbols, hints } = await extractAllSymbols(fileNodes, rootPath);
  const { relationships } = await resolveReferences(symbols, hints, rootPath, fileNodes.map((f) => f.path));

  const byId = new Map<string, Symbol>();
  for (const s of symbols) byId.set(s.id, s);

  return detectRecursionSuspects(symbols, hints, relationships).map((suspect, i) => {
    const caller = byId.get(suspect.callerId);
    const methodName = caller?.name ?? "";
    const render = SELF_CALL[suspect.language] ?? defaultSelfCall;
    return {
      index: i + 1,
      filePath: caller?.location.filePath ?? "",
      line: suspect.callLine + 1, // hints are 0-based; report 1-based
      methodName,
      buggyCall: (suspect.callText ?? render(methodName)).replace(/\s+/g, " ").trim(),
    };
  });
}

export function formatRecursionReport(
  findings: readonly RecursionFinding[],
  opts: { json?: boolean } = {},
): string {
  if (opts.json) return JSON.stringify(findings);
  if (findings.length === 0) return "No self-recursion issues found.";
  const head = "| # | Location | Buggy call |\n|---|----------|-----------|";
  const rows = findings.map(
    (f) => `| **${f.index}** | \`${f.filePath}:${f.line}\` \`${f.methodName}()\` | \`${f.buggyCall}\` |`,
  );
  const n = findings.length;
  return [head, ...rows].join("\n") + `\n\n${n} issue${n === 1 ? "" : "s"} found.`;
}
