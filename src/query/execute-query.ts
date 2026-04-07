/**
 * Query execution engine.
 * Requirements: 9.3, 9.4, 9.5, 9.6, 9.7, 23.3
 */
import type { Pool } from "pg";
import type { Session } from "neo4j-driver";
import type { Query, QueryResult, QueryIntent, Symbol, Relationship, Cluster, Process } from "../types/index.js";
import { QUERY_TIMEOUT_MS } from "../utils/limits.js";
import { findNode } from "../graph/query.js";
import { parseQueryIntent } from "./parse-intent.js";
import { executeImpactAnalysis, calculateImpactRisk } from "./impact-analysis.js";
import { preprocessQuery, isValidQuery } from "./preprocess.js";
import { sanitizeQuery } from "../security/sanitize.js";
import { calculateConfidence } from "./confidence.js";

/**
 * Execute a query with timeout enforcement.
 * Requirements: 9.3, 9.4, 9.5, 9.6, 9.7, 23.3
 */
export async function executeQuery(
  query: Query,
  vectorPool: Pool,
  graphSession: Session,
  prefix: string,
): Promise<QueryResult> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Query timeout")), QUERY_TIMEOUT_MS),
  );

  const resultPromise = executeQueryInternal(query, vectorPool, graphSession, prefix);

  return Promise.race([resultPromise, timeoutPromise]);
}

async function executeQueryInternal(
  query: Query,
  vectorPool: Pool,
  graphSession: Session,
  prefix: string,
): Promise<QueryResult> {
  // Preprocess and sanitize query text before intent parsing (Req 22.3)
  if (!isValidQuery(query.text)) {
    return {
      intent: { type: "smartSearch", query: "" },
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low",
      affectedFlows: [],
    };
  }
  const processedText = preprocessQuery(sanitizeQuery(query.text));
  const { intent, confidence: intentConfidence } = parseQueryIntent(processedText);

  // Route to specific query handler based on intent
  if (intent.type === "impactAnalysis") {
    const result = await executeImpactAnalysis(intent.target, query.maxResults, graphSession);
    return { intent, ...result };
  }

  if (intent.type === "smartSearch") {
    const { executeSmartSearch } = await import("./smart-search.js");
    const { generateEmbedding } = await import("../vector/embed.js");
    const result = await executeSmartSearch(
      intent.query,
      query.maxResults,
      vectorPool,
      graphSession,
      generateEmbedding,
      prefix,
    );
    const confidence = calculateConfidence(result.symbols, [], intent, result.searchResults);
    const riskLevel = calculateImpactRisk(result.symbols);
    const affectedFlows = result.processes.map((p) => p.name);

    return {
      intent,
      symbols: result.symbols,
      relationships: [],
      clusters: result.clusters,
      processes: result.processes,
      confidence,
      riskLevel,
      affectedFlows,
    };
  }

  if (intent.type === "preCommitCheck") {
    const { executePreCommitCheck } = await import("./pre-commit-check.js");
    const result = await executePreCommitCheck(intent.changedFiles, query.maxResults, graphSession);
    return { intent, ...result };
  }

  if (intent.type === "contextRetrieval") {
    const { executeContextRetrieval } = await import("./context-retrieval.js");
    const result = await executeContextRetrieval(intent.target, query.maxResults, graphSession);
    return { intent, ...result };
  }

  if (intent.type === "dataFlowTrace") {
    const { executeDataFlowTrace } = await import("./data-flow-trace.js");
    const result = await executeDataFlowTrace(intent.entryPoint, query.maxResults, graphSession);
    return { intent, ...result };
  }

  // Fallback for unimplemented query types
  return {
    intent,
    symbols: [],
    relationships: [],
    clusters: [],
    processes: [],
    confidence: 0.5,
    riskLevel: "low",
    affectedFlows: [],
  };
}
