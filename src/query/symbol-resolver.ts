/**
 * Centralized symbol resolution with exact → fuzzy fallback and
 * "Did you mean?" suggestions. Replaces the duplicated `findNode`
 * functions across context-retrieval, impact-analysis, and data-flow-trace.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.5, 2.6
 */

import type { GraphAdapter, GraphNode } from "../core/ports/persistence.js";
import { prop } from "../core/ports/persistence.js";
import type { CypherNodeRow } from "./graph-helpers.js";
import { rowToNode } from "./graph-helpers.js";
import { levenshteinDistance } from "./levenshtein.js";

/** Discriminated union for resolution outcomes (Req 1.6). */
export type SymbolResolution =
  | { readonly kind: "exact"; readonly node: GraphNode }
  | { readonly kind: "fuzzy"; readonly node: GraphNode; readonly matchedName: string }
  | { readonly kind: "not_found"; readonly suggestions: readonly string[] };

/**
 * Resolve a symbol by name or ID with exact → fuzzy CONTAINS fallback.
 *
 * 1. Exact match on `n.id` or `n.name` (Req 1.1, 1.4)
 * 2. Fuzzy CONTAINS on `n.name`, picking shortest match (Req 1.2, 1.3)
 * 3. Not-found with Levenshtein-ranked suggestions (Req 2.1, 2.2)
 */
export async function resolveSymbol(
  nameOrId: string,
  graph: GraphAdapter,
): Promise<SymbolResolution> {
  // Step 1: Exact match (current behavior — Req 1.1, 1.4)
  const exactRows = await graph.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol) WHERE n.id = $val OR n.name = $val RETURN n LIMIT 1`,
    { val: nameOrId },
  );

  if (exactRows.length > 0) {
    return { kind: "exact", node: rowToNode(exactRows[0]) };
  }

  // Step 2: Fuzzy fallback — CONTAINS on name (Req 1.2, 1.3)
  const fuzzyRows = await graph.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol) WHERE n.name CONTAINS $val RETURN n`,
    { val: nameOrId },
  );

  if (fuzzyRows.length > 0) {
    // Pick the shortest name — closest to what the user likely meant (Req 1.3)
    const nodes = fuzzyRows.map(rowToNode);
    const best = nodes.reduce((a, b) =>
      prop(a, "name").length <= prop(b, "name").length ? a : b,
    );
    return { kind: "fuzzy", node: best, matchedName: prop(best, "name") };
  }

  // Step 3: No match — gather suggestions (Req 2.1, 2.2)
  const suggestions = await suggestSimilarSymbols(nameOrId, graph, 5);
  return { kind: "not_found", suggestions };
}

/**
 * Find similar symbol names for "Did you mean?" suggestions.
 * Ranks by ascending Levenshtein distance (Req 2.2).
 * Limits candidate set to 1000 names for performance (Req 2.6).
 */
export async function suggestSimilarSymbols(
  input: string,
  graph: GraphAdapter,
  limit: number = 5,
): Promise<readonly string[]> {
  const rows = await graph.runCypher<{ name: string }>(
    `MATCH (n:Symbol) RETURN DISTINCT n.name AS name LIMIT 1000`,
    {},
  );

  const names = rows.map((r) => r.name).filter(Boolean);
  const inputLower = input.toLowerCase();

  const scored = names.map((name) => ({
    name,
    distance: levenshteinDistance(inputLower, name.toLowerCase()),
  }));

  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, limit).map((s) => s.name);
}
