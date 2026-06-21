/**
 * Trace the shortest hop chain between two symbols over CALLS|CONTAINS edges
 * (D3). Resolves both endpoints (exact → fuzzy), then finds the shortest
 * directed path from → to, reporting each hop's file:line and the edge type
 * that links it to the next hop.
 *
 * Implementation: a bounded breadth-first search in TS over `runCypher`
 * neighbour expansions. BFS guarantees the SHORTEST path (fewest hops) and does
 * not depend on a LadybugDB/Kùzu `shortestPath`/variable-length builtin (Kùzu's
 * recursive-rel support is not relied upon here). The search depth is clamped to
 * {@link MAX_TRAVERSAL_DEPTH} so a deep/cyclic graph can never run unbounded.
 *
 * Requirements: 16.7, 23.4, 1.1, 1.2, 1.4, 1.5
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import type { RelationType } from "../../core/domain.js";
import { MAX_TRAVERSAL_DEPTH } from "../../platform/utils/limits.js";
import { resolveSymbol, type SymbolResolution } from "./symbol-resolver.js";
import { rowToNode } from "./graph-helpers.js";
import type { CypherNodeRow } from "./graph-helpers.js";
import { prop } from "../../core/ports/persistence.js";

/** A single node on a traced path. `edgeToNext` is the edge into the NEXT hop. */
export interface TraceHop {
  readonly symbolId: string;
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number;
  /** Edge type linking this hop to the next; absent on the final hop. */
  readonly edgeToNext?: RelationType;
}

/** Result of a {@link executeTracePath} query. */
export interface TracePathResult {
  readonly resolution: { readonly from: SymbolResolution; readonly to: SymbolResolution };
  readonly found: boolean;
  readonly hops: readonly TraceHop[];
  /** Number of EDGES on the path (`hops.length - 1`); 0 when no path / single node. */
  readonly length: number;
}

/** Map a raw Cypher edge label (possibly prefixed, e.g. `tpc_CALLS`) to a RelationType. */
function edgeLabelToRelType(label: string): RelationType {
  const bare = label.includes("_") ? label.slice(label.lastIndexOf("_") + 1) : label;
  switch (bare.toUpperCase()) {
    case "CALLS": return "calls";
    case "CONTAINS": return "contains";
    case "IMPORTS": return "imports";
    case "INHERITS": return "inherits";
    case "IMPLEMENTS": return "implements";
    case "REFERENCES": return "references";
    case "DEFINES": return "defines";
    case "DEPENDS_ON": return "dependsOn";
    default: return "calls";
  }
}

/** One outgoing neighbour reachable over a CALLS|CONTAINS edge. */
interface NeighbourRow {
  neighbourId: string;
  edgeType: string;
}

/**
 * Expand the directed CALLS|CONTAINS neighbours of a node (one hop out). Used by
 * the BFS frontier. Returns `{ id, edgeType }` for each distinct out-neighbour.
 */
async function expandNeighbours(
  graph: GraphAdapter,
  nodeId: string,
): Promise<NeighbourRow[]> {
  const rows = await graph.runCypher<NeighbourRow>(
    `MATCH (n:Symbol)-[e:CALLS|CONTAINS]->(m:Symbol)
     WHERE n.id = $val
     RETURN DISTINCT m.id AS neighbourId, label(e) AS edgeType`,
    { val: nodeId },
  ) ?? [];
  return rows.filter((r): r is NeighbourRow => Boolean(r?.neighbourId));
}

