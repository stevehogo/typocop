/**
 * Query execution engine.
 * Requirements: 9.3, 9.4, 9.5, 9.6, 9.7, 23.3
 */
import type { Pool } from "pg";
import type { Session } from "neo4j-driver";
import type { Query, QueryResult, QueryIntent, Symbol, Relationship, Cluster, Process, RiskLevel } from "../types/index.js";
import { QUERY_TIMEOUT_MS } from "../utils/limits.js";
import { findNode } from "../graph/query.js";
import { parseQueryIntent } from "./parse-intent.js";
import { executeImpactAnalysis } from "./impact-analysis.js";

/**
 * Calculate risk level based on affected symbol count and criticality.
 * Requirements: 9.5, 10.4, 10.5, 10.6, 10.7
 */
function calculateRiskLevel(affectedCount: number, _symbols: Symbol[]): RiskLevel {
  // TODO: Check for core components (auth, payment, etc.) for CRITICAL
  if (affectedCount === 0) return "low";
  if (affectedCount <= 2) return "low";
  if (affectedCount <= 10) return "medium";
  return "high";
}

/**
 * Calculate confidence score based on symbol resolution completeness.
 * Requirements: 9.4, 21.2
 */
function calculateConfidence(
  symbols: Symbol[],
  relationships: Relationship[],
  _intent: QueryIntent,
): number {
  if (symbols.length === 0) return 0.5;
  
  // High confidence if we have both symbols and relationships
  if (symbols.length > 0 && relationships.length > 0) return 0.92;
  
  // Medium confidence if we have symbols but no relationships
  if (symbols.length > 0) return 0.75;
  
  return 0.5;
}

/**
 * Execute a query with timeout enforcement.
 * Requirements: 9.3, 9.4, 9.5, 9.6, 9.7, 23.3
 */
export async function executeQuery(
  query: Query,
  vectorPool: Pool,
  graphSession: Session,
): Promise<QueryResult> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Query timeout")), QUERY_TIMEOUT_MS),
  );

  const resultPromise = executeQueryInternal(query, vectorPool, graphSession);

  return Promise.race([resultPromise, timeoutPromise]);
}

async function executeQueryInternal(
  query: Query,
  _vectorPool: Pool,
  graphSession: Session,
): Promise<QueryResult> {
  const { intent, confidence: intentConfidence } = parseQueryIntent(query.text);

  if (intent.type === "impactAnalysis") {
    const result = await executeImpactAnalysis(intent.target, query.maxResults, graphSession);
    return { intent, ...result };
  }

  // Stub for remaining query types (tasks 18-21)
  const symbols: Symbol[] = [];
  const relationships: Relationship[] = [];
  const clusters: Cluster[] = [];
  const processes: Process[] = [];

  if (intent.type === "contextRetrieval") {
    const node = await findNode(graphSession, intent.target);
    if (node) {
      symbols.push({
        id: node.id,
        name: node.properties["name"] ?? node.id,
        kind: "function",
        location: {
          filePath: node.properties["filePath"] ?? "",
          startLine: parseInt(node.properties["startLine"] ?? "0"),
          startColumn: 0,
          endLine: parseInt(node.properties["endLine"] ?? "0"),
          endColumn: 0,
        },
        visibility: "public",
        modifiers: [],
      });
    }
  }

  // Enforce maxResults limit (Req 9.6)
  const limitedSymbols = symbols.slice(0, query.maxResults);

  const confidence = Math.max(
    calculateConfidence(limitedSymbols, relationships, intent),
    intentConfidence * 0.8,
  );

  const riskLevel = calculateRiskLevel(limitedSymbols.length, limitedSymbols);
  const affectedFlows: string[] = processes.map((p) => p.name);

  return {
    intent,
    symbols: limitedSymbols,
    relationships,
    clusters,
    processes,
    confidence,
    riskLevel,
    affectedFlows,
  };
}
