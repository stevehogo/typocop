/**
 * Phase 5 — Data flow analysis and process naming.
 *
 * Analyzes data flow between process steps and infers descriptive process names.
 *
 * Requirements: 3.5, 7.5, 7.7
 */
import type { Symbol, Relationship, DataFlowEdge } from "../../types/index.js";
import type { ProcessStep } from "../../types/index.js";

// ─── Data flow analysis ───────────────────────────────────────────────────────

/**
 * Analyze data flow between consecutive steps in a process.
 *
 * Creates a DataFlowEdge for each consecutive pair of steps where a "calls"
 * relationship exists between the two symbols. The dataType is inferred from
 * the callee's signature when available.
 *
 * Requirements: 7.5
 */
export function analyzeDataFlow(
  steps: ProcessStep[],
  relationships: Relationship[],
  symbolMap: Map<string, Symbol>,
): DataFlowEdge[] {
  if (steps.length < 2) return [];

  // Build a quick lookup: source+target → relationship
  const relLookup = new Map<string, Relationship>();
  for (const rel of relationships) {
    if (rel.relType === "calls") {
      relLookup.set(`${rel.source}->${rel.target}`, rel);
    }
  }

  const edges: DataFlowEdge[] = [];

  for (let i = 0; i < steps.length - 1; i++) {
    const from = steps[i].symbolId;
    const to = steps[i + 1].symbolId;

    const rel = relLookup.get(`${from}->${to}`);
    if (!rel) continue;

    const toSymbol = symbolMap.get(to);
    const dataType = inferDataType(toSymbol);

    edges.push({ from, to, ...(dataType ? { dataType } : {}) });
  }

  return edges;
}

/**
 * Infer a data type label from a symbol's signature.
 * Extracts return type annotations like `: UserDto` or `-> User`.
 */
function inferDataType(symbol: Symbol | undefined): string | undefined {
  if (!symbol?.signature) return undefined;

  // TypeScript/Java style: ): ReturnType or : ReturnType
  const tsMatch = symbol.signature.match(/\)\s*:\s*([A-Z]\w+)/);
  if (tsMatch) return tsMatch[1];

  // Python/Rust style: -> ReturnType
  const arrowMatch = symbol.signature.match(/->\s*([A-Z]\w+)/);
  if (arrowMatch) return arrowMatch[1];

  return undefined;
}

// ─── Process naming ───────────────────────────────────────────────────────────

/**
 * Infer a human-readable process name from its entry point and terminal step.
 *
 * Format: "<EntryName> → <TerminalName>"
 *
 * Requirements: 7.7
 */
export function inferProcessName(
  entryPointId: string,
  steps: ProcessStep[],
  symbolMap: Map<string, Symbol>,
): string {
  const entrySymbol = symbolMap.get(entryPointId);
  const entryName = entrySymbol?.name ?? entryPointId;

  if (steps.length === 0) return capitalize(entryName);

  const terminalId = steps[steps.length - 1].symbolId;
  const terminalSymbol = symbolMap.get(terminalId);
  const terminalName = terminalSymbol?.name ?? terminalId;

  if (entryPointId === terminalId) return capitalize(entryName);

  return `${capitalize(entryName)} → ${capitalize(terminalName)}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
