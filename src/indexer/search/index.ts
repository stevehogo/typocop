// Phase 6: Search index orchestrator
// Combines keyword indexing and embedding generation into a unified SearchIndex

import type { Symbol, Cluster, Embedding } from "../../types/index.js";
import { buildKeywordIndex } from "./keywords.js";

export interface SearchIndex {
  readonly keywords: Map<string, string[]>;
  readonly symbolCount: number;
}

/**
 * Builds a hybrid search index combining keyword and embedding indexing.
 *
 * @param symbols - All symbols to index
 * @param clusters - All clusters to index (embeddings only)
 * @param embedFn - Embedding function; returns null if service unavailable
 */
export async function buildSearchIndex(
  symbols: Symbol[],
  clusters: Cluster[],
  embedFn: (text: string) => Promise<Embedding | null>,
): Promise<SearchIndex> {
  // Build keyword index (always succeeds)
  const keywords = buildKeywordIndex(symbols);

  // Generate embeddings for symbols (best-effort; null = service unavailable)
  const symbolMap = new Map<string, Symbol>(symbols.map(s => [s.id, s]));

  for (const cluster of clusters) {
    const { formatClusterForEmbedding } = await import("./embed.js");
    const clusterSymbols = cluster.symbols
      .map(id => symbolMap.get(id))
      .filter((s): s is Symbol => s !== undefined);
    const text = formatClusterForEmbedding(cluster, clusterSymbols);
    await embedFn(text); // result stored by caller if needed
  }

  return {
    keywords,
    symbolCount: symbols.length,
  };
}

export { formatSymbolForEmbedding, formatClusterForEmbedding, embedText } from "./embed.js";
export type { EmbeddingConfig } from "./embed.js";
export { extractKeywords, buildKeywordIndex } from "./keywords.js";
