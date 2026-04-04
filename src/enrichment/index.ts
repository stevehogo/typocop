/**
 * AI Context Enrichment — public API.
 * Wires together cluster enrichment, intent classification,
 * side effect analysis, and type inference.
 *
 * Requirements: 24.1, 24.2, 24.3, 24.4, 24.5
 */
export type { EnrichmentConfig, EnrichmentTask } from "./config.js";
export { classifyIntent } from "./intent.js";
export { analyzeSideEffects, inferTypes } from "./side-effects.js";

import type { Cluster, Symbol, QueryIntent } from "../types/index.js";
import type { EnrichmentConfig } from "./config.js";
import { enrichCluster as enrichClusterImpl } from "../indexer/clustering/enrichment.js";
import { classifyIntent } from "./intent.js";
import { analyzeSideEffects, inferTypes } from "./side-effects.js";

export interface EnrichedSymbol {
  readonly symbol: Symbol;
  readonly sideEffects: string[];
  readonly inferredTypes: Record<string, string>;
}

/**
 * Enrich a cluster with AI-generated name and heuristic category.
 * Delegates to the clustering enrichment module.
 * Requirements: 24.1, 24.2
 */
export async function enrichCluster(
  cluster: Cluster,
  symbolMap: ReadonlyMap<string, Symbol>,
  _config: EnrichmentConfig,
): Promise<Cluster> {
  const heuristicLabel = cluster.name;
  return enrichClusterImpl(cluster, symbolMap, heuristicLabel);
}

/**
 * Enrich a symbol with side effects and inferred types.
 * Requirements: 24.4, 24.5
 */
export function enrichSymbol(
  symbol: Symbol,
  config: EnrichmentConfig,
): EnrichedSymbol {
  const sideEffects = config.enableSideEffectAnalysis
    ? analyzeSideEffects(symbol)
    : [];
  const inferredTypes = config.enableTypeInference
    ? inferTypes(symbol)
    : {};
  return { symbol, sideEffects, inferredTypes };
}

/**
 * Classify query intent with confidence >= 0.7.
 * Requirements: 9.2, 24.3, 21.6
 */
export function classifyQueryIntent(
  text: string,
  config: EnrichmentConfig,
): { intent: QueryIntent; confidence: number } {
  if (!config.enableIntentClassification) {
    return {
      intent: { type: "smartSearch", query: text.trim() },
      confidence: 0.75,
    };
  }
  return classifyIntent(text);
}
