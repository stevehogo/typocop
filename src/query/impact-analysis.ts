/**
 * Impact analysis query logic.
 * Requirements: 10.1, 10.2, 10.3, 10.8
 */
import type { Session, ManagedTransaction } from "neo4j-driver";
import type { Symbol, Relationship, Process, QueryResult, RiskLevel, SymbolKind, Visibility } from "../types/index.js";
import {
  txFindNode,
  txFindDependents,
  txFindProcessesBySymbol,
  txFindClustersBySymbol,
  txFindProcessSteps,
} from "../graph/query.js";
import type { GraphNode } from "../graph/connection.js";
import { graphNodeToCluster } from "./process-helpers.js";

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

async function txGraphNodeToProcess(node: GraphNode, tx: ManagedTransaction): Promise<Process> {
  const p = node.properties;
  const steps = await txFindProcessSteps(tx, node.id);
  return {
    id: node.id,
    name: p["name"] ?? node.id,
    entryPoint: p["entryPoint"] ?? "",
    steps,
    dataFlow: [],
  };
}

/**
 * Execute an impact analysis query.
 * All graph reads are consolidated into a single session.executeRead() transaction
 * to prevent "open transaction" errors in Neo4j driver v5+. (Req 2.6)
 *
 * Finds the target symbol, all transitive dependents, affected processes, and risk level.
 * Requirements: 10.1, 10.2, 10.3, 10.8, 2.6
 */
export async function executeImpactAnalysis(
  target: string,
  maxResults: number,
  graphSession: Session,
): Promise<Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">> {
  return graphSession.executeRead(async (tx: ManagedTransaction) => {
    // Req 10.1 — identify target symbol
    const targetNode = await txFindNode(tx, target);
    if (!targetNode) {
      return {
        symbols: [],
        relationships: [],
        clusters: [],
        processes: [],
        confidence: 0.5,
        riskLevel: "low" as const,
        affectedFlows: [],
      };
    }

    const targetSymbol = graphNodeToSymbol(targetNode);

    // Req 10.2 — find all direct and transitive dependents
    const dependentNodes = await txFindDependents(tx, target);
    const dependentSymbols = dependentNodes.map(graphNodeToSymbol);

    // Req 10.3 — identify affected business processes
    const processNodes = await txFindProcessesBySymbol(tx, target);
    const processes = await Promise.all(processNodes.map((n) => txGraphNodeToProcess(n, tx)));

    // Collect clusters for context
    const clusterNodes = await txFindClustersBySymbol(tx, target);
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
      symbols: allSymbols,
      relationships,
      clusters,
      processes,
      confidence,
      riskLevel,
      affectedFlows,
    };
  });
}
