/**
 * Impact analysis query logic.
 * Requirements: 10.1, 10.2, 10.3, 10.8, 7.2, 1.1, 1.2, 1.4, 1.5
 */
import type { GraphAdapter, GraphNode } from "../db/types.js";
import { prop } from "../db/types.js";
import type { Symbol, Relationship, Process, QueryResult, RiskLevel } from "../types/index.js";
import { graphNodeToCluster } from "./process-helpers.js";
import { MAX_TRAVERSAL_DEPTH } from "../utils/limits.js";
import { rowToNode, graphNodeToSymbol } from "./graph-helpers.js";
import type { CypherNodeRow } from "./graph-helpers.js";
import { resolveSymbol, type SymbolResolution } from "./symbol-resolver.js";

/** Core component name patterns that elevate risk to CRITICAL. */
const CORE_COMPONENT_PATTERNS = [
  /auth/i, /payment/i, /checkout/i, /security/i, /session/i, /token/i,
];

function isCoreComponent(name: string): boolean {
  return CORE_COMPONENT_PATTERNS.some((p) => p.test(name));
}

/**
 * Calculate risk level from affected symbol count and component criticality.
 * Requirements: 10.4, 10.5, 10.6, 10.7
 */
export function calculateImpactRisk(affectedSymbols: Symbol[]): RiskLevel {
  const count = affectedSymbols.length;
  if (affectedSymbols.some((s) => isCoreComponent(s.name))) return "critical";
  if (count >= 11) return "high";
  if (count >= 3) return "medium";
  return "low";
}

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

/** Return type for executeImpactAnalysis, including resolution info for callers. */
export type ImpactAnalysisResult = { resolution: SymbolResolution } & Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">;

/**
 * Execute an impact analysis query using GraphAdapter.runCypher().
 * Uses resolveSymbol for exact → fuzzy fallback (Req 1.1, 1.2, 1.4, 1.5).
 * Requirements: 10.1, 10.2, 10.3, 10.8, 7.2, 1.1, 1.2, 1.4, 1.5
 */
export async function executeImpactAnalysis(
  target: string,
  maxResults: number,
  graphAdapter: GraphAdapter,
): Promise<ImpactAnalysisResult> {
  // Req 10.1, 1.1, 1.2, 1.4 — resolve target symbol (exact → fuzzy → not_found)
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

  // Req 10.2 — find all direct and transitive dependents
  const dependentNodes = await findDependents(graphAdapter, target);
  const dependentSymbols = dependentNodes.map(graphNodeToSymbol);

  // Req 10.3 — identify affected business processes
  const processNodes = await findProcessesBySymbol(graphAdapter, target);
  const processes = await Promise.all(processNodes.map((n) => graphNodeToProcess(n, graphAdapter)));

  // Collect clusters for context
  const clusterNodes = await findClustersBySymbol(graphAdapter, target);
  const clusters = clusterNodes.map(graphNodeToCluster);

  // Build relationships: target ← each dependent
  const relationships: Relationship[] = dependentSymbols.map((dep) => ({
    id: `${dep.id}->calls->${target}`,
    source: dep.id,
    target,
    relType: "calls" as const,
    metadata: {},
  }));

  const allSymbols = [targetSymbol, ...dependentSymbols].slice(0, maxResults);
  const riskLevel = calculateImpactRisk(dependentSymbols);
  const affectedFlows = processes.map((p) => p.name);

  // Confidence: high when target resolved + dependents found
  const confidence = dependentSymbols.length > 0 ? 0.92 : 0.75;

  return {
    resolution,
    symbols: allSymbols,
    relationships,
    clusters,
    processes,
    confidence,
    riskLevel,
    affectedFlows,
  };
}
