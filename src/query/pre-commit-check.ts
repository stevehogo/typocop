/**
 * Pre-commit check query logic.
 * Requirements: 11b.1, 11b.2, 11b.3, 11b.4, 11b.5, 7.2
 */
import type { GraphAdapter, GraphNode } from "../db/types.js";
import { prop } from "../db/types.js";
import type { Symbol, Relationship, Process, QueryResult, RiskLevel, SymbolKind, Visibility } from "../types/index.js";
import { graphNodeToCluster } from "./process-helpers.js";
import { MAX_TRAVERSAL_DEPTH } from "../utils/limits.js";

/** Core component name patterns that elevate risk to CRITICAL. */
const CORE_COMPONENT_PATTERNS = [
  /auth/i, /payment/i, /checkout/i, /security/i, /session/i, /token/i,
];

function isCoreComponent(name: string): boolean {
  return CORE_COMPONENT_PATTERNS.some((p) => p.test(name));
}

/**
 * Calculate risk level from total affected symbol count and component criticality.
 * Requirements: 11b.4
 */
export function calculatePreCommitRisk(affectedSymbols: Symbol[]): RiskLevel {
  const count = affectedSymbols.length;
  if (affectedSymbols.some((s) => isCoreComponent(s.name))) return "critical";
  if (count >= 11) return "high";
  if (count >= 3) return "medium";
  return "low";
}

function graphNodeToSymbol(node: GraphNode): Symbol {
  return {
    id: node.id,
    name: prop(node, "name", node.id),
    kind: prop(node, "kind", "function") as SymbolKind,
    location: {
      filePath: prop(node, "filePath"),
      startLine: parseInt(prop(node, "startLine", "0"), 10),
      startColumn: parseInt(prop(node, "startColumn", "0"), 10),
      endLine: parseInt(prop(node, "endLine", "0"), 10),
      endColumn: parseInt(prop(node, "endColumn", "0"), 10),
    },
    signature: node.properties["signature"] as string | undefined,
    visibility: prop(node, "visibility", "public") as Visibility,
    modifiers: [],
  };
}

// ─── Graph query helpers using GraphAdapter ───────────────────────────────────

interface CypherNodeRow {
  n: { labels: string[]; properties: Record<string, string> };
}

interface CypherSymbolRow {
  s: { labels: string[]; properties: Record<string, string> };
}

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

function rowToNode(row: CypherNodeRow): GraphNode {
  const n = row.n;
  return { id: n.properties["id"] ?? "", labels: n.labels, properties: n.properties };
}

