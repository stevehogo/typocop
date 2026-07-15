/**
 * Token-budgeted context slicing (D4).
 *
 * Given a resolved target symbol and its related symbols (depth-1 callers and
 * callees, as produced by {@link executeContextRetrieval}), collect the minimal
 * ordered set of symbols that fits within a token budget.
 *
 * Ordering is deterministic BFS: the target first, then depth-1 callers, then
 * depth-1 callees (each group preserving its input order). Pinned symbols are
 * always emitted FIRST and always included regardless of budget — pinned nodes
 * bypass the budget so the agent never loses a symbol it explicitly asked to
 * keep. Collection stops at the budget or the depth
 * limit, recording why via {@link TruncationReason}.
 *
 * `estimateTokens` uses a dependency-free chars/4 heuristic in v1 (no tokenizer
 * dep). It is exported and the {@link SliceOptions.estimateTokens} seam lets a
 * caller swap in `js-tiktoken` later without touching the BFS.
 *
 * Requirements: 15.1, 15.6, 15.8
 */
import type { Symbol } from "../../core/domain.js";

/** Why context collection stopped. */
export type TruncationReason = "complete" | "token_budget" | "max_depth";

/** A symbol included in the slice, annotated with its hop distance + budget cost. */
export interface SliceNode {
  readonly symbol: Symbol;
  /** Hop distance from the target (0 = target, 1 = direct caller/callee). */
  readonly depth: number;
  /** Estimated tokens this symbol contributes (per {@link estimateTokens}). */
  readonly estimatedTokens: number;
  /** True when this symbol was pinned and so bypassed the budget. */
  readonly pinned: boolean;
}

/** Result of a {@link sliceContext} call. */
export interface ContextSlice {
  /** Included symbols, ordered: pinned first, then target, callers, callees. */
  readonly symbols: readonly SliceNode[];
  /** Sum of `estimatedTokens` over the included symbols. */
  readonly estimatedTokens: number;
  /** The budget that was applied (echoed back for the caller). */
  readonly tokenBudget: number;
  /** Why collection stopped. */
  readonly truncationReason: TruncationReason;
}

/** A symbol's relationship to the target, used for deterministic BFS ordering. */
export interface RelatedSymbol {
  readonly symbol: Symbol;
  /** "caller" → depth-1 inbound; "callee" → depth-1 outbound. */
  readonly relation: "caller" | "callee";
}

/** Options for {@link sliceContext}. */
export interface SliceOptions {
  /** Max tokens to include (0 = unlimited). Pinned symbols bypass this. */
  readonly tokenBudget: number;
  /** Symbol ids that must be included regardless of budget. */
  readonly pin?: readonly string[];
  /** Max hop distance to traverse (default 1 — target + direct neighbours). */
  readonly maxDepth?: number;
  /** Swappable tokenizer seam (default {@link estimateTokens}, chars/4). */
  readonly estimateTokens?: (symbol: Symbol) => number;
}

/**
 * Estimate the token cost of a symbol via a dependency-free chars/4 heuristic.
 *
 * v1 has NO tokenizer dependency; this is the swappable seam. We approximate the
 * source the agent would read for the symbol from the fields we actually persist
 * — name, signature, file path, and a fixed per-line allowance over the symbol's
 * span (a `lines * 40` chars/line estimate) — then divide by 4.
 */
export function estimateTokens(symbol: Symbol): number {
  const name = symbol.name ?? "";
  const signature = symbol.signature ?? "";
  const filePath = symbol.location?.filePath ?? "";
  const startLine = symbol.location?.startLine ?? 0;
  const endLine = symbol.location?.endLine ?? 0;
  // Inclusive line span, never negative; a 1-line symbol counts as 1 line.
  const lines = Math.max(1, endLine - startLine + 1);
  const chars = name.length + signature.length + filePath.length + lines * 40;
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Slice a token-bounded context around `target`.
 *
 * @param target  The resolved target symbol (depth 0).
 * @param related Depth-1 callers and callees, in their retrieval order.
 * @param options Budget / pin / depth / tokenizer.
 */
export function sliceContext(
  target: Symbol,
  related: readonly RelatedSymbol[],
  options: SliceOptions,
): ContextSlice {
  const estimate = options.estimateTokens ?? estimateTokens;
  const maxDepth = options.maxDepth ?? 1;
  // 0 == unlimited.
  const effectiveBudget = options.tokenBudget === 0 ? Number.POSITIVE_INFINITY : options.tokenBudget;
  const pinSet = new Set(options.pin ?? []);

  // Deterministic BFS visitation order: target, then callers, then callees,
  // each group preserving input order. De-dupe by symbol id (target wins over
  // a related entry; the first related entry wins over later duplicates).
  const ordered: Array<{ symbol: Symbol; depth: number }> = [];
  const seen = new Set<string>();
  const push = (symbol: Symbol, depth: number): void => {
    if (seen.has(symbol.id)) return;
    seen.add(symbol.id);
    ordered.push({ symbol, depth });
  };
  push(target, 0);
  // Always enqueue depth-1 related (callers then callees); the depth check
  // during collection decides whether they survive the maxDepth limit. Pinned
  // symbols bypass that check, so they must be enqueued regardless of maxDepth.
  for (const r of related) if (r.relation === "caller") push(r.symbol, 1);
  for (const r of related) if (r.relation === "callee") push(r.symbol, 1);

  // Partition pinned vs unpinned; pinned are emitted FIRST and bypass both the
  // budget AND the depth limit (an explicit pin always wins).
  const pinned = ordered.filter((o) => pinSet.has(o.symbol.id));
  const unpinned = ordered.filter((o) => !pinSet.has(o.symbol.id));

  const result: SliceNode[] = [];
  let total = 0;
  let truncationReason: TruncationReason = "complete";

  for (const { symbol, depth } of pinned) {
    const tokens = estimate(symbol);
    total += tokens;
    result.push({ symbol, depth, estimatedTokens: tokens, pinned: true });
  }

  // Whether anything was dropped purely because it exceeded maxDepth (the
  // related set only carries depth-1, so this fires when callers/callees exist
  // beyond a maxDepth of 0).
  let droppedByDepth = false;
  for (const { symbol, depth } of unpinned) {
    if (depth > maxDepth) {
      droppedByDepth = true;
      continue;
    }
    const tokens = estimate(symbol);
    if (total + tokens > effectiveBudget) {
      truncationReason = "token_budget";
      continue;
    }
    total += tokens;
    result.push({ symbol, depth, estimatedTokens: tokens, pinned: false });
  }

  // token_budget takes precedence (the more actionable signal); only report
  // max_depth when nothing was budget-truncated.
  if (truncationReason === "complete" && droppedByDepth) {
    truncationReason = "max_depth";
  }

  return {
    symbols: result,
    estimatedTokens: total,
    tokenBudget: options.tokenBudget,
    truncationReason,
  };
}
