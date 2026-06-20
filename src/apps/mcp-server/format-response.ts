/**
 * Shared MCP response formatting.
 *
 * Converts a (partial) {@link QueryResult} into the wire {@link MCPToolResponse}
 * shape, always attaching a human-readable `summary` and the `confidence`
 * score. Extracted so multiple tools (`tools.ts`, `detect-changes-tool.ts`,
 * …) reuse one formatter rather than each re-deriving the mapping.
 * Requirements: 15.6, 15.8
 */
import type { MCPToolResponse, QueryResult } from "../../core/domain.js";

/** Partial QueryResult without intent field. */
export type PartialQueryResult = Pick<
  QueryResult,
  "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows"
>;

/**
 * Convert QueryResult to MCPToolResponse format.
 * Requirements: 15.6, 15.8
 */
export function formatMCPResponse(result: PartialQueryResult, summary: string): MCPToolResponse {
  return {
    symbols: result.symbols.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      location: {
        filePath: s.location.filePath,
        startLine: s.location.startLine,
      },
      relationship: "related", // Default relationship type
    })),
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
