/**
 * MCP tool implementations.
 * Requirements: 15.1, 15.2, 15.5, 15.6, 15.8
 */
import type { Pool } from "pg";
import type { Session } from "neo4j-driver";
import type { MCPToolResponse, QueryResult } from "../types/index.js";
import { executeQuery } from "../query/execute-query.js";
import { executeContextRetrieval } from "../query/context-retrieval.js";
import { executeImpactAnalysis } from "../query/impact-analysis.js";
import { executeDataFlowTrace } from "../query/data-flow-trace.js";

/**
 * Default maximum results for queries.
 */
const DEFAULT_MAX_RESULTS = 50;

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
 * Requirements: 15.1, 15.5, 15.6, 15.8
 */
async function executeGetSymbolContext(
  params: Record<string, unknown>,
  _vectorPool: Pool,
  graphSession: Session,
): Promise<MCPToolResponse> {
  const symbolName = params.symbolName as string;
  const maxResults = (params.maxResults as number) || DEFAULT_MAX_RESULTS;

  const result = await executeContextRetrieval(symbolName, maxResults, graphSession);

  const summary = `Found ${result.symbols.length} related symbols, ` +
    `${result.clusters.length} clusters, and ${result.processes.length} processes ` +
    `for symbol '${symbolName}'. Confidence: ${(result.confidence * 100).toFixed(0)}%.`;

  return formatMCPResponse(result, summary);
}

/**
 * Execute find_dependents tool.
 * Requirements: 15.1, 15.5, 15.6, 15.8
 */
async function executeFindDependents(
  params: Record<string, unknown>,
  _vectorPool: Pool,
  graphSession: Session,
): Promise<MCPToolResponse> {
  const symbolName = params.symbolName as string;
  const maxResults = (params.maxResults as number) || DEFAULT_MAX_RESULTS;

  // Use impact analysis to find dependents
  const result = await executeImpactAnalysis(symbolName, maxResults, graphSession);

  const summary = `Found ${result.symbols.length} dependents of '${symbolName}'. ` +
    `Risk level: ${result.riskLevel.toUpperCase()}. ` +
    `Affected flows: ${result.affectedFlows.length}. ` +
    `Confidence: ${(result.confidence * 100).toFixed(0)}%.`;

  return formatMCPResponse(result, summary);
}

/**
 * Execute trace_data_flow tool.
 * Requirements: 15.1, 15.5, 15.6, 15.8
 */
async function executeTraceDataFlow(
  params: Record<string, unknown>,
  _vectorPool: Pool,
  graphSession: Session,
): Promise<MCPToolResponse> {
  const entryPoint = params.entryPoint as string;
  const maxResults = (params.maxResults as number) || DEFAULT_MAX_RESULTS;

  const result = await executeDataFlowTrace(entryPoint, maxResults, graphSession);

  const summary = `Traced data flow from '${entryPoint}' through ${result.processes.length} processes. ` +
    `Found ${result.symbols.length} symbols in the flow. ` +
    `Confidence: ${(result.confidence * 100).toFixed(0)}%.`;

  return formatMCPResponse(result, summary);
}

/**
 * Execute impact_analysis tool.
 * Requirements: 15.1, 15.5, 15.6, 15.8
 */
async function executeImpactAnalysisTool(
  params: Record<string, unknown>,
  _vectorPool: Pool,
  graphSession: Session,
): Promise<MCPToolResponse> {
  const symbolName = params.symbolName as string;
  const changeType = (params.changeType as string) || "modify";
  const maxResults = (params.maxResults as number) || DEFAULT_MAX_RESULTS;

  const result = await executeImpactAnalysis(symbolName, maxResults, graphSession);

  const summary = `Impact analysis for ${changeType} of '${symbolName}': ` +
    `${result.symbols.length} affected symbols, ` +
    `${result.affectedFlows.length} affected flows. ` +
    `Risk: ${result.riskLevel.toUpperCase()}. ` +
    `Confidence: ${(result.confidence * 100).toFixed(0)}%.`;

  return formatMCPResponse(result, summary);
}

/**
 * Execute MCP tool by name.
 * Requirements: 15.1, 15.2, 15.5, 15.6, 15.8
 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  vectorPool: Pool,
  graphSession: Session,
): Promise<MCPToolResponse> {
  switch (toolName) {
    case "get_symbol_context":
      return executeGetSymbolContext(params, vectorPool, graphSession);

    case "find_dependents":
      return executeFindDependents(params, vectorPool, graphSession);

    case "trace_data_flow":
      return executeTraceDataFlow(params, vectorPool, graphSession);

    case "impact_analysis":
      return executeImpactAnalysisTool(params, vectorPool, graphSession);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
