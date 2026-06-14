/**
 * Phase 5 — Entry point detection.
 *
 * Identifies symbols that are likely execution entry points (API endpoints,
 * main functions, controllers) using a scoring formula:
 *
 *   finalScore = (calleeCount / (callerCount + 1)) × exportMultiplier × nameMultiplier
 *
 * Requirements: 3.5, 7.1
 */
import type { Symbol, Relationship } from "../../../core/domain.js";
import { MAX_ENTRY_POINTS } from "../../../platform/utils/limits.js";

// ─── Name patterns ────────────────────────────────────────────────────────────

const ENTRY_POINT_PATTERNS: RegExp[] = [
  /^(main|init|bootstrap|start|run|setup|configure)$/i,
  /^handle[A-Z]/,
  /^on[A-Z]/,
  /Handler$/,
  /Controller$/,
  /^process[A-Z]/,
  /^execute[A-Z]/,
  /^perform[A-Z]/,
  /^dispatch[A-Z]/,
  /^(index|show|store|update|destroy|create|edit)$/,
  /^__invoke$/,
  /^(get|post|put|delete|patch)[A-Z]/,
];

const UTILITY_PATTERNS: RegExp[] = [
  /^(get|set|is|has|can|should|will|did)[A-Z]/,
  /^_/,
  /^(format|parse|validate|convert|transform)/i,
  /^(log|debug|error|warn|info)$/i,
  /^(to|from)[A-Z]/,
  /Helper$/,
  /Util(s)?$/,
];

// ─── Score calculation ────────────────────────────────────────────────────────

/**
 * Calculate entry point score for a symbol.
 * Returns 0 if the symbol has no outgoing calls (can't be an entry point).
 */
export function calculateEntryPointScore(
  name: string,
  isExported: boolean,
  callerCount: number,
  calleeCount: number,
): number {
  if (calleeCount === 0) return 0;

  const baseScore = calleeCount / (callerCount + 1);
  const exportMultiplier = isExported ? 2.0 : 1.0;

  let nameMultiplier = 1.0;
  if (UTILITY_PATTERNS.some((p) => p.test(name))) {
    nameMultiplier = 0.3;
  } else if (ENTRY_POINT_PATTERNS.some((p) => p.test(name))) {
    nameMultiplier = 1.5;
  }

  return baseScore * exportMultiplier * nameMultiplier;
}

// ─── Call graph ───────────────────────────────────────────────────────────────

/** Adjacency list: symbolId → set of callee symbolIds */
export type CallGraph = Map<string, Set<string>>;

/**
 * Build a forward call graph from "calls" relationships.
 * Only includes relationships where both source and target exist in symbolIds.
 */
export function buildCallGraph(
  symbolIds: Set<string>,
  relationships: Relationship[],
): CallGraph {
  const graph: CallGraph = new Map();
  for (const id of symbolIds) {
    graph.set(id, new Set());
  }
  for (const rel of relationships) {
    if (rel.relType !== "calls") continue;
    if (!symbolIds.has(rel.source) || !symbolIds.has(rel.target)) continue;
    graph.get(rel.source)!.add(rel.target);
  }
  return graph;
}

// ─── Entry point detection ────────────────────────────────────────────────────

/** Minimum score threshold for a symbol to be considered an entry point. */
const ENTRY_POINT_THRESHOLD = 1.0;

/**
 * Find entry point symbols from the given symbol set.
 *
 * A symbol qualifies as an entry point when:
 * - It is a function, method, or class
 * - It has at least one outgoing call
 * - Its entry point score exceeds the threshold
 *
 * Returns symbol IDs sorted by score descending.
 *
 * `prebuiltCallGraph` lets a caller that already built the forward call graph
 * (e.g. {@link traceProcesses}) reuse it instead of rebuilding it here. When
 * omitted, the graph is built internally — backward compatible with existing
 * callers and tests. Results are byte-identical either way.
 *
 * `maxEntryPoints` caps how many of the highest-scoring entry points are
 * returned (Phase F). It defaults to {@link MAX_ENTRY_POINTS} (`Infinity`), so
 * the default behavior is UNLIMITED and unchanged. Because results are already
 * sorted by score descending, the cap simply keeps the top-N — it never
 * reorders or rescore anything.
 *
 * Requirements: 7.1
 */
export function findEntryPoints(
  symbols: Symbol[],
  relationships: Relationship[],
  prebuiltCallGraph?: CallGraph,
  maxEntryPoints: number = MAX_ENTRY_POINTS,
): string[] {
  const callGraph =
    prebuiltCallGraph ??
    buildCallGraph(new Set(symbols.map((s) => s.id)), relationships);

  // Build reverse call graph for caller counts
  const callerCounts = new Map<string, number>();
  for (const [, callees] of callGraph) {
    for (const calleeId of callees) {
      callerCounts.set(calleeId, (callerCounts.get(calleeId) ?? 0) + 1);
    }
  }

  const candidates: { id: string; score: number }[] = [];

  for (const sym of symbols) {
    if (sym.kind !== "function" && sym.kind !== "method" && sym.kind !== "class") {
      continue;
    }

    const callees = callGraph.get(sym.id);
    if (!callees || callees.size === 0) continue;

    const callerCount = callerCounts.get(sym.id) ?? 0;
    const calleeCount = callees.size;
    const isExported = sym.visibility === "public";

    const score = calculateEntryPointScore(sym.name, isExported, callerCount, calleeCount);
    if (score > ENTRY_POINT_THRESHOLD) {
      candidates.push({ id: sym.id, score });
    }
  }

  const sorted = candidates.sort((a, b) => b.score - a.score).map((c) => c.id);
  // Default cap is Infinity → slice is a no-op, preserving full output.
  return maxEntryPoints === Infinity ? sorted : sorted.slice(0, Math.max(0, maxEntryPoints));
}
