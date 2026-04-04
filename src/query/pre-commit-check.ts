/**
 * Pre-commit check query logic.
 * Requirements: 11b.1, 11b.2, 11b.3, 11b.4, 11b.5
 */
import type { Session } from "neo4j-driver";
import type { Symbol, Relationship, Cluster, Process, QueryResult, RiskLevel, ClusterCategory, SymbolKind, Visibility } from "../types/index.js";
import { findDependents, findProcessesBySymbol, findClustersBySymbol } from "../graph/query.js";
import type { GraphNode } from "../graph/connection.js";

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
  const p = node.properties;
  return {
    id: node.id,
    name: p["name"] ?? node.id,
    kind: (p["kind"] ?? "function") as SymbolKind,
    location: {
      filePath: p["filePath"] ?? "",
      startLine: parseInt(p["startLine"] ?? "0", 10),
      startColumn: parseInt(p["startColumn"] ?? "0", 10),
      endLine: parseInt(p["endLine"] ?? "0", 10),
      endColumn: parseInt(p["endColumn"] ?? "0", 10),
    },
    signature: p["signature"],
    visibility: (p["visibility"] ?? "public") as Visibility,
    modifiers: [],
  };
}

function graphNodeToProcess(node: GraphNode): Process {
  const p = node.properties;
  return {
    id: node.id,
    name: p["name"] ?? node.id,
    entryPoint: p["entryPoint"] ?? "",
    steps: [],
    dataFlow: [],
  };
}

function graphNodeToCluster(node: GraphNode): Cluster {
  const p = node.properties;
  return {
    id: node.id,
    name: p["name"] ?? node.id,
    symbols: [],
    confidence: parseFloat(p["confidence"] ?? "0.8"),
    category: (p["category"] ?? "unknown") as ClusterCategory,
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

  // Recommend testing all affected flows for high/critical risk
  if (riskLevel === "critical" || riskLevel === "high") {
    recommendations.push(`Test all ${processes.length} affected flow(s) end-to-end due to ${riskLevel.toUpperCase()} risk.`);
    processes.forEach((p) => {
      recommendations.push(`- ${p.name}`);
    });
  } else if (riskLevel === "medium") {
    // For medium risk, recommend testing top 3 processes
    const topProcesses = processes.slice(0, 3);
    recommendations.push(`Test ${topProcesses.length} critical flow(s):`);
    topProcesses.forEach((p) => {
      recommendations.push(`- ${p.name}`);
    });
  } else {
    // For low risk, recommend unit tests + smoke test
    recommendations.push("Run unit tests for changed symbols:");
    changedSymbols.forEach((s) => {
      recommendations.push(`- ${s.name} (${s.location.filePath})`);
    });
    if (processes.length > 0) {
      recommendations.push(`Smoke test: ${processes[0].name}`);
    }
  }

  return recommendations;
}

/**
 * Find all symbols defined in the given file paths.
 * Requirements: 11b.1
 */
async function findSymbolsInFiles(
  session: Session,
  filePaths: string[],
): Promise<GraphNode[]> {
  if (filePaths.length === 0) return [];

  const result = await session.run(
    `MATCH (s:Symbol)
     WHERE s.filePath IN $filePaths
     RETURN s`,
    { filePaths },
  );

  return result.records.map((r) => {
    const n = r.get("s") as { labels: string[]; properties: Record<string, string> };
    return { id: n.properties["id"] ?? "", labels: n.labels, properties: n.properties };
  });
}

/**
 * Execute a pre-commit check query.
 * 
 * Analyzes the blast radius of uncommitted changes:
 * 1. Identifies all symbols defined in changed files (Req 11b.1)
 * 2. Finds all direct and transitive dependents (Req 11b.2)
 * 3. Identifies affected business processes (Req 11b.3)
 * 4. Calculates risk assessment (Req 11b.4)
 * 5. Generates testing recommendations (Req 11b.5)
 * 
 * Requirements: 11b.1, 11b.2, 11b.3, 11b.4, 11b.5
 */
export async function executePreCommitCheck(
  changedFiles: string[],
  maxResults: number,
  graphSession: Session,
): Promise<Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">> {
  // Req 11b.1 — identify all symbols defined in changed files
  const changedSymbolNodes = await findSymbolsInFiles(graphSession, changedFiles);
  
  if (changedSymbolNodes.length === 0) {
    return {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.95, // High confidence that no symbols are affected
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
    const dependents = await findDependents(graphSession, symbolId);
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

  // Check processes for both changed symbols and their dependents
  const allAffectedSymbolIds = [...changedSymbolIds, ...dependentSymbols.map((s) => s.id)];

  for (const symbolId of allAffectedSymbolIds) {
    const processNodes = await findProcessesBySymbol(graphSession, symbolId);
    for (const proc of processNodes) {
      if (!seenProcessIds.has(proc.id)) {
        seenProcessIds.add(proc.id);
        allProcessNodes.push(proc);
      }
    }
  }

  const processes = allProcessNodes.map(graphNodeToProcess);

  // Collect clusters for context
  const allClusterNodes: GraphNode[] = [];
  const seenClusterIds = new Set<string>();

  for (const symbolId of changedSymbolIds) {
    const clusterNodes = await findClustersBySymbol(graphSession, symbolId);
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
