/**
 * Context retrieval query implementation - 360° view of a symbol.
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 7.2, 1.1, 1.2, 1.4, 1.5
 */
import type { GraphAdapter, GraphNode } from "../../core/ports/persistence.js";
import { prop } from "../../core/ports/persistence.js";
import type { Relationship, Process, QueryResult, Symbol } from "../../core/domain.js";
import { graphNodeToCluster } from "./process-helpers.js";
import { type CypherNodeRow, rowToNode, graphNodeToSymbol } from "./graph-helpers.js";
import { MAX_TRAVERSAL_DEPTH } from "../../platform/utils/limits.js";
import { resolveSymbol, type SymbolResolution } from "./symbol-resolver.js";

// ─── Graph query helpers using GraphAdapter ───────────────────────────────────

interface CypherProcessRow {
  p: { labels: string[]; properties: Record<string, string> };
}

interface CypherClusterRow {
  c: { labels: string[]; properties: Record<string, string> };
}

interface CypherStepRow {
  symbolId: string;
  stepOrder: number;
  description: string | null;
}

interface CypherExternalDependencyRow {
  ext: { labels: string[]; properties: Record<string, string> };
}

async function findDependents(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol)-[e:CALLS*1..${MAX_TRAVERSAL_DEPTH}]->(t:Symbol) WHERE t.id = $val OR t.name = $val RETURN DISTINCT n`,
    { val: symbolId },
  ) ?? [];
  return rows.map(rowToNode);
}

async function findDependencies(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (s:Symbol)-[e:CALLS*1..${MAX_TRAVERSAL_DEPTH}]->(n:Symbol) WHERE s.id = $val OR s.name = $val RETURN DISTINCT n`,
    { val: symbolId },
  ) ?? [];
  return rows.map(rowToNode);
}

// ─── Wave 8 (T6): heritage / MRO surfacing from the PERSISTED graph ───────────

/** A reachable supertype on the inheritance chain, with its hop distance. */
export interface AncestorEntry {
  readonly id: string;
  readonly name: string;
  /** Minimum number of INHERITS hops from the target (1 = direct superclass). */
  readonly depth: number;
}

/** An interface/trait the target directly implements. */
export interface InterfaceEntry {
  readonly id: string;
  readonly name: string;
}

/** A resolved override/interface-impl target of the symbol. */
export interface OverrideEntry {
  readonly id: string;
  readonly name: string;
  readonly relation: "overrides" | "methodImplements";
}

/** Heritage context for a symbol, derived from persisted heritage edges. */
export interface HeritageContext {
  readonly ancestors: readonly AncestorEntry[];
  readonly interfaces: readonly InterfaceEntry[];
  readonly overrides: readonly OverrideEntry[];
}

/** One direct INHERITS supertype (id + name). */
interface SuperRow {
  superId: string;
  superName: string;
}

/**
 * Walk the persisted INHERITS chain in a bounded BFS (nearest-first), yielding
 * each distinct ancestor with its minimum hop distance. A per-level BFS over
 * single-hop neighbour expansions (mirrors `trace-path.ts`) gives a
 * deterministic distance ordering WITHOUT relying on a path-length projection,
 * and the visited-set + depth bound make a deep/cyclic heritage graph safe.
 *
 * This is a best-effort linearisation by graph distance — it is NOT the full C3
 * MRO order (which the resolver computes but does NOT persist; see T6 notes).
 */
async function findAncestors(graph: GraphAdapter, symbolId: string): Promise<AncestorEntry[]> {
  const ancestors: AncestorEntry[] = [];
  const visited = new Set<string>([symbolId]);
  let frontier: string[] = [symbolId];

  for (let depth = 1; depth <= MAX_TRAVERSAL_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const rows = await graph.runCypher<SuperRow>(
        `MATCH (sub:Symbol)-[:INHERITS]->(sup:Symbol)
         WHERE sub.id = $val
         RETURN DISTINCT sup.id AS superId, sup.name AS superName`,
        { val: id },
      ) ?? [];
      for (const row of rows) {
        if (!row?.superId || visited.has(row.superId)) continue;
        visited.add(row.superId);
        ancestors.push({ id: row.superId, name: row.superName ?? row.superId, depth });
        next.push(row.superId);
      }
    }
    frontier = next;
  }
  return ancestors;
}

/** Direct interfaces/traits the target implements (IMPLEMENTS edges). */
async function findInterfaces(graph: GraphAdapter, symbolId: string): Promise<InterfaceEntry[]> {
  const rows = await graph.runCypher<SuperRow>(
    `MATCH (s:Symbol)-[:IMPLEMENTS]->(iface:Symbol)
     WHERE s.id = $val
     RETURN DISTINCT iface.id AS superId, iface.name AS superName`,
    { val: symbolId },
  ) ?? [];
  return rows
    .filter((r): r is SuperRow => Boolean(r?.superId))
    .map((r) => ({ id: r.superId, name: r.superName ?? r.superId }));
}

