/**
 * Query result formatting.
 * Requirements: 9.4, 9.5
 */
import type { QueryResult } from "../../core/domain.js";

/**
 * Format a QueryResult into a human-readable string.
 * Requirements: 9.4, 9.5
 */
export function formatResponse(result: QueryResult): string {
  const lines: string[] = [];

  lines.push(`Intent: ${result.intent.type}`);
  lines.push(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
  lines.push(`Risk Level: ${result.riskLevel.toUpperCase()}`);
  lines.push("");

  if (result.symbols.length > 0) {
    lines.push(`Symbols (${result.symbols.length}):`);
    for (const sym of result.symbols.slice(0, 10)) {
      lines.push(`  - ${sym.kind} ${sym.name} (${sym.location.filePath}:${sym.location.startLine})`);
    }
    if (result.symbols.length > 10) {
      lines.push(`  ... and ${result.symbols.length - 10} more`);
    }
    lines.push("");
  }

  if (result.relationships.length > 0) {
    lines.push(`Relationships: ${result.relationships.length}`);
    lines.push("");
  }

  if (result.clusters.length > 0) {
    lines.push(`Clusters (${result.clusters.length}):`);
    for (const cluster of result.clusters.slice(0, 5)) {
      lines.push(`  - ${cluster.name} (${cluster.category}, confidence: ${(cluster.confidence * 100).toFixed(0)}%)`);
    }
    lines.push("");
  }

  if (result.processes.length > 0) {
    lines.push(`Processes (${result.processes.length}):`);
    for (const proc of result.processes.slice(0, 5)) {
      lines.push(`  - ${proc.name} (${proc.steps.length} steps)`);
    }
    lines.push("");
  }

  if (result.affectedFlows.length > 0) {
    lines.push(`Affected Flows: ${result.affectedFlows.join(", ")}`);
  }

  return lines.join("\n");
}
