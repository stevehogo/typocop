/**
 * MCP tool implementations.
 * Requirements: 15.1, 15.2, 15.5, 15.6, 15.8, 7.1
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { GitPort } from "../../core/ports/git.js";
import type { MCPToolResponse, Language } from "../../core/domain.js";
import { executeContextRetrieval, type ContextRetrievalResult } from "../../application/querying/context-retrieval.js";
import { sliceContext, type RelatedSymbol } from "../../application/querying/context-slice.js";
import { executeImpactAnalysis } from "../../application/querying/impact-analysis.js";
import { executeDataFlowTrace } from "../../application/querying/data-flow-trace.js";
import { executeSmartSearchTool } from "./smart-search-tool.js";
import { executeDetectChanges } from "./detect-changes-tool.js";
import { executeTraceTool } from "./trace-tool.js";
import { executeFindDeadCode } from "./dead-code-tool.js";
import { executeFindHotspots } from "./hotspots-tool.js";
import { executeRenameTool } from "./rename-tool.js";
import { executeShapeCheck } from "./shape-check-tool.js";
import { executePdgQuery } from "./pdg-query-tool.js";
import { executeExplain } from "./explain-tool.js";
import { executeVerifyClaimTool } from "./verify-claim-tool.js";
import { executeQueryGraph } from "./query-graph-tool.js";
import { executeRouteMap } from "./route-map-tool.js";
import { executeTableTouch } from "./table-touch-tool.js";
import { executeEventChannel } from "./event-channel-tool.js";
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
 * Wave 8 (T6): attach the heritage / MRO block to a get_symbol_context response
 * when the target has any persisted heritage edges. ADDITIVE — absent when the
 * symbol has no ancestors/interfaces/overrides, so the wire shape is unchanged
 * for plain functions. `mroDiagnosticsUnavailable` is always true: the full C3
 * linearisation + ambiguity diagnostics are NOT persisted (only the resolved
 * edges are), so `ancestors` is distance-ordered, not C3-ordered.
 */
function attachHeritage(
  response: MCPToolResponse,
  result: ContextRetrievalResult,
): MCPToolResponse {
  const h = result.heritage;
  if (!h) return response;
  const hasAny = h.ancestors.length > 0 || h.interfaces.length > 0 || h.overrides.length > 0;
  if (!hasAny) return response;
  response.heritage = {
    ancestors: h.ancestors.map((a) => ({ id: a.id, name: a.name, depth: a.depth })),
    interfaces: h.interfaces.map((i) => ({ id: i.id, name: i.name })),
    overrides: h.overrides.map((o) => ({ id: o.id, name: o.name, relation: o.relation })),
    mroDiagnosticsUnavailable: true,
  };
  return response;
}

/** Build a short heritage digest for the summary, or "" when there is none. */
function heritageDigest(result: ContextRetrievalResult): string {
  const h = result.heritage;
  if (!h) return "";
  const parts: string[] = [];
  if (h.ancestors.length > 0) {
    parts.push(`extends ${h.ancestors.map((a) => a.name).join(" → ")}`);
  }
  if (h.interfaces.length > 0) {
    parts.push(`implements ${h.interfaces.map((i) => i.name).join(", ")}`);
  }
  if (h.overrides.length > 0) {
    const overridesN = h.overrides.filter((o) => o.relation === "overrides").length;
    const implN = h.overrides.length - overridesN;
    const segs: string[] = [];
    if (overridesN > 0) segs.push(`overrides ${overridesN} method${overridesN === 1 ? "" : "s"}`);
    if (implN > 0) segs.push(`satisfies ${implN} interface method${implN === 1 ? "" : "s"}`);
    parts.push(segs.join(", "));
  }
  return parts.length > 0 ? ` Heritage: ${parts.join("; ")}.` : "";
}

/**
 * File-extension → language map for the language-coverage summary (T8). There is
 * NO persisted per-Symbol language column, so coverage is DERIVED from the
 * symbol's file path. Kept local to the read layer (a small lookup) rather than
 * importing the infrastructure parser's map, so the querying/MCP layer stays
 * decoupled from the parsing layer.
 */
const EXTENSION_TO_LANGUAGE: Readonly<Record<string, Language>> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", php: "php", java: "java", go: "go", rs: "rust",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", rb: "ruby", swift: "swift",
};

/** Derive a {@link Language} from a file path's extension, or undefined. */
function languageOf(filePath: string): Language | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXTENSION_TO_LANGUAGE[filePath.slice(dot + 1).toLowerCase()];
}

/**
 * Wave 8 (T8): attach the per-symbol insights block — target language, a
 * language-coverage breakdown across the returned context symbols, and the
 * ORM-model documentation summary (e.g. the Eloquent `fillable`/relations digest
 * folded into the model class's `documentation`). All fields are additive and
 * omitted when empty, so the wire shape is unchanged for symbols with none.
 */