/** One resolved override/method-implements target + its relation kind. */
interface OverrideRow {
  targetId: string;
  targetName: string;
  edgeType: string;
}

/**
 * The OVERRIDES / METHODIMPLEMENTS targets of a method symbol (the ancestor
 * member it overrides, or the interface/trait method it satisfies). These edges
 * are emitted by the MRO computation and persisted; the `entries` ambiguity
 * diagnostics are NOT persisted (T6 limitation).
 */
async function findOverrides(graph: GraphAdapter, symbolId: string): Promise<OverrideEntry[]> {
  const rows = await graph.runCypher<OverrideRow>(
    `MATCH (s:Symbol)-[e:OVERRIDES|METHODIMPLEMENTS]->(t:Symbol)
     WHERE s.id = $val
     RETURN DISTINCT t.id AS targetId, t.name AS targetName, label(e) AS edgeType`,
    { val: symbolId },
  ) ?? [];
  return rows
    .filter((r): r is OverrideRow => Boolean(r?.targetId))
    .map((r) => {
      const bare = r.edgeType.includes("_") ? r.edgeType.slice(r.edgeType.lastIndexOf("_") + 1) : r.edgeType;
      const relation: "overrides" | "methodImplements" =
        bare.toUpperCase() === "METHODIMPLEMENTS" ? "methodImplements" : "overrides";
      return { id: r.targetId, name: r.targetName ?? r.targetId, relation };
    });
}

/**
 * Assemble the full heritage context for a resolved symbol from the persisted
 * INHERITS / IMPLEMENTS / OVERRIDES / METHODIMPLEMENTS edges. Returns empty
 * arrays when the symbol has no heritage edges (a plain function, or a graph
 * indexed before heritage edges existed).
 */
async function findHeritage(graph: GraphAdapter, symbolId: string): Promise<HeritageContext> {
  const [ancestors, interfaces, overrides] = await Promise.all([
    findAncestors(graph, symbolId),
    findInterfaces(graph, symbolId),
    findOverrides(graph, symbolId),
  ]);
  return { ancestors, interfaces, overrides };
}

async function findExternalDependencies(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherExternalDependencyRow>(
    `MATCH (s:Symbol)-[:DEPENDS_ON]->(ext:ExternalDependency)
     WHERE s.id = $val OR s.name = $val
     RETURN DISTINCT ext`,
    { val: symbolId },
  ) ?? [];
  return rows
    .filter((row): row is CypherExternalDependencyRow => Boolean(row?.ext?.properties))
    .map((row) => ({
    id: row.ext.properties["id"] ?? "",
    labels: row.ext.labels,
    properties: row.ext.properties,
    }));
}

async function findProcessesBySymbol(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherProcessRow>(
    `MATCH (p:Process)-[:HAS_STEP]->(s:Symbol) WHERE s.id = $val OR s.name = $val RETURN DISTINCT p`,
    { val: symbolId },
  ) ?? [];
  return rows
    .filter((row): row is CypherProcessRow => Boolean(row?.p?.properties))
    .map((r) => ({
    id: r.p.properties["id"] ?? "",
    labels: r.p.labels,
    properties: r.p.properties,
    }));
}

async function findClustersBySymbol(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherClusterRow>(
    `MATCH (c:Cluster)-[:CONTAINS]->(s:Symbol) WHERE s.id = $val OR s.name = $val RETURN DISTINCT c`,
    { val: symbolId },
  ) ?? [];
  return rows
    .filter((row): row is CypherClusterRow => Boolean(row?.c?.properties))
    .map((r) => ({
    id: r.c.properties["id"] ?? "",
    labels: r.c.labels,
    properties: r.c.properties,
    }));
}

async function findProcessSteps(graph: GraphAdapter, processId: string): Promise<Array<{ order: number; symbolId: string; description: string }>> {
  const rows = await graph.runCypher<CypherStepRow>(
    `MATCH (p:Process {id: $processId})-[r:HAS_STEP]->(s:Symbol)
     RETURN s.id AS symbolId, r.step_order AS stepOrder, s.name AS description
     ORDER BY r.step_order ASC`,
    { processId },
  ) ?? [];
  return rows.map((r) => ({
    order: r.stepOrder,
    symbolId: r.symbolId,
    description: r.description ?? "",
  }));
}

async function graphNodeToProcess(node: GraphNode, graph: GraphAdapter): Promise<Process> {
  const steps = await findProcessSteps(graph, node.id);
  return {
    id: node.id,
    name: prop(node, "name", node.id),
    entryPoint: prop(node, "entryPoint"),
    steps,
    dataFlow: [],
  };
}

