/**
 * Phase 4: Symbol clustering.
 *
 * Groups related symbols into functional communities using the Louvain
 * algorithm, then enriches each cluster with a descriptive name and category.
 *
 * Requirements: 3.4, 6.1–6.6, 21.5, 24.1, 24.2
 */
import type { Symbol, Relationship, Cluster } from "../../../core/domain.js";
import type { EmbeddingAdapter } from "../../../core/ports/persistence.js";
import { buildClusterGraph, calculateCohesion } from "./graph.js";
import { louvainClustering, generateHeuristicLabel } from "./louvain.js";
import { enrichCluster } from "./enrichment.js";
import type { AIClient } from "./enrichment.js";

export type { AIClient } from "./enrichment.js";
export { classifyCluster, inferClusterName, resetSharedClassifier } from "./enrichment.js";
export { buildClusterGraph, calculateCohesion } from "./graph.js";
export { louvainClustering, generateHeuristicLabel } from "./louvain.js";
export {
  SemanticClusterClassifier,
  buildClusterText,
  cosineSimilarity,
  SEMANTIC_THRESHOLD,
  ALL_CATEGORIES,
  CATEGORY_REFERENCE_TEXTS,
} from "./semantic-classifier.js";

// ─── Phase 4 entry point ──────────────────────────────────────────────────────

/**
 * Phase 4 — Cluster symbols into functional communities.
 *
 * 1. Build undirected adjacency graph from CALLS/INHERITS/IMPLEMENTS edges.
 * 2. Run Louvain community detection.
 * 3. Enrich each community with a name and category.
 *
 * Returns only clusters with >= 2 symbols (Req 6.4).
 *
 * Requirements: 3.4, 6.1–6.6, 21.5
 */
export async function clusterSymbols(
  symbols: Symbol[],
  relationships: Relationship[],
  aiClient?: AIClient,
  embeddingAdapter?: EmbeddingAdapter,
): Promise<Cluster[]> {
  const graph = buildClusterGraph(symbols, relationships);
  const communities = louvainClustering(graph);

  if (communities.length === 0) return [];

  // Build lookup maps for enrichment
  const symbolMap = new Map<string, Symbol>(symbols.map((s) => [s.id, s]));
  const nodePathMap = new Map<string, string>(
    Array.from(graph.nodes.values()).map((n) => [n.id, n.filePath]),
  );
  const nodeNameMap = new Map<string, string>(
    Array.from(graph.nodes.values()).map((n) => [n.id, n.name]),
  );

  const clusters: Cluster[] = [];

  for (let idx = 0; idx < communities.length; idx++) {
    const { members, modularity } = communities[idx];

    // Confidence = modularity contribution, boosted by cohesion
    const cohesion = calculateCohesion(members, graph.adjacency);
    const confidence = Math.min(1.0, Math.max(0.0, (modularity + cohesion) / 2));

    const heuristicLabel = generateHeuristicLabel(
      members,
      nodePathMap,
      nodeNameMap,
      idx,
    );

    const rawCluster: Cluster = {
      id: `cluster_${idx}`,
      name: heuristicLabel,
      symbols: members,
      confidence,
      category: "unknown",
    };

    const enriched = await enrichCluster(
      rawCluster,
      symbolMap,
      heuristicLabel,
      aiClient,
      embeddingAdapter,
    );

    clusters.push(enriched);
  }

  return clusters;
}
