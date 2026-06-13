/**
 * Adjacency graph for Louvain community detection.
 *
 * Only CALLS, INHERITS, and IMPLEMENTS edges are used for clustering —
 * IMPORTS edges are directional dependency signals, not structural coupling.
 *
 * Requirements: 3.4, 6.1
 */
import type { Symbol, Relationship } from "../../core/domain.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GraphNode {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
}

/** Undirected adjacency graph used by the Louvain algorithm. */
export interface ClusterGraph {
  /** All nodes in the graph. */
  readonly nodes: ReadonlyMap<string, GraphNode>;
  /** Adjacency list: nodeId → Set of neighbour nodeIds. */
  readonly adjacency: ReadonlyMap<string, Set<string>>;
  /** Total number of edges (each counted once). */
  readonly edgeCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Relationship types that indicate structural coupling between symbols. */
const CLUSTERING_REL_TYPES = new Set(["calls", "inherits", "implements"]);

/** Symbol kinds eligible for clustering. */
const CLUSTERING_SYMBOL_KINDS = new Set([
  "function",
  "class",
  "method",
  "interface",
]);

// ─── Graph construction ───────────────────────────────────────────────────────

/**
 * Build an undirected adjacency graph from symbols and relationships.
 *
 * Only symbols with kinds in CLUSTERING_SYMBOL_KINDS are included.
 * Only relationships with types in CLUSTERING_REL_TYPES are used as edges.
 * Self-loops are excluded.
 *
 * For large graphs (>10K symbols), degree-1 nodes are pruned — they become
 * singletons and waste Louvain iteration time (ported from legacy community-processor).
 *
 * Requirements: 3.4, 6.1
 */
export function buildClusterGraph(
  symbols: Symbol[],
  relationships: Relationship[],
): ClusterGraph {
  const isLarge = symbols.length > 10_000;

  // Build node map from eligible symbols
  const nodes = new Map<string, GraphNode>();
  for (const sym of symbols) {
    if (CLUSTERING_SYMBOL_KINDS.has(sym.kind)) {
      nodes.set(sym.id, {
        id: sym.id,
        name: sym.name,
        filePath: sym.location.filePath,
      });
    }
  }

  // Compute degree for each node (for large-graph pruning)
  const degree = new Map<string, number>();
  for (const rel of relationships) {
    if (!CLUSTERING_REL_TYPES.has(rel.relType)) continue;
    if (rel.source === rel.target) continue;
    if (!nodes.has(rel.source) || !nodes.has(rel.target)) continue;
    degree.set(rel.source, (degree.get(rel.source) ?? 0) + 1);
    degree.set(rel.target, (degree.get(rel.target) ?? 0) + 1);
  }

  // Prune degree-1 nodes on large graphs
  if (isLarge) {
    for (const [id, deg] of degree) {
      if (deg < 2) nodes.delete(id);
    }
  }

  // Build adjacency list (undirected — add both directions)
  const adjacency = new Map<string, Set<string>>();
  for (const id of nodes.keys()) {
    adjacency.set(id, new Set());
  }

  let edgeCount = 0;
  const seenEdges = new Set<string>();

  for (const rel of relationships) {
    if (!CLUSTERING_REL_TYPES.has(rel.relType)) continue;
    if (rel.source === rel.target) continue;
    if (!nodes.has(rel.source) || !nodes.has(rel.target)) continue;

    // Canonical edge key (undirected)
    const edgeKey =
      rel.source < rel.target
        ? `${rel.source}|${rel.target}`
        : `${rel.target}|${rel.source}`;

    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);

    adjacency.get(rel.source)!.add(rel.target);
    adjacency.get(rel.target)!.add(rel.source);
    edgeCount++;
  }

  return { nodes, adjacency, edgeCount };
}

/**
 * Calculate cohesion for a community: fraction of edges that stay internal.
 * Samples up to 50 members for large communities (ported from legacy).
 */
export function calculateCohesion(
  memberIds: string[],
  adjacency: ReadonlyMap<string, Set<string>>,
): number {
  if (memberIds.length <= 1) return 1.0;

  const memberSet = new Set(memberIds);
  const SAMPLE_SIZE = 50;
  const sample =
    memberIds.length <= SAMPLE_SIZE ? memberIds : memberIds.slice(0, SAMPLE_SIZE);

  let internalEdges = 0;
  let totalEdges = 0;

  for (const nodeId of sample) {
    const neighbours = adjacency.get(nodeId);
    if (!neighbours) continue;
    for (const neighbour of neighbours) {
      totalEdges++;
      if (memberSet.has(neighbour)) internalEdges++;
    }
  }

  if (totalEdges === 0) return 1.0;
  return Math.min(1.0, internalEdges / totalEdges);
}