/** Return type for executeContextRetrieval, including resolution info for callers. */
export type ContextRetrievalResult = {
  resolution: SymbolResolution;
  /**
   * Depth-1 BFS partition used by token-budgeted slicing (D4). Always present
   * (empty arrays when not_found). The flattened {@link QueryResult.symbols} is
   * unchanged; this is purely additive context for {@link sliceContext}.
   */
  target?: Symbol;
  callers?: readonly Symbol[];
  callees?: readonly Symbol[];
  /**
   * Wave 8 (T6): heritage / MRO context derived from the persisted
   * INHERITS/IMPLEMENTS/OVERRIDES/METHODIMPLEMENTS edges. Always present
   * (empty arrays when the target has no heritage edges or is not_found).
   */
  heritage?: HeritageContext;
} & Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">;

/**
 * Execute a context retrieval query - provides 360° view of a symbol.
 * Uses GraphAdapter.runCypher() for all graph queries (Req 7.2).
 * Uses resolveSymbol for exact → fuzzy fallback (Req 1.1, 1.2, 1.4, 1.5).
 *
 * Steps:
 * 1. Resolve target symbol via resolveSymbol (Req 12.1, 1.1, 1.2, 1.4)
 * 2. Find all callers using findDependents (Req 12.2)
 * 3. Find all callees using findDependencies (Req 12.3)
 * 4. Find all processes containing the symbol (Req 12.4)
 * 5. Find all clusters containing the symbol (Req 12.5)
 * 6. Return complete context with resolution info (Req 12.6)
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 7.2, 1.1, 1.2, 1.4, 1.5
 */
export async function executeContextRetrieval(
  target: string,
  maxResults: number,
  graphAdapter: GraphAdapter,
): Promise<ContextRetrievalResult> {
  // Req 12.1, 1.1, 1.2, 1.4 — resolve target symbol (exact → fuzzy → not_found)
  const resolution = await resolveSymbol(target, graphAdapter);

  if (resolution.kind === "not_found") {
    return {
      resolution,
      callers: [],
      callees: [],
      heritage: { ancestors: [], interfaces: [], overrides: [] },
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low" as const,
      affectedFlows: [],
    };
  }

  // Both "exact" and "fuzzy" provide a resolved node
  const targetNode = resolution.node;

  const targetSymbol = graphNodeToSymbol(targetNode);

  // Req 12.2 — find all callers (symbols that call this symbol)
  const callerNodes = await findDependents(graphAdapter, target);
  const callers = callerNodes.map(graphNodeToSymbol);

  // Req 12.3 — find all callees (symbols this symbol calls)
  const calleeNodes = await findDependencies(graphAdapter, target);
  const callees = calleeNodes.map(graphNodeToSymbol);

  // Req 12.4 — find all processes containing the symbol
  const processNodes = await findProcessesBySymbol(graphAdapter, target);
  const processes = await Promise.all(processNodes.map((n) => graphNodeToProcess(n, graphAdapter)));

  // Req 12.5 — find all clusters containing the symbol
  const clusterNodes = await findClustersBySymbol(graphAdapter, target);
  const clusters = clusterNodes.map(graphNodeToCluster);
  const externalDependencyNodes = await findExternalDependencies(graphAdapter, target);

  // Wave 8 (T6) — heritage / MRO context from the persisted heritage edges.
  // Keyed on the resolved node id (NOT the raw `target` string) so it works for
  // both exact and fuzzy resolutions.
  const heritage = await findHeritage(graphAdapter, targetNode.id);

  // Build relationships: callers → target and target → callees
  const relationships: Relationship[] = [
    ...callers.map((caller) => ({
      id: `${caller.id}->calls->${target}`,
      source: caller.id,
      target,
      relType: "calls" as const,
      metadata: {},
    })),
    ...callees.map((callee) => ({
      id: `${target}->calls->${callee.id}`,
      source: target,
      target: callee.id,
      relType: "calls" as const,
      metadata: {},
    })),
    ...externalDependencyNodes.map((extNode) => ({
      id: `${target}->dependsOn->${extNode.id}`,
      source: targetNode.id,
      target: extNode.id,
      relType: "dependsOn" as const,
      metadata: {
        packageName: prop(extNode, "name", extNode.id),
      },
    })),
  ];

  // Combine all symbols: target + callers + callees
  const allSymbols = [targetSymbol, ...callers, ...callees].slice(0, maxResults);

  // Confidence: high when target resolved and context found
  const hasContext =
    callers.length > 0 ||
    callees.length > 0 ||
    processes.length > 0 ||
    clusters.length > 0 ||
    externalDependencyNodes.length > 0;
  const confidence = hasContext ? 0.92 : 0.75;

  // Affected flows: list process names
  const affectedFlows = processes.map((p) => p.name);

  // Req 12.6 — return complete context with resolution info
  return {
    resolution,
    target: targetSymbol,
    callers,
    callees,
    heritage,
    symbols: allSymbols,
    relationships,
    clusters,
    processes,
    confidence,
    riskLevel: "low" as const,
    affectedFlows,
  };
}
