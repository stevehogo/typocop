/**
 * Query execution engine.
 * Requirements: 9.3, 9.4, 9.5, 9.6, 9.7, 23.3, 7.1
 */
import type { DatabaseAdapter } from "../core/ports/persistence.js";
import type { Query, QueryResult } from "../core/domain.js";
import { QUERY_TIMEOUT_MS } from "../platform/utils/limits.js";
import { parseQueryIntent } from "./parse-intent.js";
import { executeImpactAnalysis, calculateImpactRisk } from "./impact-analysis.js";
import { preprocessQuery, isValidQuery } from "./preprocess.js";
import { sanitizeQuery } from "../platform/security/sanitize.js";
import { calculateConfidence } from "./confidence.js";

/**
 * Execute a query with timeout enforcement.
 * Accepts a DatabaseAdapter instead of Pool + Session + prefix (Req 7.1).
 * Requirements: 9.3, 9.4, 9.5, 9.6, 9.7, 23.3, 7.1
 */
export async function executeQuery(
  query: Query,
  adapter: DatabaseAdapter,
): Promise<QueryResult> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Query timeout")), QUERY_TIMEOUT_MS),
  );

  const resultPromise = executeQueryInternal(query, adapter);

  return Promise.race([resultPromise, timeoutPromise]);
}

async function executeQueryInternal(
  query: Query,
  adapter: DatabaseAdapter,
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
  const { intent } = parseQueryIntent(processedText);

  const graphAdapter = adapter.getGraphAdapter();

  // Route to specific query handler based on intent
  if (intent.type === "impactAnalysis") {
    const result = await executeImpactAnalysis(intent.target, query.maxResults, graphAdapter);
    return { intent, ...result };
  }

  if (intent.type === "smartSearch") {
    const { executeSmartSearch } = await import("./smart-search.js");
    const embeddingAdapter = adapter.getEmbeddingAdapter();
    const vectorAdapter = adapter.getVectorAdapter();
    const result = await executeSmartSearch(
      intent.query,
      query.maxResults,
      vectorAdapter,
      graphAdapter,
      embeddingAdapter,
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
    const result = await executePreCommitCheck(intent.changedFiles, query.maxResults, graphAdapter);
    return { intent, ...result };
  }

  if (intent.type === "contextRetrieval") {
    const { executeContextRetrieval } = await import("./context-retrieval.js");
    const result = await executeContextRetrieval(intent.target, query.maxResults, graphAdapter);
    return { intent, ...result };
  }

  if (intent.type === "dataFlowTrace") {
    const { executeDataFlowTrace } = await import("./data-flow-trace.js");
    const result = await executeDataFlowTrace(intent.entryPoint, query.maxResults, graphAdapter);
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
