/**
 * Context retrieval query implementation - 360° view of a symbol.
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */
import type { Session, ManagedTransaction } from "neo4j-driver";
import type { Symbol, Relationship, Process, QueryResult, SymbolKind, Visibility } from "../types/index.js";
import {
  txFindNode,
  txFindDependents,
  txFindDependencies,
  txFindProcessesBySymbol,
  txFindClustersBySymbol,
  txFindProcessSteps,
} from "../graph/query.js";
import type { GraphNode } from "../graph/connection.js";
import { graphNodeToCluster } from "./process-helpers.js";

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
 * Execute a context retrieval query - provides 360° view of a symbol.
 * All graph reads are consolidated into a single session.executeRead() transaction
 * to prevent "open transaction" errors in Neo4j driver v5+. (Req 2.6)
 *
 * Steps:
 * 1. Identify target symbol (Req 12.1)
 * 2. Find all callers using findDependents (Req 12.2)
 * 3. Find all callees using findDependencies (Req 12.3)
 * 4. Find all processes containing the symbol (Req 12.4)
 * 5. Find all clusters containing the symbol (Req 12.5)
 * 6. Return complete context (Req 12.6)
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 2.6
 */
export async function executeContextRetrieval(
  target: string,
  maxResults: number,
  graphSession: Session,
): Promise<Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">> {
  return graphSession.executeRead(async (tx: ManagedTransaction) => {
    // Req 12.1 — identify target symbol
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

    // Req 12.2 — find all callers (symbols that call this symbol)
    const callerNodes = await txFindDependents(tx, target);
    const callers = callerNodes.map(graphNodeToSymbol);

    // Req 12.3 — find all callees (symbols this symbol calls)
    const calleeNodes = await txFindDependencies(tx, target);
    const callees = calleeNodes.map(graphNodeToSymbol);

    // Req 12.4 — find all processes containing the symbol
    const processNodes = await txFindProcessesBySymbol(tx, target);
    const processes = await Promise.all(processNodes.map((n) => txGraphNodeToProcess(n, tx)));

    // Req 12.5 — find all clusters containing the symbol
    const clusterNodes = await txFindClustersBySymbol(tx, target);
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

    // Req 12.6 — return complete context
    return {
      symbols: allSymbols,
      relationships,
      clusters,
      processes,
      confidence,
      riskLevel: "low" as const,
      affectedFlows,
    };
  });
}
