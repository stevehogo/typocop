/**
 * detect_changes MCP tool (C2) — the 6th MCP tool.
 *
 * Composes the change-driven seams that already exist:
 *   GitPort.diff(scope, baseRef)
 *     → resolveChangedSymbols(fileDiffs, graphAdapter)   (C1)
 *     → executePreCommitCheck(changedFiles, maxResults, graphAdapter)
 *     → formatMCPResponse(result, summary)
 *
 * Reuses `pre-commit-check`'s CRITICAL elevation for auth/payment/checkout/
 * security/session/token names. Not-a-repo / no-changes → a clean low-risk
 * response with confidence 0.95.
 *
 * LAYERING: composition root (apps/). Git access is injected as a `GitPort`
 * so this stays testable with a fake adapter and the application layer never
 * shells out.
 */
import type { DatabaseAdapter } from "../../core/ports/persistence.js";
import type { GitPort, DiffScope, FileDiff } from "../../core/ports/git.js";
import type { MCPToolResponse } from "../../core/domain.js";
import { resolveChangedSymbols } from "../../application/querying/changed-symbols.js";
import { executePreCommitCheck } from "../../application/querying/pre-commit-check.js";
import { formatMCPResponse } from "./format-response.js";

const DEFAULT_MAX_RESULTS = 100;
const VALID_SCOPES: readonly DiffScope[] = ["unstaged", "staged", "all", "compare"];

/** A clean, low-risk response used for not-a-repo / no-changes (confidence 0.95). */
function cleanResponse(summary: string): MCPToolResponse {
  return formatMCPResponse(
    {
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.95,
      riskLevel: "low",
      affectedFlows: [],
    },
    summary,
  );
}

/**
 * Execute the detect_changes MCP tool.
 *
 * @param params  `{ scope?, baseRef?, maxResults? }`
 * @param adapter DatabaseAdapter (graph access for blast-radius)
 * @param git     injected GitPort (working-tree / staged / ref-compare diffs)
 */
export async function executeDetectChanges(
  params: Record<string, unknown>,
  adapter: DatabaseAdapter,
  git: GitPort,
): Promise<MCPToolResponse> {
  const scope: DiffScope = VALID_SCOPES.includes(params.scope as DiffScope)
    ? (params.scope as DiffScope)
    : "unstaged";
  const baseRef = typeof params.baseRef === "string" ? params.baseRef : undefined;
  const maxResults =
    typeof params.maxResults === "number" && params.maxResults > 0
      ? params.maxResults
      : DEFAULT_MAX_RESULTS;

  // Not a git repository → clean low-risk response.
  if (!(await git.isRepository())) {
    return cleanResponse("Not a git repository. No changes to analyze.");
  }

  const fileDiffs: FileDiff[] = await git.diff(scope, baseRef);

  if (fileDiffs.length === 0) {
    return cleanResponse(`No changes detected (${scope}).`);
  }

  const graphAdapter = adapter.getGraphAdapter();

  // C1: narrow the diff to the precise symbol set + the files that own them.
  const { changedFiles } = await resolveChangedSymbols(fileDiffs, graphAdapter);

  // No persisted symbols overlap the changes (e.g. unindexed/non-code files):
  // still report the file count, but blast radius is empty → low risk.
  const filesToCheck = changedFiles.length > 0 ? changedFiles : fileDiffs.map((d) => d.path);

  const result = await executePreCommitCheck(filesToCheck, maxResults, graphAdapter);

  const affectedSymbolCount = result.symbols.length;
  const flowCount = result.processes.length;
  const summary =
    `Detected ${fileDiffs.length} changed file(s) (${scope}), ` +
    `${affectedSymbolCount} affected symbol(s). ` +
    `Risk: ${result.riskLevel.toUpperCase()}. ` +
    `Affected flows: ${flowCount}. ` +
    `Confidence: ${(result.confidence * 100).toFixed(0)}%.`;

  return formatMCPResponse(result, summary);
}
