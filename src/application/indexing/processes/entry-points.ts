/**
 * Phase 5 — Entry point detection.
 *
 * Identifies symbols that are likely execution entry points (API endpoints,
 * main functions, controllers) using a scoring formula:
 *
 *   finalScore = (calleeCount / (callerCount + 1))
 *              × exportMultiplier × nameMultiplier × frameworkMultiplier
 *
 * Wave 2 (1.1) additions over the original numeric-only score:
 *   - LANGUAGE-KEYED name patterns (`MERGED_ENTRY_POINT_PATTERNS`), test-file
 *     EXCLUSION + utility-file penalty, a PATH-based framework multiplier, an
 *     `EntryPointKind` classification, and a `reasons[]` explainability trail.
 *   - The export multiplier now reads the real per-language `isExported` signal,
 *     falling back to the pre-Wave-2 `visibility === "public"` heuristic.
 * The numeric `score` (and the `> ENTRY_POINT_THRESHOLD` compare) is unchanged in
 * meaning; `kind`/`reasons` are additive metadata.
 *
 * Requirements: 3.5, 7.1
 */
import type { Symbol, Relationship, Language, EntryPointKind } from "../../../core/domain.js";
import { MAX_ENTRY_POINTS } from "../../../platform/utils/limits.js";
import {
  ENTRY_POINT_PATTERNS,
  MERGED_ENTRY_POINT_PATTERNS,
  UTILITY_PATTERNS,
  isUtilityName,
  isTestFile,
  isUtilityFile,
  inferEntryPointKind,
} from "../../../platform/utils/entry-point-names.js";
import { frameworkEntryPointMultiplier } from "../../../platform/utils/framework-multiplier.js";

// ─── Name patterns ────────────────────────────────────────────────────────────

// ENTRY_POINT_PATTERNS / isEntryPointName / the language-keyed table / the
// utility patterns / the path predicates / inferEntryPointKind all live in the
// platform leaf (platform/utils/entry-point-names.ts) so dead-code detection
// (D6) and the querying layer can reuse them without crossing the application
// sibling boundary. Re-exported here to preserve this module's public surface.
export {
  ENTRY_POINT_PATTERNS,
  MERGED_ENTRY_POINT_PATTERNS,
  UTILITY_PATTERNS,
  isEntryPointName,
} from "../../../platform/utils/entry-point-names.js";

// ─── Score calculation ────────────────────────────────────────────────────────

/** Result of {@link calculateEntryPointScore} — numeric score + explainability. */
export interface EntryPointScoreResult {
  /** Numeric entry-point score (compared against `ENTRY_POINT_THRESHOLD`). */
  readonly score: number;
  /** Explainability trail (e.g. `base:2.00`, `exported`, `entry-pattern`). */
  readonly reasons: string[];
  /** Classification of the entry point (name/path/reasons driven). */
  readonly kind: EntryPointKind;
}

/**
 * Calculate the entry-point score for a symbol, with a `reasons[]` trail and a
 * `kind` classification.
 *
 * Returns `score: 0` when the symbol has no outgoing calls (can't be an entry
 * point). The numeric formula is `base × export × name × framework`.
 *
 * `language` selects the per-language name-pattern set; `filePath` (optional)
 * drives the path-based framework multiplier and kind classification.
 */