/** Fetch a node's display fields (name, filePath, startLine) by id. */
async function fetchNode(
  graph: GraphAdapter,
  nodeId: string,
): Promise<{ name: string; filePath: string; startLine: number } | null> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol) WHERE n.id = $val RETURN n LIMIT 1`,
    { val: nodeId },
  ) ?? [];
  if (rows.length === 0 || !rows[0]?.n?.properties) return null;
  const node = rowToNode(rows[0]);
  return {
    name: prop(node, "name", node.id),
    filePath: prop(node, "filePath"),
    startLine: parseInt(prop(node, "startLine", "0"), 10),
  };
}

/** Clamp a requested depth to (0, MAX_TRAVERSAL_DEPTH]; default = MAX. */
export function clampTraceDepth(maxDepth?: number): number {
  if (maxDepth === undefined || !Number.isFinite(maxDepth) || maxDepth < 1) {
    return MAX_TRAVERSAL_DEPTH;
  }
  return Math.min(Math.floor(maxDepth), MAX_TRAVERSAL_DEPTH);
}

/** A predecessor record on the BFS tree: who we came from and via which edge. */
interface PredEntry {
  readonly prevId: string;
  readonly edge: RelationType;
}

/**
 * Bounded BFS from `startId` to `goalId` over CALLS|CONTAINS edges. Returns the
 * ordered list of `{ id, edgeToNext }` hops for the shortest path, or null if
 * `goalId` is not reachable within `maxEdges` edges.
 */
async function bfsShortestPath(
  graph: GraphAdapter,
  startId: string,
  goalId: string,
  maxEdges: number,
): Promise<Array<{ id: string; edgeToNext?: RelationType }> | null> {
  if (startId === goalId) return [{ id: startId }];

  const visited = new Set<string>([startId]);
  const pred = new Map<string, PredEntry>();
  let frontier: string[] = [startId];
  let depth = 0;

  while (frontier.length > 0 && depth < maxEdges) {
    depth += 1;
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      const neighbours = await expandNeighbours(graph, nodeId);
      for (const nb of neighbours) {
        if (visited.has(nb.neighbourId)) continue;
        visited.add(nb.neighbourId);
        pred.set(nb.neighbourId, { prevId: nodeId, edge: edgeLabelToRelType(nb.edgeType ?? "CALLS") });
        if (nb.neighbourId === goalId) {
          // Reconstruct the path start → … → goal.
          const reverse: Array<{ id: string; edge?: RelationType }> = [{ id: goalId }];
          let cursor = goalId;
          while (cursor !== startId) {
            const p = pred.get(cursor);
            if (!p) return null; // defensive: broken chain
            reverse.push({ id: p.prevId, edge: p.edge });
            cursor = p.prevId;
          }
          reverse.reverse();
          // Each pushed `{ prevId, edge }` records the edge prevId -> cursor, so
          // after reversal `entry.edge` is the edge OUT of `entry` to the NEXT
          // hop (the goal entry, pushed without an edge, has none).
          return reverse.map((entry) => ({
            id: entry.id,
            edgeToNext: entry.edge,
          }));
        }
        nextFrontier.push(nb.neighbourId);
      }
    }
    frontier = nextFrontier;
  }
  return null;
}

/**
 * Trace the shortest CALLS|CONTAINS path between two symbols.
 *
 * Both endpoints are resolved with the shared exact → fuzzy resolver. If either
 * endpoint cannot be resolved, `found` is false and `hops` is empty (the
 * resolution union tells the caller which side failed, for a helpful summary).
 *
 * @param from     source symbol name or id
 * @param to       destination symbol name or id
 * @param maxDepth optional max edges to traverse, clamped to MAX_TRAVERSAL_DEPTH
 * @param graph    graph adapter
 */
export async function executeTracePath(
  from: string,
  to: string,
  maxDepth: number | undefined,
  graph: GraphAdapter,
): Promise<TracePathResult> {
  const fromRes = await resolveSymbol(from, graph);
  const toRes = await resolveSymbol(to, graph);

  const resolution = { from: fromRes, to: toRes };

  if (fromRes.kind === "not_found" || toRes.kind === "not_found") {
    return { resolution, found: false, hops: [], length: 0 };
  }

  const startId = fromRes.node.id;
  const goalId = toRes.node.id;
  const maxEdges = clampTraceDepth(maxDepth);

  const path = await bfsShortestPath(graph, startId, goalId, maxEdges);
  if (path === null) {
    return { resolution, found: false, hops: [], length: 0 };
  }

  // Hydrate each hop's display fields.
  const hops: TraceHop[] = [];
  for (const step of path) {
    const node = await fetchNode(graph, step.id);
    hops.push({
      symbolId: step.id,
      name: node?.name ?? step.id,
      filePath: node?.filePath ?? "",
      startLine: node?.startLine ?? 0,
      ...(step.edgeToNext ? { edgeToNext: step.edgeToNext } : {}),
    });
  }

  return { resolution, found: true, hops, length: Math.max(0, hops.length - 1) };
}
