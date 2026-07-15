/**
 * Control-flow-graph model (Plan B — per-function PDG program).
 *
 * The block/edge types are defined ONCE here (the single source of truth named
 * by docs/plans/per-function-pdg/README.md) and re-exported from cfg-builder.ts.
 * Pure type module — no runtime, no I/O. Mirrors the purity of complexity.ts.
 */
import type Parser from "tree-sitter";

/** Kind of a basic block. `entry`/`exit` are synthetic; the rest tag headers. */
export type BlockKind = "entry" | "exit" | "normal" | "branch" | "loop" | "switch" | "catch";

/** One basic block of a callable's intra-procedural CFG. */
export interface CfgBlock {
  /** Monotonic id, assigned in creation order. `entry` is always 0. */
  readonly id: number;
  readonly kind: BlockKind;
  /** 1-based inclusive source line span of the statements in this block. */
  readonly startLine: number;
  readonly endLine: number;
  /**
   * Internal AST node refs for this block's statements (consumed by Plan C's
   * reaching-defs over `funcNode`). Not part of the persisted graph; kept here
   * so downstream analyses don't re-walk. `tree-sitter` `SyntaxNode`s.
   */
  readonly nodes: readonly Parser.SyntaxNode[];
}

/** Control-flow edge kind. `back` is the loop back-edge (only edge to a lower position). */
export type CfgEdgeKind = "seq" | "true" | "false" | "back";

/** A directed control-flow edge between two block ids. */
export interface CfgEdge {
  readonly from: number;
  readonly to: number;
  readonly kind: CfgEdgeKind;
}

/** A function's intra-procedural CFG. `entry`/`exit` are block ids into `blocks`. */
export interface Cfg {
  readonly blocks: readonly CfgBlock[];
  readonly edges: readonly CfgEdge[];
  readonly entry: number;
  readonly exit: number;
}

/** Per-language control-flow seam: builds a Cfg from a definition node. */
export interface CfgVisitor {
  build(funcNode: Parser.SyntaxNode): Cfg;
}
