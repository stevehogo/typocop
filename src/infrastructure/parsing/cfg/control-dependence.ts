/**
 * Control-dependence graph (Plan C — per-function PDG program).
 *
 * Pure, language-agnostic analysis over Plan B's `Cfg`: it consumes only the
 * block/edge structure (already normalised to seq/true/false/back), so it needs
 * no per-language seam. Standard recipe:
 *   1. reverse the CFG;
 *   2. compute post-dominators by iterative dataflow (intersection fixpoint),
 *      then the immediate post-dominator of each block;
 *   3. for each control-decision edge (a multi-successor block's out-edge), walk
 *      the post-dominator tree from the edge's target up to — but not including —
 *      ipdom(source), emitting a control-dependence edge to each block on the way
 *      (Ferrante–Ottenstein–Warren). Each edge carries the controlling branch's
 *      sense (T/F) and a `guard` flag (true for if/switch data guards, false for
 *      loop iteration control).
 *
 * Per-function CFGs are tiny, so the O(n^2) intersection fixpoint is trivially
 * fast and avoids the irreducible-graph edge cases of Lengauer–Tarjan. Pure:
 * reads the Cfg only, never mutates it, never throws (a degenerate CFG => []).
 *
 * Reference implementation for the overall PDG approach: an open-source CFG/taint
 * indexer. No product names per repo convention.
 */
import type { Cfg, CfgEdge } from "./cfg-builder.js";

/** A control-dependence edge: `to` executes only when `from` branches `branchSense`. */
export interface CdgEdge {
  readonly from: number;
  readonly to: number;
  readonly branchSense: "T" | "F";
  readonly guard: boolean;
}

/** Map a block id to its index in `cfg.blocks` (ids are creation order but may have gaps if a CFG is hand-built). */
function indexById(cfg: Cfg): Map<number, number> {
  const m = new Map<number, number>();
  cfg.blocks.forEach((b, i) => m.set(b.id, i));
  return m;
}

/** CFG successors / predecessors keyed by block id. */
function adjacency(cfg: Cfg): { succ: Map<number, number[]>; pred: Map<number, number[]> } {
  const succ = new Map<number, number[]>();
  const pred = new Map<number, number[]>();
  for (const b of cfg.blocks) {
    succ.set(b.id, []);
    pred.set(b.id, []);
  }
  for (const e of cfg.edges) {
    succ.get(e.from)?.push(e.to);
    pred.get(e.to)?.push(e.from);
  }
  return { succ, pred };
}

/**
 * Post-dominators by iterative dataflow on the reverse graph rooted at `exit`.
 * pdom(exit) = {exit}; pdom(b) = {b} ∪ (⋂ over CFG-successors s of b) pdom(s).
 * Returns a map id -> set of ids that post-dominate it (including itself).
 */
function postDominators(cfg: Cfg, succ: Map<number, number[]>): Map<number, Set<number>> {
  const allIds = cfg.blocks.map((b) => b.id);
  const pdom = new Map<number, Set<number>>();

  // Initialise: exit = {exit}; everyone else = full universe (so first intersection narrows).
  const universe = new Set<number>(allIds);
  for (const id of allIds) {
    pdom.set(id, id === cfg.exit ? new Set([cfg.exit]) : new Set(universe));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of allIds) {
      if (id === cfg.exit) continue;
      const successors = succ.get(id) ?? [];
      // Intersect pdom of all successors. A block with no successors keeps only itself.
      let inter: Set<number> | null = null;
      for (const s of successors) {
        const ps = pdom.get(s);
        if (!ps) continue;
        if (inter === null) {
          inter = new Set(ps);
        } else {
          for (const x of [...inter]) if (!ps.has(x)) inter.delete(x);
        }
      }
      const next = new Set<number>(inter ?? []);
      next.add(id); // a block always post-dominates itself
      const prev = pdom.get(id)!;
      if (!setsEqual(prev, next)) {
        pdom.set(id, next);
        changed = true;
      }
    }
  }
  return pdom;
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Immediate post-dominator of each block: the closest strict post-dominator —
 * the member of pdom(b)\{b} that does not post-dominate any other member of
 * pdom(b)\{b}. Returns id -> ipdom id (absent for `exit` and unreachable blocks).
 */
function immediatePostDominators(
  cfg: Cfg,
  pdom: Map<number, Set<number>>,
): Map<number, number> {
  const ipdom = new Map<number, number>();
  for (const b of cfg.blocks) {
    if (b.id === cfg.exit) continue;
    const strict = [...(pdom.get(b.id) ?? [])].filter((x) => x !== b.id);
    if (strict.length === 0) continue;
    // ipdom = the strict post-dominator that is post-dominated by every other
    // strict post-dominator (the closest one). Pick the one whose own pdom set
    // is the largest subset within `strict` (closest to b dominates fewest).
    let best = strict[0]!;
    for (const cand of strict) {
      // `cand` is closer than `best` if `best` post-dominates `cand`
      // (i.e. best ∈ pdom(cand)).
      if (pdom.get(cand)?.has(best)) best = cand;
    }
    ipdom.set(b.id, best);
  }
  return ipdom;
}

/** Walk the post-dominator tree from `start` up to (excluding) `stop`, yielding each id. */
function* pdomPath(start: number, stop: number | undefined, ipdom: Map<number, number>): Generator<number> {
  let cur: number | undefined = start;
  const seen = new Set<number>();
  while (cur !== undefined && cur !== stop && !seen.has(cur)) {
    seen.add(cur);
    yield cur;
    cur = ipdom.get(cur);
  }
}

/** Branch sense from a CFG edge kind. true/back ⇒ T (taken), false ⇒ F, seq ⇒ T (default). */
function senseOf(kind: CfgEdge["kind"]): "T" | "F" {
  return kind === "false" ? "F" : "T";
}

export function computeControlDependence(cfg: Cfg): CdgEdge[] {
  if (cfg.blocks.length === 0) return [];

  const { succ } = adjacency(cfg);
  const pdom = postDominators(cfg, succ);
  const ipdom = immediatePostDominators(cfg, pdom);
  const byId = indexById(cfg);

  // Control-decision edges: out-edges of any block with >= 2 successors.
  const outCount = new Map<number, number>();
  for (const e of cfg.edges) outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1);

  // Dedup on (from,to,sense) so a block reached twice on a walk isn't double-emitted.
  const seen = new Set<string>();
  const result: CdgEdge[] = [];

  for (const e of cfg.edges) {
    if ((outCount.get(e.from) ?? 0) < 2) continue; // not a decision edge
    const controller = cfg.blocks[byId.get(e.from)!];
    if (!controller) continue;
    const sense = senseOf(e.kind);
    // if/switch headers are data guards; loop headers are iteration control.
    const guard = controller.kind === "branch" || controller.kind === "switch";
    const stop = ipdom.get(e.from); // merge point; control no longer matters at/after it

    // FOW: from the edge target, walk the pdom tree up to ipdom(controller),
    // emitting controller -> w for each w strictly before the merge point.
    for (const w of pdomPath(e.to, stop, ipdom)) {
      if (w === e.from) continue; // never self-dependent
      const key = `${e.from}->${w}:${sense}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ from: e.from, to: w, branchSense: sense, guard });
    }
  }

  // Deterministic output.
  result.sort((a, b) => (a.from - b.from) || (a.to - b.to) || (a.branchSense < b.branchSense ? -1 : a.branchSense > b.branchSense ? 1 : 0));
  return result;
}
