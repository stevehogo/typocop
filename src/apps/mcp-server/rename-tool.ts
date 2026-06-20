/**
 * `rename` MCP tool — coordinated rename PREVIEW (D5).
 *
 * Resolves the target symbol (exact → fuzzy, optionally narrowed by `filePath`),
 * gathers the definition + edge-backed reference sites as HIGH-confidence edits,
 * and a word-boundary regex descriptor for the LOW-confidence text tail, via
 * {@link buildRenamePlan}. The plan is **always** a preview — this tool never
 * writes to the graph or the file system. The plan is attached on the ADDITIVE
 * optional `rename` field of {@link MCPToolResponse}.
 *
 * Requirements: 15.1, 15.5, 15.6, 15.8, 1.1, 1.2, 1.4, 1.5
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { buildRenamePlan } from "../../application/querying/rename-plan.js";

/**
 * Execute the `rename` MCP tool. Strictly read-only / preview.
 * Requirements: 15.1, 15.5, 15.6, 15.8
 */
export async function executeRenameTool(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
): Promise<MCPToolResponse> {
  const symbolName = params.symbolName as string;
  const newName = params.newName as string;
  const filePath = typeof params.filePath === "string" ? params.filePath : undefined;

  const graph = adapter.getGraphAdapter();
  const plan = await buildRenamePlan(symbolName, newName, graph, filePath);

  const resolution = plan.resolution;

  if (resolution.kind === "not_found") {
    const suggestions = resolution.suggestions.length > 0
      ? `Did you mean: ${resolution.suggestions.join(", ")}?`
      : "No similar symbols found.";
    return {
      symbols: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low",
      affectedFlows: [],
      summary: `Symbol '${symbolName}' not found — no rename plan. ${suggestions} ` +
        `0 high-confidence, 1 low-confidence, PREVIEW only — no files changed.`,
      rename: {
        preview: true,
        oldName: plan.oldName,
        newName: plan.newName,
        highConfidenceCount: plan.highConfidenceCount,
        lowConfidenceCount: plan.lowConfidenceCount,
        edits: [],
        lowConfidence: {
          pattern: plan.lowConfidence.pattern,
          flags: plan.lowConfidence.flags,
          confidence: plan.lowConfidence.confidence,
        },
      },
    };
  }

  const fuzzyPrefix = resolution.kind === "fuzzy"
    ? `Fuzzy matched '${symbolName}' → '${resolution.matchedName}'. `
    : "";

  const summary =
    `${fuzzyPrefix}Rename plan for '${plan.oldName}' → '${plan.newName}': ` +
    `${plan.highConfidenceCount} high-confidence, ${plan.lowConfidenceCount} low-confidence, ` +
    `PREVIEW only — no files changed.`;

  return {
    // Each high-confidence edit surfaces as a response symbol (file:line) so a
    // non-rename-aware consumer still sees the affected sites.
    symbols: plan.edits.map((e, i) => ({
      id: `${e.filePath}:${e.line}:${i}`,
      name: plan.oldName,
      kind: "function" as MCPToolResponse["symbols"][number]["kind"],
      location: { filePath: e.filePath, startLine: e.line },
      relationship: e.kind === "definition" ? "rename-definition" : "rename-reference",
    })),
    clusters: [],
    processes: [],
    // High when the symbol resolved exactly and we anchored real edit sites.
    confidence: resolution.kind === "exact" ? 0.9 : 0.75,
    riskLevel: "low",
    affectedFlows: [],
    summary,
    rename: {
      preview: true,
      oldName: plan.oldName,
      newName: plan.newName,
      highConfidenceCount: plan.highConfidenceCount,
      lowConfidenceCount: plan.lowConfidenceCount,
      edits: plan.edits.map((e) => ({
        filePath: e.filePath,
        line: e.line,
        confidence: e.confidence,
        kind: e.kind,
      })),
      lowConfidence: {
        pattern: plan.lowConfidence.pattern,
        flags: plan.lowConfidence.flags,
        confidence: plan.lowConfidence.confidence,
      },
    },
  };
}
