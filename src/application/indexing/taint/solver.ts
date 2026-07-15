/**
 * Taint solver (Plan D, source task #6) — MVP: INTRA-PROCEDURAL.
 *
 * Propagates taint over the per-function PDG (reaching-defs def→use +
 * control-dependence from Plan C), emitting `TaintFinding`s tagged with
 * `SinkKind` and `sanitized`. A `TaintFinding` is a standalone NODE (README
 * contract) — NEVER a Symbol→Symbol edge — so findings stay OUT of
 * `impact_analysis`'s untyped traversal.
 *
 * Algorithm: an intra-procedural worklist over each function's def→use chain,
 * seeding from spec SOURCES, cutting at SANITIZERS, flagging SINKS; a finding
 * cap bounds blowup. Interprocedural propagation across resolved `calls` edges
 * (param-in → sink) is the E1 FOLLOW-UP — `solveTaint` accepts `callGraph` (so
 * the README signature is stable) but does not yet traverse it; see the
 * "Interprocedural taint — E1 follow-up" note after this code.
 *
 * This lives in `application/indexing/` (NOT `infrastructure/`) because it needs
 * the cross-file `calls` graph — `infrastructure/` must not import `application/`.
 *
 * Soundness: sound-but-over-reporting (closures/callbacks often invisible,
 * field-level flows untracked, context-insensitive name matching) ⇒ expect false
 * positives; the `explain` tool (Plan E) is for human verification — never
 * auto-act. Reference implementation: an open-source CFG/taint indexer.
 */
import type Parser from "tree-sitter";
import type { Language, Relationship } from "../../../core/domain.js";
import type { Cfg, CfgBlock } from "../../../infrastructure/parsing/cfg/cfg-builder.js";
import type { DefUseEdge } from "../../../infrastructure/parsing/cfg/reaching-defs.js";
import type { CdgEdge } from "../../../infrastructure/parsing/cfg/control-dependence.js";
import type {
  ImportProvenance,
  SinkKind,
  TaintSpec,
} from "../../../infrastructure/parsing/taint/source-sink-config.js";

// Plan C contracts (README:139-142). Re-exported so the solver's consumers/tests
// import the PDG edge types from one place alongside FunctionPdg/TaintFinding.
export type { DefUseEdge, CdgEdge };

/** A single source→sink taint path (README contract — a NODE, not an edge). */
export interface TaintFinding {
  readonly id: string;
  readonly sinkKind: SinkKind;
  readonly sourceId: string;
  readonly sinkId: string;
  readonly sourceLoc: string;
  readonly sinkLoc: string;
  readonly sanitized: boolean;
  readonly path: readonly string[];
}

/** Everything Plans B/C produced for one callable, keyed by `symbolId`. */
export interface FunctionPdg {
  readonly symbolId: string;
  readonly language: Language;
  readonly cfg: Cfg;
  readonly defUse: readonly DefUseEdge[];
  readonly cdg: readonly CdgEdge[];
  readonly imports: ImportProvenance;
}

const MAX_FINDINGS = 5000;        // anti-blowup: cap total findings per run
// (MAX_INTERPROC_HOPS belongs with the E1 interproc follow-up, not the intra-proc MVP.)

const loc = (n: Parser.SyntaxNode): string => `${n.startPosition.row + 1}:${n.startPosition.column}`;

/** Identifier text the LHS of a node's enclosing assignment/declaration binds. */
function definedVariable(node: Parser.SyntaxNode): string | undefined {
  let cur: Parser.SyntaxNode | null = node;
  for (let depth = 0; cur && depth < 6; depth++, cur = cur.parent) {
    if (cur.type === "variable_declarator") {
      return cur.childForFieldName("name")?.text;
    }
    if (cur.type === "assignment_expression") {
      return cur.childForFieldName("left")?.text;
    }
  }
  return undefined;
}

/** Identifier texts read inside a node's subtree (for "does this read var v?"). */
function identifiersRead(node: Parser.SyntaxNode): Set<string> {
  const out = new Set<string>();
  const stack: Parser.SyntaxNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "identifier") out.add(n.text);
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return out;
}

/** Map block id → CfgBlock for a Cfg. */
function blockMap(cfg: Cfg): Map<number, CfgBlock> {
  const m = new Map<number, CfgBlock>();
  for (const b of cfg.blocks) m.set(b.id, b);
  return m;
}

