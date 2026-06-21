/**
 * Shared MCP response formatting.
 *
 * Converts a (partial) {@link QueryResult} into the wire {@link MCPToolResponse}
 * shape, always attaching a human-readable `summary` and the `confidence`
 * score. Extracted so multiple tools (`tools.ts`, `detect-changes-tool.ts`,
 * …) reuse one formatter rather than each re-deriving the mapping.
 * Requirements: 15.6, 15.8
 */
import type { MCPToolResponse, NodeRole, RelationType, QueryResult } from "../../core/domain.js";

/** Partial QueryResult without intent field. */
export type PartialQueryResult = Pick<
  QueryResult,
  "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows"
>;

/**
 * D2 explainability fields to merge onto a response symbol, keyed by symbol id.
 * Optional — only impact analysis supplies it; all other tools omit it and the
 * fields stay absent (ADDITIVE, no breakage).
 */
export interface SymbolExplanation {
  readonly nodeRole: NodeRole;
  readonly entryEdge: RelationType;
  readonly hopDistance: number;
}

/**
 * Convert QueryResult to MCPToolResponse format.
 * `explanationsById` (D2) optionally attaches per-symbol role/edge/hop fields.
 * `confidenceById` (Wave 8 · T7) optionally attaches the `[0,1]` edge confidence
 * read off `metadata.confidence` (data-touch edges); absent leaves the symbol
 * unchanged.
 * Requirements: 15.6, 15.8
 */
export function formatMCPResponse(
  result: PartialQueryResult,
  summary: string,
  explanationsById?: ReadonlyMap<string, SymbolExplanation>,
  confidenceById?: ReadonlyMap<string, number>,
): MCPToolResponse {
  return {
    symbols: result.symbols.map((s) => {
      const explanation = explanationsById?.get(s.id);
      const edgeConfidence = confidenceById?.get(s.id);
      return {
        id: s.id,
        name: s.name,
        kind: s.kind,
        location: {
          filePath: s.location.filePath,
          startLine: s.location.startLine,
        },
        relationship: "related", // Default relationship type
        ...(explanation
          ? {
              nodeRole: explanation.nodeRole,
              entryEdge: explanation.entryEdge,
              hopDistance: explanation.hopDistance,
            }
          : {}),
        ...(edgeConfidence !== undefined ? { edgeConfidence } : {}),
      };
    }),
    clusters: result.clusters.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      confidence: c.confidence,
    })),
    processes: result.processes.map((p) => ({
      id: p.id,
      name: p.name,
      stepNumber: 1, // First step
      totalSteps: p.steps.length,
    })),
    confidence: result.confidence,
    riskLevel: result.riskLevel,
    affectedFlows: result.affectedFlows,
    summary, // REQUIRED — human-readable summary (Req 15.8)
  };
}
