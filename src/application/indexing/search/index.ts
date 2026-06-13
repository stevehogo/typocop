// Phase 6: Search index orchestrator
// Combines keyword indexing and embedding generation into a unified SearchIndex

import type { Symbol, Cluster, Embedding } from "../../../core/domain.js";
import { buildKeywordIndex } from "./keywords.js";
import { formatSymbolForEmbedding, formatClusterForEmbedding } from "./format.js";

export interface EmbeddingResult {
  readonly symbolId: string;
  readonly embedding: Embedding;
  readonly metadata: Record<string, string>;
}

export interface SearchIndex {
  readonly keywords: Map<string, string[]>;
  readonly symbolCount: number;
  readonly embeddings: EmbeddingResult[];
}

/**
 * Builds a hybrid search index combining keyword and embedding indexing.
 *
 * @param symbols - All symbols to index
 * @param clusters - All clusters to index (embeddings only)
 * @param embedFn - Embedding function, or null to skip embedding generation
 */
export async function buildSearchIndex(
  symbols: Symbol[],
  clusters: Cluster[],
  embedFn: ((text: string) => Promise<Embedding | null>) | null,
): Promise<SearchIndex> {
  const keywords = buildKeywordIndex(symbols);
  const collected: EmbeddingResult[] = [];

  if (embedFn !== null) {
    // Embed individual symbols (name + signature + documentation)
    for (const symbol of symbols) {
      const text = formatSymbolForEmbedding(symbol);
      const embedding = await embedFn(text);

      if (embedding !== null) {
        collected.push({
          symbolId: symbol.id,
          embedding,
          metadata: {
            kind: symbol.kind,
            filePath: symbol.location.filePath,
          },
        });
      }
    }

    // Embed clusters for broader semantic coverage
    const symbolMap = new Map<string, Symbol>(symbols.map(s => [s.id, s]));

    for (const cluster of clusters) {
      const clusterSymbols = cluster.symbols
        .map(id => symbolMap.get(id))
        .filter((s): s is Symbol => s !== undefined);
      const text = formatClusterForEmbedding(cluster, clusterSymbols);
      const embedding = await embedFn(text);

      if (embedding !== null) {
        const firstSymbol = clusterSymbols[0];
        collected.push({
          symbolId: `cluster:${cluster.id}`,
          embedding,
          metadata: {
            clusterId: cluster.id,
            clusterName: cluster.name,
            category: cluster.category,
            ...(firstSymbol ? {
              filePath: firstSymbol.location.filePath,
              kind: firstSymbol.kind,
              symbolId: firstSymbol.id,
            } : {}),
          },
        });
      }
    }
  }

  return {
    keywords,
    symbolCount: symbols.length,
    embeddings: collected,
  };
}

export { formatSymbolForEmbedding, formatClusterForEmbedding } from "./format.js";
export { extractKeywords, buildKeywordIndex } from "./keywords.js";
