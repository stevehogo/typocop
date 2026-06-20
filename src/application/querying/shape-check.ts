/**
 * E3 — API contract drift (`shape_check`).
 *
 * Pairs route handlers (which carry the top-level `responseKeys` of the JSON
 * body they return) against consumers (which carry the property `accessedKeys`
 * they read off a fetched value) and reports a MISMATCH for every key a consumer
 * reads that NO route returns.
 *
 * v1 — TOP-LEVEL keys only. Cross-linking a consumer to a specific route is not
 * attempted (that needs call-graph fetch tracking); instead a consumer's reads
 * are checked against the UNION of all route response keys, and confidence is
 * downgraded to `low` when a consumer file fetches more than one route (R9 —
 * the union is then ambiguous, so a "missing" key may simply belong to a route
 * the consumer never actually calls).
 *
 * Pure data in / data out — no DB or AST. The graph-querying driver lives in the
 * MCP tool layer (`apps/mcp-server/shape-check-tool.ts`).
 */

/** A route handler and the top-level keys of the body it returns. */
export interface RouteShape {
  readonly symbolId: string;
  readonly name: string;
  readonly filePath: string;
  readonly responseKeys: readonly string[];
}

/** A consumer symbol and the property keys it reads off a fetched value. */
export interface ConsumerShape {
  readonly symbolId: string;
  readonly name: string;
  readonly filePath: string;
  readonly accessedKeys: readonly string[];
  /**
   * How many distinct routes this consumer's FILE fetches. >1 downgrades every
   * mismatch from this consumer to `low` confidence (R9). Defaults to 1.
   */
  readonly routesFetchedInFile?: number;
}

/** A single contract-drift finding. */
export interface ShapeMismatch {
  readonly consumerId: string;
  readonly consumerName: string;
  readonly filePath: string;
  /** The key the consumer reads that no route returns. */
  readonly key: string;
  /** All keys any route returns (sorted) — the available surface. */
  readonly availableKeys: readonly string[];
  readonly confidence: "high" | "low";
}

/** Result of {@link shapeCheck}. */
export interface ShapeCheckResult {
  readonly pairsChecked: number;
  readonly mismatches: readonly ShapeMismatch[];
}

/**
 * Compare consumer key reads against the union of route response shapes.
 *
 * @param routes    routes carrying `responseKeys`
 * @param consumers consumers carrying `accessedKeys`
 */
export function shapeCheck(
  routes: readonly RouteShape[],
  consumers: readonly ConsumerShape[],
): ShapeCheckResult {
  // Union of every key any route returns — the keys a consumer may safely read.
  const available = new Set<string>();
  for (const route of routes) {
    for (const key of route.responseKeys) available.add(key);
  }
  const availableKeys = [...available].sort();

  const mismatches: ShapeMismatch[] = [];
  // A pair is one (consumer, route) comparison; with the union model we count
  // it as consumers×routes so the summary reflects the comparison breadth.
  const pairsChecked = routes.length === 0 ? 0 : consumers.length * routes.length;

  // No routes ⇒ nothing to compare against; never flag (avoids false positives
  // when route extraction found nothing).
  if (routes.length === 0) return { pairsChecked: 0, mismatches: [] };

  for (const consumer of consumers) {
    if (consumer.accessedKeys.length === 0) continue;
    const confidence: "high" | "low" =
      (consumer.routesFetchedInFile ?? 1) > 1 ? "low" : "high";
    const seen = new Set<string>();
    for (const key of consumer.accessedKeys) {
      if (available.has(key) || seen.has(key)) continue;
      seen.add(key);
      mismatches.push({
        consumerId: consumer.symbolId,
        consumerName: consumer.name,
        filePath: consumer.filePath,
        key,
        availableKeys,
        confidence,
      });
    }
  }

  return { pairsChecked, mismatches };
}
