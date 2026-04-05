/**
 * Impact analysis query logic.
 * Requirements: 10.1, 10.2, 10.3, 10.8
 */
import type { Session } from "neo4j-driver";
import type { Symbol, Relationship, QueryResult, RiskLevel, SymbolKind, Visibility } from "../types/index.js";
import { findNode, findDependents, findProcessesBySymbol, findClustersBySymbol } from "../graph/query.js";
import type { GraphNode } from "../graph/connection.js";
import { graphNodeToProcess, graphNodeToCluster } from "./process-helpers.js";

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

/**
 * Execute an impact analysis query.
 * Finds the target symbol, all transitive dependents, affected processes, and risk level.
 * Requirements: 10.1, 10.2, 10.3, 10.8
 */
export async function executeImpactAnalysis(
  target: string,
  maxResults: number,
  graphSession: Session,
): Promise<Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">> {
  // Req 10.1 — identify target symbol
  const targetNode = await findNode(graphSession, target);
  if (!targetNode) {
    return {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low",
      affectedFlows: [],
    };
  }

  const targetSymbol = graphNodeToSymbol(targetNode);

  // Req 10.2 — find all direct and transitive dependents
  const dependentNodes = await findDependents(graphSession, target);
  const dependentSymbols = dependentNodes.map(graphNodeToSymbol);

  // Req 10.3 — identify affected business processes
  const processNodes = await findProcessesBySymbol(graphSession, target);
  const processes = await Promise.all(processNodes.map((n) => graphNodeToProcess(n, graphSession)));

  // Collect clusters for context
  const clusterNodes = await findClustersBySymbol(graphSession, target);
  const clusters = clusterNodes.map(graphNodeToCluster);

  // Build relationships: target ← each dependent
  const relationships: Relationship[] = dependentSymbols.map((dep) => ({
    id: `${dep.id}->calls->${target}`,
    source: dep.id,
    target,
    relType: "calls",
    metadata: {},
  }));

  const allSymbols = [targetSymbol, ...dependentSymbols].slice(0, maxResults);
  const riskLevel = calculateImpactRisk(dependentSymbols);
  const affectedFlows = processes.map((p) => p.name);

  // Confidence: high when target resolved + dependents found
  const confidence = dependentSymbols.length > 0 ? 0.92 : 0.75;

  return {
    symbols: allSymbols,
    relationships,
    clusters,
    processes,
    confidence,
    riskLevel,
    affectedFlows,
  };
}
