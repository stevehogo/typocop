/**
 * MCP tool implementations.
 * Requirements: 15.1, 15.2, 15.5, 15.6, 15.8, 7.1
 */
import type { DatabaseAdapter } from "../db/types.js";
import type { MCPToolResponse, QueryResult } from "../types/index.js";
import { executeContextRetrieval } from "../query/context-retrieval.js";
import { executeImpactAnalysis } from "../query/impact-analysis.js";
import { executeDataFlowTrace } from "../query/data-flow-trace.js";
import { executeSmartSearchTool } from "./smart-search-tool.js";

/**
 * Default maximum results for queries.
 */
const DEFAULT_MAX_RESULTS = 100;

/**
 * Partial QueryResult without intent field.
 */
type PartialQueryResult = Pick<QueryResult, "symbols" | "relationships" | "clusters" | "processes" | "confidence" | "riskLevel" | "affectedFlows">;

/**
 * Convert QueryResult to MCPToolResponse format.
 * Requirements: 15.6, 15.8
 */
function formatMCPResponse(result: PartialQueryResult, summary: string): MCPToolResponse {
  return {
    symbols: result.symbols.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      location: {
        filePath: s.location.filePath,
        startLine: s.location.startLine,
      },
      relationship: "related", // Default relationship type
    })),
    clusters: result.clusters.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      confidence: c.confidence,
    })),
    processes: result.processes.map((p) => ({
      id: p.id,
      name: p.name,
      stepNumber: 1, // First step
      totalSteps: p.steps.length,
    })),
    confidence: result.confidence,
    riskLevel: result.riskLevel,
    affectedFlows: result.affectedFlows,
    summary, // REQUIRED — human-readable summary (Req 15.8)
  };
}

/**
 * Execute get_symbol_context tool.
 * Requirements: 15.1, 15.5, 15.6, 15.8, 7.1, 2.1, 2.3, 2.4, 3.1, 3.3
 */
async function executeGetSymbolContext(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const symbolName = params.symbolName as string;
  const maxResults = (params.maxResults as number) || DEFAULT_MAX_RESULTS;
  const graphAdapter = adapter.getGraphAdapter();
  const result = await executeContextRetrieval(symbolName, maxResults, graphAdapter);

  const resolution = result.resolution;

  if (resolution.kind === "not_found") {
    const suggestions = resolution.suggestions.length > 0
      ? `Did you mean: ${resolution.suggestions.join(", ")}?`
      : "No similar symbols found.";
    return formatMCPResponse(result, `Symbol '${symbolName}' not found. ${suggestions}`);
  }

  const baseSummary = `Found ${result.symbols.length} related symbols, ` +
    `${result.clusters.length} clusters, and ${result.processes.length} processes ` +
    `for symbol '${symbolName}'. Confidence: ${(result.confidence * 100).toFixed(0)}%.`;

  if (resolution.kind === "fuzzy") {
    const fuzzyPrefix = `Fuzzy matched '${symbolName}' → '${resolution.matchedName}'. `;
    return formatMCPResponse(result, fuzzyPrefix + baseSummary);
  }

  return formatMCPResponse(result, baseSummary);
}

/**
 * Execute find_dependents tool.
 * Requirements: 15.1, 15.5, 15.6, 15.8, 7.1, 2.1, 2.3, 2.4, 3.1, 3.3
 */
async function executeFindDependents(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const symbolName = params.symbolName as string;
  const maxResults = (params.maxResults as number) || DEFAULT_MAX_RESULTS;
  const graphAdapter = adapter.getGraphAdapter();
  const result = await executeImpactAnalysis(symbolName, maxResults, graphAdapter);

  const resolution = result.resolution;

  if (resolution.kind === "not_found") {
    const suggestions = resolution.suggestions.length > 0
      ? `Did you mean: ${resolution.suggestions.join(", ")}?`
      : "No similar symbols found.";
    return formatMCPResponse(result, `Symbol '${symbolName}' not found. ${suggestions}`);
  }

  const baseSummary = `Found ${result.symbols.length} dependents of '${symbolName}'. ` +
    `Risk level: ${result.riskLevel.toUpperCase()}. ` +
    `Affected flows: ${result.affectedFlows.length}. ` +
    `Confidence: ${(result.confidence * 100).toFixed(0)}%.`;

  if (resolution.kind === "fuzzy") {
    const fuzzyPrefix = `Fuzzy matched '${symbolName}' → '${resolution.matchedName}'. `;
    return formatMCPResponse(result, fuzzyPrefix + baseSummary);
  }

  return formatMCPResponse(result, baseSummary);
}

