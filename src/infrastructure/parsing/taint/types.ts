/**
 * Taint spec model (Plan D — per-function PDG program).
 *
 * The `SinkKind` enum + the classifier evidence/contract types are defined ONCE
 * here (a leaf type module) and re-exported from source-sink-config.ts, so the
 * per-language specs (specs/<lang>.ts) import the model from here WITHOUT a cycle
 * back through the registry (mirrors Plan B's cfg/types.ts ← cfg/visitors/<lang>.ts).
 * Pure type module — no runtime, no I/O.
 */
import type Parser from "tree-sitter";

/** The dangerous-operation categories taint findings are tagged with (README). */
export type SinkKind = "command" | "sql" | "path" | "xss" | "code";

/** Per-file import provenance — which local name came from which module. */
export interface ImportProvenance {
  /** local binding name → module specifier (e.g. `exec` → `child_process`). */
  readonly bySymbol: ReadonlyMap<string, string>;
  /** local namespace/default name → module (e.g. `cp` → `child_process`). */
  readonly namespaces: ReadonlyMap<string, string>;
}

/** The evidence a classifier sees: the node + the file's import provenance. */
export interface TaintNodeCtx {
  readonly node: Parser.SyntaxNode;
  readonly imports: ImportProvenance;
}

/**
 * Per-language source/sink/sanitizer classifier (the per-language seam). Each
 * classifier is a pure predicate over a call/member AST node + import provenance.
 */
export interface TaintSpec {
  /** True when the node reads untrusted input (`req.query`, `process.argv`, …). */
  isSource(ctx: TaintNodeCtx): boolean;
  /** The sink category for the node, or `null` if it is not a sink. */
  sinkKind(ctx: TaintNodeCtx): SinkKind | null;
  /** True when the node neutralises taint (escaper / validator / parameterized query). */
  isSanitizer(ctx: TaintNodeCtx): boolean;
}
