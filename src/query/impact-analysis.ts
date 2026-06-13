/**
 * Impact analysis query logic.
 * Requirements: 10.1, 10.2, 10.3, 10.8, 7.2, 1.1, 1.2, 1.4, 1.5
 */
import type { GraphAdapter, GraphNode } from "../core/ports/persistence.js";
import { prop } from "../core/ports/persistence.js";
import type { Symbol, Relationship, Process, QueryResult, RiskLevel } from "../core/domain.js";
import { graphNodeToCluster } from "./process-helpers.js";
import { MAX_TRAVERSAL_DEPTH } from "../platform/utils/limits.js";
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

export async function findExternalDependencyByAlias(
  graph: GraphAdapter,
  query: string,
): Promise<GraphNode | null> {
  const rows = await graph.runCypher<CypherExternalDependencyRow>(
    `MATCH (ext:ExternalDependency)
     WHERE toLower(ext.name) CONTAINS toLower($query)
        OR toLower(ext.aliases) CONTAINS toLower($query)
     RETURN ext`,
    { query },
  ) ?? [];
  const nodes = rows
    .filter((row): row is CypherExternalDependencyRow => Boolean(row?.ext?.properties))
    .map((row) => ({
    id: row.ext.properties["id"] ?? "",
    labels: row.ext.labels,
    properties: row.ext.properties,
    }));
  if (nodes.length === 0) return null;
  return nodes.reduce((best, candidate) =>
    prop(best, "name").length <= prop(candidate, "name").length ? best : candidate,
  );
}

async function findDependentsByExternalDependency(
  graph: GraphAdapter,
  externalDependencyId: string,
): Promise<GraphNode[]> {
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol)-[:DEPENDS_ON]->(ext:ExternalDependency)
     WHERE ext.id = $val OR ext.name = $val
     RETURN DISTINCT n`,
    { val: externalDependencyId },
  ) ?? [];
  return rows.map(rowToNode);
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

/** Return type for executeImpactAnalysis, including resolution info for callers. */
export type ImpactAnalysisResult = {
  resolution: SymbolResolution;
  targetKind: "symbol" | "externalDependency";
  targetName?: string;
} & Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">;

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
  const exactRows = await graphAdapter.runCypher<CypherNodeRow>(
    `MATCH (n:Symbol) WHERE n.id = $val OR n.name = $val RETURN n LIMIT 1`,
    { val: target },
  ) ?? [];
  const exactSymbolNode = exactRows[0]?.n?.properties ? rowToNode(exactRows[0]) : null;

  const matchedExternalDependency = exactSymbolNode === null
    ? await findExternalDependencyByAlias(graphAdapter, target)
    : null;
  if (matchedExternalDependency) {
    const dependentNodes = await findDependentsByExternalDependency(graphAdapter, matchedExternalDependency.id);
    const dependentSymbols = dependentNodes.map(graphNodeToSymbol);
    const processes = await Promise.all(
      (await Promise.all(
        dependentSymbols.map((symbol) => findProcessesBySymbol(graphAdapter, symbol.id)),
      )).flat().map((node) => graphNodeToProcess(node, graphAdapter)),
    );
    const relationships: Relationship[] = dependentSymbols.map((dep) => ({
      id: `${dep.id}->dependsOn->${matchedExternalDependency.id}`,
      source: dep.id,
      target: matchedExternalDependency.id,
      relType: "dependsOn",
      metadata: {
        packageName: prop(matchedExternalDependency, "name", matchedExternalDependency.id),
      },
    }));

    return {
      resolution: { kind: "exact", node: matchedExternalDependency },
      targetKind: "externalDependency",
      targetName: prop(matchedExternalDependency, "name", matchedExternalDependency.id),
      symbols: dependentSymbols.slice(0, maxResults),
      relationships,
      clusters: [],
      processes,
      confidence: dependentSymbols.length > 0 ? 0.92 : 0.75,
      riskLevel: calculateImpactRisk(dependentSymbols),
      affectedFlows: processes.map((process) => process.name),
    };
  }

  const resolution = exactSymbolNode !== null
    ? { kind: "exact" as const, node: exactSymbolNode }
    : await resolveSymbol(target, graphAdapter);

  if (resolution.kind === "not_found") {
    return {
      resolution,
      targetKind: "symbol",
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
    targetKind: "symbol",
    symbols: allSymbols,
    relationships,
    clusters,
    processes,
    confidence,
    riskLevel,
    affectedFlows,
  };
}
