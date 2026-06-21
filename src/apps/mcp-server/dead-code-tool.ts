/**
 * `find_dead_code` MCP tool (D6).
 *
 * Lists symbols with no incoming CALLS edge that are neither exported nor
 * entry-point-named — likely-dead-code CANDIDATES. Strictly read-only; never
 * deletes. The summary reports the count and the dynamic-dispatch caveat.
 * Requirements: 15.1, 15.5, 15.6, 15.8
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse, SymbolKind } from "../../core/domain.js";
import { findDeadCode, DEAD_CODE_CAVEAT } from "../../application/querying/dead-code.js";

const VALID_KINDS: SymbolKind[] = [
  "function", "class", "method", "interface",
  "variable", "import", "export", "type",
];

/**
 * Execute the `find_dead_code` MCP tool.
 * Requirements: 15.1, 15.5, 15.6, 15.8
 */
export async function executeFindDeadCode(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const kind = typeof params.kind === "string" && VALID_KINDS.includes(params.kind as SymbolKind)
    ? (params.kind as SymbolKind)
    : undefined;
  const maxResults = typeof params.maxResults === "number" ? params.maxResults : undefined;

  const graph = adapter.getGraphAdapter();
  const result = await findDeadCode(graph, {
    ...(kind ? { kind } : {}),
    ...(maxResults ? { maxResults } : {}),
  });

  const shown = result.candidates.length;
  const kindNote = kind ? ` (kind: ${kind})` : "";
  const cappedNote = result.totalFound > shown
    ? ` (showing first ${shown} of ${result.totalFound})`
    : "";
  // Wave 8 (T1): "kept because" note — explain entry points excluded by the
  // persisted entryPointKind/entryPointReason (Wave 2) so the agent sees WHY an
  // uncalled symbol was not flagged dead. Empty for pre-Wave-2 graphs.
  const kept = result.keptEntryPoints;
  const keptNote = kept.length === 0
    ? ""
    : ` Kept ${kept.length} uncalled entry point${kept.length === 1 ? "" : "s"} (not dead): ` +
      kept
        .slice(0, 5)
        .map((k) => `${k.name} [${k.entryPointKind}${k.entryPointReason ? `: ${k.entryPointReason}` : ""}]`)
        .join("; ") +
      (kept.length > 5 ? `; …and ${kept.length - 5} more` : "") +
      ".";
  const summary = (shown === 0
    ? `No dead-code candidates found${kindNote}. ${DEAD_CODE_CAVEAT}`
    : `Found ${result.totalFound} dead-code candidate${result.totalFound === 1 ? "" : "s"}${kindNote}${cappedNote}. ` +
      `${DEAD_CODE_CAVEAT}`) + keptNote;

  return {
    symbols: result.candidates.map(({ symbol }) => ({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      location: { filePath: symbol.location.filePath, startLine: symbol.location.startLine },
      relationship: "dead-code-candidate",
    })),
    clusters: [],
    processes: [],
    confidence: 0.6,
    riskLevel: "low",
    affectedFlows: [],
    summary,
  };
}
