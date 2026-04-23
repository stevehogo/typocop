/**
 * Context retrieval query implementation - 360° view of a symbol.
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 7.2, 1.1, 1.2, 1.4, 1.5
 */
import type { GraphAdapter, GraphNode } from "../db/types.js";
import { prop } from "../db/types.js";
import type { Relationship, Process, QueryResult } from "../types/index.js";
import { graphNodeToCluster } from "./process-helpers.js";
import { type CypherNodeRow, rowToNode, graphNodeToSymbol } from "./graph-helpers.js";
import { MAX_TRAVERSAL_DEPTH } from "../utils/limits.js";
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

async function findDependents(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol)-[e:CALLS*1..${MAX_TRAVERSAL_DEPTH}]->(t:Symbol) WHERE t.id = $val OR t.name = $val RETURN DISTINCT n`,
    { val: symbolId },
  );
  return rows.map(rowToNode);
}

async function findDependencies(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (s:Symbol)-[e:CALLS*1..${MAX_TRAVERSAL_DEPTH}]->(n:Symbol) WHERE s.id = $val OR s.name = $val RETURN DISTINCT n`,
    { val: symbolId },
  );
  return rows.map(rowToNode);
}

async function findProcessesBySymbol(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherProcessRow>(
    `MATCH (p:Process)-[:HAS_STEP]->(s:Symbol) WHERE s.id = $val OR s.name = $val RETURN DISTINCT p`,
    { val: symbolId },
  );
  return rows.map((r) => ({
    id: r.p.properties["id"] ?? "",
    labels: r.p.labels,
    properties: r.p.properties,
  }));
}

async function findClustersBySymbol(graph: GraphAdapter, symbolId: string): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherClusterRow>(
    `MATCH (c:Cluster)-[:CONTAINS]->(s:Symbol) WHERE s.id = $val OR s.name = $val RETURN DISTINCT c`,
    { val: symbolId },
  );
  return rows.map((r) => ({
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
  );
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
export type ContextRetrievalResult = { resolution: SymbolResolution } & Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">;

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
  ];

  // Combine all symbols: target + callers + callees
  const allSymbols = [targetSymbol, ...callers, ...callees].slice(0, maxResults);

  // Confidence: high when target resolved and context found
  const hasContext = callers.length > 0 || callees.length > 0 || processes.length > 0 || clusters.length > 0;
  const confidence = hasContext ? 0.92 : 0.75;

  // Affected flows: list process names
  const affectedFlows = processes.map((p) => p.name);

  // Req 12.6 — return complete context with resolution info
  return {
    resolution,
    symbols: allSymbols,
    relationships,
    clusters,
    processes,
    confidence,
    riskLevel: "low" as const,
    affectedFlows,
  };
}
