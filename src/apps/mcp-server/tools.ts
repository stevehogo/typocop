/**
 * MCP tool implementations.
 * Requirements: 15.1, 15.2, 15.5, 15.6, 15.8, 7.1
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { GitPort } from "../../core/ports/git.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { executeContextRetrieval } from "../../application/querying/context-retrieval.js";
import { sliceContext, type RelatedSymbol } from "../../application/querying/context-slice.js";
import { executeImpactAnalysis } from "../../application/querying/impact-analysis.js";
import { executeDataFlowTrace } from "../../application/querying/data-flow-trace.js";
import { executeSmartSearchTool } from "./smart-search-tool.js";
import { executeDetectChanges } from "./detect-changes-tool.js";
import { executeTraceTool } from "./trace-tool.js";
import { executeFindDeadCode } from "./dead-code-tool.js";
import { executeFindHotspots } from "./hotspots-tool.js";
import { executeRenameTool } from "./rename-tool.js";
import { executeShapeCheck, executeApiImpact } from "./shape-check-tool.js";
import { formatMCPResponse, type SymbolExplanation } from "./format-response.js";
import type { ImpactAnalysisResult } from "../../application/querying/impact-analysis.js";

/** Build the id→explanation map + a one-line digest for the summary (D2). */
function buildExplainability(result: ImpactAnalysisResult): {
  byId: Map<string, SymbolExplanation>;
  digest: string;
} {
  const byId = new Map<string, SymbolExplanation>();
  const explanations = result.explanations ?? [];
  for (const e of explanations) {
    byId.set(e.symbolId, { nodeRole: e.nodeRole, entryEdge: e.entryEdge, hopDistance: e.hopDistance });
  }
  if (explanations.length === 0) return { byId, digest: "" };

  const roleCounts = new Map<string, number>();
  let directCount = 0;
  for (const e of explanations) {
    roleCounts.set(e.nodeRole, (roleCounts.get(e.nodeRole) ?? 0) + 1);
    if (e.hopDistance <= 1) directCount += 1;
  }
  const roleSummary = [...roleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([role, n]) => `${n} ${role}`)
    .join(", ");
  // Lead reason from the highest-confidence affected node.
  const top = [...explanations].sort((a, b) => b.confidence - a.confidence)[0];
  const topReason = top?.reasons[0] ?? "";
  const digest = ` ${directCount} direct caller${directCount === 1 ? "" : "s"}; roles: ${roleSummary}.` +
    (topReason ? ` Top: ${topReason}.` : "");
  return { byId, digest };
}

/**
 * Default maximum results for queries.
 */