/**
 * Execute trace_data_flow tool.
 * Requirements: 15.1, 15.5, 15.6, 15.8, 7.1, 2.1, 2.3, 2.4, 3.1, 3.3, 4.2
 */
async function executeTraceDataFlow(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const entryPoint = params.entryPoint as string;
  const framework = params.framework as string | undefined;
  const maxResults = (params.maxResults as number) || DEFAULT_MAX_RESULTS;
  const graphAdapter = adapter.getGraphAdapter();
  const result = await executeDataFlowTrace(entryPoint, maxResults, graphAdapter, framework);

  const resolution = result.resolution;

  if (resolution.kind === "not_found") {
    const suggestions = resolution.suggestions.length > 0
      ? `Did you mean: ${resolution.suggestions.join(", ")}?`
      : "No similar symbols found.";
    return formatMCPResponse(result, `Symbol '${entryPoint}' not found. ${suggestions}`);
  }

  const baseSummary = `Traced data flow from '${entryPoint}' through ${result.processes.length} processes. ` +
    `Found ${result.symbols.length} symbols in the flow. ` +
    `Confidence: ${(result.confidence * 100).toFixed(0)}%.`;

  if (resolution.kind === "fuzzy") {
    const fuzzyPrefix = `Fuzzy matched '${entryPoint}' → '${resolution.matchedName}'. `;
    return formatMCPResponse(result, fuzzyPrefix + baseSummary);
  }

  return formatMCPResponse(result, baseSummary);
}

/**
 * Execute impact_analysis tool.
 * Requirements: 15.1, 15.5, 15.6, 15.8, 7.1, 2.1, 2.3, 2.4, 3.1, 3.3
 */
async function executeImpactAnalysisTool(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const symbolName = params.symbolName as string;
  const changeType = (params.changeType as string) || "modify";
  const maxResults = (params.maxResults as number) || DEFAULT_MAX_RESULTS;
  const graphAdapter = adapter.getGraphAdapter();
  const result = await executeImpactAnalysis(symbolName, maxResults, graphAdapter);

  const resolution = result.resolution;

  if (resolution.kind === "not_found") {
    const suggestions = resolution.suggestions.length > 0
      ? `Did you mean: ${resolution.suggestions.join(", ")}?`
      : "No similar symbols found.";
    return formatMCPResponse(result, `Symbol '${symbolName}' not found. ${suggestions}`);
  }

  const baseSummary = `Impact analysis for ${changeType} of '${symbolName}': ` +
    `${result.symbols.length} affected symbols, ` +
    `${result.affectedFlows.length} affected flows. ` +
    `Risk: ${result.riskLevel.toUpperCase()}. ` +
    `Confidence: ${(result.confidence * 100).toFixed(0)}%.`;

  if (resolution.kind === "fuzzy") {
    const fuzzyPrefix = `Fuzzy matched '${symbolName}' → '${resolution.matchedName}'. `;
    return formatMCPResponse(result, fuzzyPrefix + baseSummary);
  }

  return formatMCPResponse(result, baseSummary);
}

/**
 * Execute MCP tool by name.
 * Accepts DatabaseAdapter instead of Pool + Driver + SessionManager (Req 7.1).
 * Requirements: 15.1, 15.2, 15.5, 15.6, 15.8, 17.1, 7.1
 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  switch (toolName) {
    case "get_symbol_context":
      return executeGetSymbolContext(params, adapter);
    case "find_dependents":
      return executeFindDependents(params, adapter);
    case "trace_data_flow":
      return executeTraceDataFlow(params, adapter);
    case "impact_analysis":
      return executeImpactAnalysisTool(params, adapter);
    case "smart_search":
      return executeSmartSearchTool(params, adapter);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
