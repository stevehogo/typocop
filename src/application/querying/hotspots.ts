/**
 * Complexity hotspots query (E2).
 *
 * Returns :Symbol nodes ranked by persisted cyclomatic complexity (stored as a
 * STRING prop, coerced with `toInteger`), filtered to those above a minimum
 * threshold, ordered DESC and paged with SKIP/LIMIT. Strictly READ-ONLY.
 *
 * Symbols indexed before E2 (no complexity prop) coerce to 0 via the default
 * persisted value, so they fall below any positive `minComplexity` and never
 * pollute the ranking.
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { prop } from "../../core/ports/persistence.js";
import type { Symbol } from "../../core/domain.js";
import { graphNodeToSymbol, rowToNode } from "./graph-helpers.js";
import type { CypherNodeRow } from "./graph-helpers.js";

/** Options for {@link findHotspots}. */
export interface FindHotspotsOptions {
  /** Minimum cyclomatic complexity (inclusive lower bound is `> minComplexity`). */
  readonly minComplexity?: number;
  /** Page size cap on returned hotspots. */
  readonly maxResults?: number;
  /** Number of rows to skip (paging offset). */
  readonly offset?: number;
}

/** A single complexity hotspot: a symbol plus its three metrics. */
export interface Hotspot {
  readonly symbol: Symbol;
  readonly cyclomatic: number;
  readonly cognitive: number;
  readonly maxLoopDepth: number;
}

/** Result of a {@link findHotspots} query. */
export interface HotspotsResult {
  readonly hotspots: readonly Hotspot[];
}

const DEFAULT_MIN_COMPLEXITY = 10;
const DEFAULT_MAX_RESULTS = 50;

/**
 * Find complexity hotspots: the most cyclomatically-complex symbols above a
 * threshold, ordered DESC and paged.
 *
 * @param graph   graph adapter
 * @param options `minComplexity`, `maxResults`, and `offset`
 */
export async function findHotspots(
  graph: GraphAdapter,
  options: FindHotspotsOptions = {},
): Promise<HotspotsResult> {
  const min = options.minComplexity !== undefined && options.minComplexity >= 0
    ? options.minComplexity
    : DEFAULT_MIN_COMPLEXITY;
  const limit = options.maxResults && options.maxResults > 0
    ? options.maxResults
    : DEFAULT_MAX_RESULTS;
  const skip = options.offset && options.offset > 0 ? options.offset : 0;

  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (s:Symbol)
     WHERE toInteger(s.cyclomatic) > $min
     RETURN s AS n
     ORDER BY toInteger(s.cyclomatic) DESC, s.id ASC
     SKIP $skip LIMIT $limit`,
    { min, skip, limit },
  ) ?? [];

  const hotspots: Hotspot[] = [];
  for (const row of rows) {
    if (!row?.n?.properties) continue;
    const node = rowToNode(row);
    const symbol = graphNodeToSymbol(node);
    hotspots.push({
      symbol,
      cyclomatic: parseInt(prop(node, "cyclomatic", "0"), 10) || 0,
      cognitive: parseInt(prop(node, "cognitive", "0"), 10) || 0,
      maxLoopDepth: parseInt(prop(node, "maxLoopDepth", "0"), 10) || 0,
    });
  }

  return { hotspots };
}