const DEFAULT_MAX_RESULTS = 100;

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

  // D4 — when a tokenBudget is supplied, slice the (target + depth-1 callers +
  // callees) context to fit. Default behaviour (no budget) is UNCHANGED.
  if (typeof params.tokenBudget === "number" && result.target) {
    const related: RelatedSymbol[] = [
      ...(result.callers ?? []).map((symbol) => ({ symbol, relation: "caller" as const })),
      ...(result.callees ?? []).map((symbol) => ({ symbol, relation: "callee" as const })),
    ];
    const pin = Array.isArray(params.pin)
      ? (params.pin as unknown[]).filter((p): p is string => typeof p === "string")
      : undefined;
    const slice = sliceContext(result.target, related, {
      tokenBudget: params.tokenBudget,
      ...(pin ? { pin } : {}),
      ...(typeof params.maxDepth === "number" ? { maxDepth: params.maxDepth } : {}),
    });
    const slicedResult = { ...result, symbols: slice.symbols.map((n) => n.symbol) };
    const reasonNote = slice.truncationReason === "complete"
      ? "complete"
      : slice.truncationReason === "token_budget"
        ? "truncated to fit token budget"
        : "truncated at max depth";
    const sliceSummary = `Context slice for '${symbolName}': ${slice.symbols.length} symbols, ` +
      `~${slice.estimatedTokens} tokens (budget ${slice.tokenBudget}, ${reasonNote}). ` +
      `Confidence: ${(result.confidence * 100).toFixed(0)}%.`;
    const prefix = resolution.kind === "fuzzy"
      ? `Fuzzy matched '${symbolName}' → '${resolution.matchedName}'. `
      : "";
    const response = formatMCPResponse(slicedResult, prefix + sliceSummary);
    response.truncationReason = slice.truncationReason;
    response.estimatedTokens = slice.estimatedTokens;
    return response;
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
  // D3: thread the previously-dead maxDepth into the traversal (clamped inside
  // executeImpactAnalysis to MAX_TRAVERSAL_DEPTH).
  const maxDepth = typeof params.maxDepth === "number" ? params.maxDepth : undefined;
  const graphAdapter = adapter.getGraphAdapter();
  const result = await executeImpactAnalysis(symbolName, maxResults, graphAdapter, maxDepth);

  const resolution = result.resolution;

  if (resolution.kind === "not_found") {
    const suggestions = resolution.suggestions.length > 0
      ? `Did you mean: ${resolution.suggestions.join(", ")}?`
      : "No similar symbols found.";
    return formatMCPResponse(result, `Symbol '${symbolName}' not found. ${suggestions}`);
  }

  const { byId, digest } = buildExplainability(result);

  const baseSummary = `Found ${result.symbols.length} dependents of '${symbolName}'. ` +
    `Risk level: ${result.riskLevel.toUpperCase()}. ` +
    `Affected flows: ${result.affectedFlows.length}. ` +
    `Confidence: ${(result.confidence * 100).toFixed(0)}%.` + digest;
  const summary = result.targetKind === "externalDependency"
    ? `External package '${result.targetName ?? symbolName}': ${result.symbols.length} dependent symbols. ` +
      `Risk level: ${result.riskLevel.toUpperCase()}. ` +
      `Affected flows: ${result.affectedFlows.length}. ` +
      `Confidence: ${(result.confidence * 100).toFixed(0)}%.`
    : baseSummary;

  if (resolution.kind === "fuzzy") {
    const fuzzyPrefix = `Fuzzy matched '${symbolName}' → '${resolution.matchedName}'. `;
    return formatMCPResponse(result, fuzzyPrefix + summary, byId);
  }

  return formatMCPResponse(result, summary, byId);
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

  const { byId, digest } = buildExplainability(result);

  const baseSummary = `Impact analysis for ${changeType} of '${symbolName}': ` +
    `${result.symbols.length} affected symbols, ` +
    `${result.affectedFlows.length} affected flows. ` +
    `Risk: ${result.riskLevel.toUpperCase()}. ` +
    `Confidence: ${(result.confidence * 100).toFixed(0)}%.` + digest;
  const summary = result.targetKind === "externalDependency"
    ? `External package '${result.targetName ?? symbolName}': ${result.symbols.length} dependent symbols, ` +
      `${result.affectedFlows.length} affected flows. ` +
      `Risk: ${result.riskLevel.toUpperCase()}. ` +
      `Confidence: ${(result.confidence * 100).toFixed(0)}%.`
    : baseSummary;

  if (resolution.kind === "fuzzy") {
    const fuzzyPrefix = `Fuzzy matched '${symbolName}' → '${resolution.matchedName}'. `;
    return formatMCPResponse(result, fuzzyPrefix + summary, byId);
  }

  return formatMCPResponse(result, summary, byId);
}

/**
 * Execute MCP tool by name.
 * Accepts DatabaseAdapter instead of Pool + Driver + SessionManager (Req 7.1).
 *
 * `git` is OPTIONAL and only required by the `detect_changes` tool (C2);
 * existing tools ignore it, so callers that don't construct a GitPort remain
 * fully backward compatible.
 * Requirements: 15.1, 15.2, 15.5, 15.6, 15.8, 17.1, 7.1
 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
  git?: GitPort,
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
    case "trace":
      return executeTraceTool(params, adapter);
    case "find_dead_code":
      return executeFindDeadCode(params, adapter);
    case "find_hotspots":
      return executeFindHotspots(params, adapter);
    case "rename":
      return executeRenameTool(params, adapter);
    case "shape_check":
      return executeShapeCheck(params, adapter);
    case "api_impact":
      return executeApiImpact(params, adapter);
    case "detect_changes": {
      if (!git) {
        throw new Error("detect_changes requires a GitPort (none injected)");
      }
      return executeDetectChanges(params, adapter, git);
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