interface IntraResult {
  readonly findings: TaintFinding[];
  /** True if a tainted value reaches a `return` (function returns taint). */
  readonly returnsTaint: boolean;
  /** Tainted parameter names that reach a sink inside this function. */
  readonly paramToSink: ReadonlySet<string>;
  /** Parameter names that, if tainted at entry, taint the return. */
  readonly paramToReturn: ReadonlySet<string>;
}

/**
 * Intra-procedural pass over one function. `taintedParams` seeds entry-tainted
 * parameter names (for the interproc pass; empty in the standalone first pass).
 */
function solveIntra(pdg: FunctionPdg, spec: TaintSpec, taintedParams: ReadonlySet<string>): IntraResult {
  const blocks = blockMap(pdg.cfg);
  const findings: TaintFinding[] = [];
  const imports = pdg.imports;

  // tainted variable → { sourceNodeId, sourceLoc, originBlock, sanitizedOnPath }
  interface TaintState { sourceId: string; sourceLoc: string; originBlock: number; sanitized: boolean; }
  const tainted = new Map<string, TaintState>();

  // Seed parameters tainted by an inter-proc caller.
  for (const p of taintedParams) {
    tainted.set(p, { sourceId: `param:${pdg.symbolId}:${p}`, sourceLoc: "0:0", originBlock: pdg.cfg.entry, sanitized: false });
  }

  // def→use adjacency, plus block predecessor for path reconstruction.
  const defUseFrom = new Map<number, DefUseEdge[]>();
  for (const e of pdg.defUse) {
    const list = defUseFrom.get(e.fromBlock);
    if (list) list.push(e);
    else defUseFrom.set(e.fromBlock, [e]);
  }
  const pathTo = new Map<number, number[]>(); // block id → block-id path from a source

  let returnsTaint = false;
  const paramToSink = new Set<string>();
  const paramToReturn = new Set<string>();

  // Worklist of (blockId, variable) tainted facts.
  const work: Array<{ block: number; variable: string }> = [];
  const enqueue = (block: number, variable: string, path: number[]): void => {
    if (!pathTo.has(block)) pathTo.set(block, path);
    work.push({ block, variable });
  };

  // 1) SEED from sources: walk every block's nodes; a source def taints its LHS.
  for (const b of pdg.cfg.blocks) {
    for (const node of b.nodes) {
      // scan the subtree for source member-expressions
      const stack: Parser.SyntaxNode[] = [node];
      while (stack.length > 0) {
        const n = stack.pop()!;
        if (spec.isSource({ node: n, imports })) {
          const v = definedVariable(n);
          if (v) {
            // sourceId is the OWNING callable's Symbol.id (intact) — Plan E
            // anchors taintSource via keyOf(sourceId) directly, no splitting.
            // The precise position lives in sourceLoc; uniqueness lives in id.
            tainted.set(v, { sourceId: pdg.symbolId, sourceLoc: loc(n), originBlock: b.id, sanitized: false });
            enqueue(b.id, v, [b.id]);
          }
        }
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (c) stack.push(c);
        }
      }
    }
  }
  for (const p of taintedParams) enqueue(pdg.cfg.entry, p, [pdg.cfg.entry]);

  // 2) PROPAGATE over def→use; cut at sanitizers; flag sinks.
  const visited = new Set<string>();
  while (work.length > 0) {
    const { block, variable } = work.pop()!;
    const key = `${block}:${variable}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const state = tainted.get(variable);
    if (!state) continue;
    const curPath = pathTo.get(block) ?? [block];

    // Inspect THIS block's statements for sanitizer cut / sink / transitive def.
    const cfgBlock = blocks.get(block);
    if (cfgBlock) {
      for (const node of cfgBlock.nodes) {
        const callNodes = collectCallNodes(node);
        for (const cn of callNodes) {
          const reads = identifiersRead(cn);
          if (!reads.has(variable)) continue;
          // Sanitizer on the path: mark sanitized, but keep propagating so a
          // later sink is reported with sanitized:true.
          if (spec.isSanitizer({ node: cn, imports })) {
            state.sanitized = true;
            const out = definedVariable(cn);
            if (out) tainted.set(out, { ...state }); // sanitized clone flows on
          }
          // Sink: emit a finding tagged with its kind + whether sanitized.
          const kind = spec.sinkKind({ node: cn, imports });
          if (kind && reads.has(variable)) {
            pushFinding(findings, {
              // id is the unique finding key (owner@srcLoc->sinkLoc:kind); it is
              // never split for owner extraction. sourceId/sinkId are the owning
              // callable Symbol.ids (here the same callable — intra-proc).
              id: `taint:${pdg.symbolId}@${state.sourceLoc}->${loc(cn)}:${kind}`,
              sinkKind: kind,
              sourceId: state.sourceId,
              sinkId: pdg.symbolId,
              sourceLoc: state.sourceLoc,
              sinkLoc: loc(cn),
              sanitized: state.sanitized,
              path: curPath.map(String),
            });
          }
        }
        // return reads tainted var ⇒ function returns taint.
        if (node.type === "return_statement" && identifiersRead(node).has(variable)) {
          returnsTaint = true;
          if (taintedParams.has(variable)) paramToReturn.add(variable);
        }
      }
    }
    if (taintedParams.has(variable)) {
      // record param→sink if a sink was just emitted reading this param
      for (const f of findings) if (f.sourceId.startsWith(`param:${pdg.symbolId}:${variable}`)) paramToSink.add(variable);
    }

    // Forward over def→use edges for `variable`; taint transitive defs in `toBlock`.
    for (const e of defUseFrom.get(block) ?? []) {
      if (e.variable !== variable) continue;
      const nextPath = [...curPath, e.toBlock];
      enqueue(e.toBlock, variable, nextPath);
      // transitive: a statement in toBlock that assigns w from variable taints w.
      const tb = blocks.get(e.toBlock);
      if (tb) {
        for (const node of tb.nodes) {
          const w = definedVariable(node);
          if (w && w !== variable && identifiersRead(node).has(variable)) {
            if (!tainted.has(w)) tainted.set(w, { ...state, originBlock: e.toBlock });
            enqueue(e.toBlock, w, nextPath);
          }
        }
      }
    }
  }

  return { findings, returnsTaint, paramToSink, paramToReturn };
}

/** All call_expression / new_expression / member_expression nodes in a subtree. */
function collectCallNodes(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const stack: Parser.SyntaxNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "call_expression" || n.type === "new_expression" || n.type === "member_expression" || n.type === "subscript_expression") {
      out.push(n);
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return out;
}

/** Dedup by finding `id` (owner@srcLoc->sinkLoc:kind); a finding is sanitized iff ALL merges are. */
function pushFinding(findings: TaintFinding[], f: TaintFinding): void {
  if (findings.length >= MAX_FINDINGS) return;
  const existing = findings.find((x) => x.id === f.id);
  if (!existing) { findings.push(f); return; }
  // conservative: unsanitized wins (if any path is unsanitized, report it).
  if (existing.sanitized && !f.sanitized) {
    findings[findings.indexOf(existing)] = f;
  }
}

/**
 * Taint solve (README `solveTaint`). MVP: runs the intra-procedural pass on every
 * function and returns the deduped, deterministic findings. Interprocedural
 * propagation over the call graph is the E1 follow-up (see the note below);
 * `callGraph` is accepted now to keep the README signature stable.
 */
export function solveTaint(
  pdgs: ReadonlyMap<string, FunctionPdg>,
  callGraph: readonly Relationship[],
  specRegistry: (language: Language) => TaintSpec | null,
): TaintFinding[] {
  const all: TaintFinding[] = [];
  const ids = [...pdgs.keys()].sort(); // stable, deterministic iteration

  // MVP = INTRA-PROCEDURAL taint on every function. Interprocedural propagation
  // across `callGraph` (param-in → sink across `calls`) is the E1 FOLLOW-UP — see
  // "Interprocedural taint — E1 follow-up" below. `callGraph` is accepted now so
  // the README `solveTaint` signature stays stable when the follow-up lands.
  void callGraph;
  for (const id of ids) {
    const pdg = pdgs.get(id)!;
    const spec = specRegistry(pdg.language);
    if (!spec) continue; // no spec for language ⇒ skip (no findings, no error)
    for (const f of solveIntra(pdg, spec, new Set()).findings) pushFinding(all, f);
  }

  // Deterministic order: by sinkKind, then source loc, then sink loc.
  return all.sort((a, b) =>
    a.sinkKind === b.sinkKind
      ? a.sourceLoc === b.sourceLoc
        ? a.sinkLoc.localeCompare(b.sinkLoc)
        : a.sourceLoc.localeCompare(b.sourceLoc)
      : a.sinkKind.localeCompare(b.sinkKind),
  );
}