function attachSymbolInsights(
  response: MCPToolResponse,
  result: ContextRetrievalResult,
): MCPToolResponse {
  const targetLanguage = result.target ? languageOf(result.target.location.filePath) : undefined;

  const coverage: Record<string, number> = {};
  for (const s of response.symbols) {
    const lang = languageOf(s.location.filePath);
    if (lang) coverage[lang] = (coverage[lang] ?? 0) + 1;
  }

  const modelDocumentation = result.target?.documentation;

  const insights: NonNullable<MCPToolResponse["symbolInsights"]> = {
    ...(targetLanguage ? { language: targetLanguage } : {}),
    ...(Object.keys(coverage).length > 0 ? { languageCoverage: coverage } : {}),
    ...(modelDocumentation ? { modelDocumentation } : {}),
  };

  if (Object.keys(insights).length > 0) {
    response.symbolInsights = insights;
  }
  return response;
}

/** Build a short insights digest (target language + model docs) for the summary. */
function insightsDigest(result: ContextRetrievalResult): string {
  if (!result.target) return "";
  const parts: string[] = [];
  const lang = languageOf(result.target.location.filePath);
  if (lang) parts.push(`Language: ${lang}`);
  if (result.target.documentation) parts.push(`Model: ${result.target.documentation}`);
  return parts.length > 0 ? ` ${parts.join(". ")}.` : "";
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
    return attachSymbolInsights(attachHeritage(response, result), result);
  }

  const baseSummary = `Found ${result.symbols.length} related symbols, ` +
    `${result.clusters.length} clusters, and ${result.processes.length} processes ` +
    `for symbol '${symbolName}'. Confidence: ${(result.confidence * 100).toFixed(0)}%.` +
    heritageDigest(result) + insightsDigest(result);

  if (resolution.kind === "fuzzy") {
    const fuzzyPrefix = `Fuzzy matched '${symbolName}' → '${resolution.matchedName}'. `;
    return attachSymbolInsights(attachHeritage(formatMCPResponse(result, fuzzyPrefix + baseSummary), result), result);
  }

  return attachSymbolInsights(attachHeritage(formatMCPResponse(result, baseSummary), result), result);
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
  // Wave 8 (T7): optional confidence floor for the data-touch edges. Absent →
  // today's behaviour unchanged.
  const minConfidence = typeof params.minConfidence === "number" ? params.minConfidence : undefined;
  const graphAdapter = adapter.getGraphAdapter();
  const result = await executeDataFlowTrace(entryPoint, maxResults, graphAdapter, framework, minConfidence);

  const resolution = result.resolution;

  if (resolution.kind === "not_found") {
    const suggestions = resolution.suggestions.length > 0
      ? `Did you mean: ${resolution.suggestions.join(", ")}?`
      : "No similar symbols found.";
    return formatMCPResponse(result, `Symbol '${entryPoint}' not found. ${suggestions}`);
  }

  const confidenceById = result.edgeConfidenceById;
  const floorNote = minConfidence !== undefined ? ` (min edge confidence ${minConfidence}).` : "";
  const baseSummary = `Traced data flow from '${entryPoint}' through ${result.processes.length} processes. ` +
    `Found ${result.symbols.length} symbols in the flow. ` +
    `Confidence: ${(result.confidence * 100).toFixed(0)}%.` + floorNote;

  if (resolution.kind === "fuzzy") {
    const fuzzyPrefix = `Fuzzy matched '${entryPoint}' → '${resolution.matchedName}'. `;
    return formatMCPResponse(result, fuzzyPrefix + baseSummary, undefined, confidenceById);
  }

  return formatMCPResponse(result, baseSummary, undefined, confidenceById);
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
  // Optional depth bound for the transitive-dependent traversal (folded in from
  // the former find_dependents; clamped to MAX_TRAVERSAL_DEPTH inside the engine).
  const maxDepth = typeof params.maxDepth === "number" ? params.maxDepth : undefined;
  // Wave 8 (T7): optional confidence floor (no-op on the confidence-less CALLS
  // path today; absent → unchanged).
  const minConfidence = typeof params.minConfidence === "number" ? params.minConfidence : undefined;
  const graphAdapter = adapter.getGraphAdapter();
  const result = await executeImpactAnalysis(symbolName, maxResults, graphAdapter, maxDepth, minConfidence);

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
    case "verify_claim":
      return executeVerifyClaimTool(params, adapter);
    case "query_graph":
      return executeQueryGraph(params, adapter);
    case "route_map":
      return executeRouteMap(params, adapter);
    case "what_reads_table":
      return executeTableTouch(params, adapter, "reads");
    case "what_writes_table":
      return executeTableTouch(params, adapter, "writes");
    case "what_publishes_to":
      return executeEventChannel(params, adapter, "publishers");
    case "what_subscribes_to":
      return executeEventChannel(params, adapter, "subscribers");
    case "detect_changes": {
      if (!git) {
        throw new Error("detect_changes requires a GitPort (none injected)");
      }
      return executeDetectChanges(params, adapter, git);
    }
    case "pdg_query":
      return executePdgQuery(params, adapter);
    case "explain":
      return executeExplain(params, adapter);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