async function findSymbolsInFiles(graph: GraphAdapter, filePaths: string[]): Promise<GraphNode[]> {
  if (filePaths.length === 0) return [];
  const rows = await graph.runCypher<CypherSymbolRow>(
    `MATCH (s:Symbol) WHERE s.filePath IN $filePaths RETURN s`,
    { filePaths },
  );
  return rows.map((r) => ({
    id: r.s.properties["id"] ?? "",
    labels: r.s.labels,
    properties: r.s.properties,
  }));
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

/**
 * Generate testing recommendations based on affected processes and risk level.
 * Requirements: 11b.5
 */
function generateTestRecommendations(
  processes: Process[],
  riskLevel: RiskLevel,
  changedSymbols: Symbol[],
): string[] {
  const recommendations: string[] = [];

  if (processes.length === 0) {
    recommendations.push("No business processes affected. Run unit tests for changed symbols.");
    return recommendations;
  }

  if (riskLevel === "critical" || riskLevel === "high") {
    recommendations.push(`Test all ${processes.length} affected flow(s) end-to-end due to ${riskLevel.toUpperCase()} risk.`);
    for (const p of processes) {
      recommendations.push(`- ${p.name}`);
    }
  } else if (riskLevel === "medium") {
    const topProcesses = processes.slice(0, 3);
    recommendations.push(`Test ${topProcesses.length} critical flow(s):`);
    for (const p of topProcesses) {
      recommendations.push(`- ${p.name}`);
    }
  } else {
    recommendations.push("Run unit tests for changed symbols:");
    for (const s of changedSymbols) {
      recommendations.push(`- ${s.name} (${s.location.filePath})`);
    }
    if (processes.length > 0) {
      recommendations.push(`Smoke test: ${processes[0].name}`);
    }
  }

  return recommendations;
}

/**
 * Execute a pre-commit check query using GraphAdapter.runCypher().
 *
 * Analyzes the blast radius of uncommitted changes:
 * 1. Identifies all symbols defined in changed files (Req 11b.1)
 * 2. Finds all direct and transitive dependents (Req 11b.2)
 * 3. Identifies affected business processes (Req 11b.3)
 * 4. Calculates risk assessment (Req 11b.4)
 * 5. Generates testing recommendations (Req 11b.5)
 *
 * Requirements: 11b.1, 11b.2, 11b.3, 11b.4, 11b.5, 7.2
 */
export async function executePreCommitCheck(
  changedFiles: string[],
  maxResults: number,
  graphAdapter: GraphAdapter,
): Promise<Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">> {
  // Req 11b.1 — identify all symbols defined in changed files
  const changedSymbolNodes = await findSymbolsInFiles(graphAdapter, changedFiles);

  if (changedSymbolNodes.length === 0) {
    return {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.95,
      riskLevel: "low",
      affectedFlows: [],
    };
  }

  const changedSymbols = changedSymbolNodes.map(graphNodeToSymbol);
  const changedSymbolIds = changedSymbols.map((s) => s.id);

  // Req 11b.2 — find all direct and transitive dependents for each changed symbol
  const allDependentNodes: GraphNode[] = [];
  const seenIds = new Set<string>();

  for (const symbolId of changedSymbolIds) {
    const dependents = await findDependents(graphAdapter, symbolId);
    for (const dep of dependents) {
      if (!seenIds.has(dep.id)) {
        seenIds.add(dep.id);
        allDependentNodes.push(dep);
      }
    }
  }

  const dependentSymbols = allDependentNodes.map(graphNodeToSymbol);

  // Req 11b.3 — identify all affected business processes
  const allProcessNodes: GraphNode[] = [];
  const seenProcessIds = new Set<string>();

  const allAffectedSymbolIds = [...changedSymbolIds, ...dependentSymbols.map((s) => s.id)];

  for (const symbolId of allAffectedSymbolIds) {
    const processNodes = await findProcessesBySymbol(graphAdapter, symbolId);
    for (const proc of processNodes) {
      if (!seenProcessIds.has(proc.id)) {
        seenProcessIds.add(proc.id);
        allProcessNodes.push(proc);
      }
    }
  }

  const processes = await Promise.all(allProcessNodes.map((n) => graphNodeToProcess(n, graphAdapter)));

  // Collect clusters for context
  const allClusterNodes: GraphNode[] = [];
  const seenClusterIds = new Set<string>();

  for (const symbolId of changedSymbolIds) {
    const clusterNodes = await findClustersBySymbol(graphAdapter, symbolId);
    for (const cluster of clusterNodes) {
      if (!seenClusterIds.has(cluster.id)) {
        seenClusterIds.add(cluster.id);
        allClusterNodes.push(cluster);
      }
    }
  }

  const clusters = allClusterNodes.map(graphNodeToCluster);

  // Build relationships: each dependent → changed symbol
  const relationships: Relationship[] = [];
  for (const dep of dependentSymbols) {
    for (const changedId of changedSymbolIds) {
      relationships.push({
        id: `${dep.id}->calls->${changedId}`,
        source: dep.id,
        target: changedId,
        relType: "calls",
        metadata: {},
      });
    }
  }

  // Combine changed symbols and their dependents
  const allAffectedSymbols = [...changedSymbols, ...dependentSymbols];

  // Req 11b.4 — calculate risk assessment
  const riskLevel = calculatePreCommitRisk(allAffectedSymbols);

  // Req 11b.5 — generate testing recommendations
  const testRecommendations = generateTestRecommendations(processes, riskLevel, changedSymbols);
  const affectedFlows = processes.map((p) => p.name);

  // Confidence: high when changed symbols found + dependents analyzed
  const confidence = changedSymbols.length > 0 ? 0.93 : 0.75;

  return {
    symbols: allAffectedSymbols.slice(0, maxResults),
    relationships: relationships.slice(0, maxResults),
    clusters,
    processes,
    confidence,
    riskLevel,
    affectedFlows: [...affectedFlows, ...testRecommendations],
  };
}