export function calculateEntryPointScore(
  name: string,
  language: Language,
  isExported: boolean,
  callerCount: number,
  calleeCount: number,
  filePath = "",
): EntryPointScoreResult {
  const reasons: string[] = [];

  if (calleeCount === 0) {
    return { score: 0, reasons: ["no-outgoing-calls"], kind: "main" };
  }

  const baseScore = calleeCount / (callerCount + 1);
  reasons.push(`base:${baseScore.toFixed(2)}`);

  const exportMultiplier = isExported ? 2.0 : 1.0;
  if (isExported) reasons.push("exported");

  // Name pattern scoring — utility (negative) patterns are checked first and are
  // exclusive: a utility name never also receives the entry-pattern bonus.
  let nameMultiplier = 1.0;
  if (isUtilityName(name)) {
    nameMultiplier = 0.3;
    reasons.push("utility-pattern");
  } else if ((MERGED_ENTRY_POINT_PATTERNS[language] ?? ENTRY_POINT_PATTERNS).some((p) => p.test(name))) {
    nameMultiplier = 1.5;
    reasons.push("entry-pattern");
  }

  // Path-based framework multiplier (Wave 2, 1.1).
  let frameworkMultiplier = 1.0;
  if (filePath) {
    const hint = frameworkEntryPointMultiplier(filePath);
    if (hint) {
      frameworkMultiplier = hint.multiplier;
      reasons.push(`framework:${hint.reason}`);
    }
    // Utility files are de-prioritised with a small penalty (NOT a hard skip).
    if (isUtilityFile(filePath)) {
      frameworkMultiplier *= 0.5;
      reasons.push("utility-file");
    }
  }

  const score = baseScore * exportMultiplier * nameMultiplier * frameworkMultiplier;
  const kind = inferEntryPointKind(name, filePath, reasons);
  return { score, reasons, kind };
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
 * The export signal for a symbol: prefer the real per-language `isExported`
 * (Wave 2, 1.3), falling back to the pre-Wave-2 `visibility === "public"`
 * heuristic for symbols indexed before the field existed / where the checker
 * abstained.
 */
function symbolIsExported(sym: Symbol): boolean {
  return sym.isExported ?? (sym.visibility === "public");
}

/** Internal: score a single symbol, returning its full result (or null if not eligible). */
function scoreSymbol(
  sym: Symbol,
  callGraph: CallGraph,
  callerCounts: Map<string, number>,
): EntryPointScoreResult | null {
  if (sym.kind !== "function" && sym.kind !== "method" && sym.kind !== "class") {
    return null;
  }
  // Test files are never entry points for features (Wave 2, 1.1).
  if (isTestFile(sym.location.filePath)) return null;

  const callees = callGraph.get(sym.id);
  if (!callees || callees.size === 0) return null;

  const callerCount = callerCounts.get(sym.id) ?? 0;
  return calculateEntryPointScore(
    sym.name,
    inferLanguage(sym),
    symbolIsExported(sym),
    callerCount,
    callees.size,
    sym.location.filePath,
  );
}

/**
 * Best-effort language inference from a symbol's file extension. Symbols do not
 * carry a `language` field, so the entry-point name table is selected from the
 * path extension; an unknown extension falls back to the universal patterns via
 * the `?? ENTRY_POINT_PATTERNS` guard inside {@link calculateEntryPointScore}.
 */
function inferLanguage(sym: Symbol): Language {
  const fp = sym.location.filePath.toLowerCase();
  if (fp.endsWith(".ts") || fp.endsWith(".tsx")) return "typescript";
  if (fp.endsWith(".js") || fp.endsWith(".jsx") || fp.endsWith(".mjs") || fp.endsWith(".cjs")) return "javascript";
  if (fp.endsWith(".py")) return "python";
  if (fp.endsWith(".java")) return "java";
  if (fp.endsWith(".go")) return "go";
  if (fp.endsWith(".rs")) return "rust";
  if (fp.endsWith(".cpp") || fp.endsWith(".cc") || fp.endsWith(".cxx") || fp.endsWith(".hpp")) return "cpp";
  if (fp.endsWith(".c") || fp.endsWith(".h")) return "c";
  if (fp.endsWith(".cs")) return "csharp";
  if (fp.endsWith(".rb")) return "ruby";
  if (fp.endsWith(".swift")) return "swift";
  if (fp.endsWith(".php")) return "php";
  // Fallback — universal patterns still apply via the lookup guard.
  return "typescript";
}

/**
 * Find entry point symbols from the given symbol set.
 *
 * A symbol qualifies as an entry point when:
 * - It is a function, method, or class
 * - It is NOT in a test file (Wave 2, 1.1)
 * - It has at least one outgoing call
 * - Its entry point score exceeds the threshold
 *
 * Returns symbol IDs sorted by score descending.
 *
 * `prebuiltCallGraph` lets a caller that already built the forward call graph
 * (e.g. {@link traceProcesses}) reuse it instead of rebuilding it here. When
 * omitted, the graph is built internally — backward compatible with existing
 * callers and tests.
 *
 * `maxEntryPoints` caps how many of the highest-scoring entry points are
 * returned (Phase F). It defaults to {@link MAX_ENTRY_POINTS} (`Infinity`), so
 * the default behavior is UNLIMITED.
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

  const callerCounts = buildCallerCounts(callGraph);

  const candidates: { id: string; score: number }[] = [];
  for (const sym of symbols) {
    const result = scoreSymbol(sym, callGraph, callerCounts);
    if (result && result.score > ENTRY_POINT_THRESHOLD) {
      candidates.push({ id: sym.id, score: result.score });
    }
  }

  const sorted = candidates.sort((a, b) => b.score - a.score).map((c) => c.id);
  // Default cap is Infinity → slice is a no-op, preserving full output.
  return maxEntryPoints === Infinity ? sorted : sorted.slice(0, Math.max(0, maxEntryPoints));
}

/**
 * Annotate each symbol that scores above the entry-point threshold with its
 * `entryPointKind` + `entryPointReason` (Wave 2, 1.1) so the persisted node can
 * carry them. Returns a NEW array; symbols below the threshold (and non-eligible
 * symbols) are returned unchanged, so the Symbol shape stays pre-Wave-2 identical
 * where no entry-point metadata applies (golden output unchanged).
 *
 * Additive + best-effort: it never reorders symbols and never affects which
 * edges/processes are emitted.
 */
export function annotateEntryPoints(
  symbols: Symbol[],
  relationships: Relationship[],
  prebuiltCallGraph?: CallGraph,
): Symbol[] {
  if (symbols.length === 0) return symbols;
  const callGraph =
    prebuiltCallGraph ??
    buildCallGraph(new Set(symbols.map((s) => s.id)), relationships);
  const callerCounts = buildCallerCounts(callGraph);

  let changed = false;
  const out = symbols.map((sym) => {
    const result = scoreSymbol(sym, callGraph, callerCounts);
    if (!result || result.score <= ENTRY_POINT_THRESHOLD) return sym;
    changed = true;
    return { ...sym, entryPointKind: result.kind, entryPointReason: result.reasons.join(", ") };
  });
  return changed ? out : symbols;
}

/** Build a reverse-edge caller-count map from a forward call graph. */
function buildCallerCounts(callGraph: CallGraph): Map<string, number> {
  const callerCounts = new Map<string, number>();
  for (const [, callees] of callGraph) {
    for (const calleeId of callees) {
      callerCounts.set(calleeId, (callerCounts.get(calleeId) ?? 0) + 1);
    }
  }
  return callerCounts;
}
