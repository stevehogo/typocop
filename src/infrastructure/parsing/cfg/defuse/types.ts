/**
 * Def/use extraction seam (Plan C — reaching definitions).
 *
 * The reaching-definitions worklist (reaching-defs.ts) is written ONCE and is
 * language-agnostic; the per-language part is "what is a def, what is a use" —
 * captured by a `DefUseExtractor`, registered per language (mirrors Plan B's
 * cfg/visitors/<lang>.ts seam). Pure type module — no runtime, no I/O.
 */
import type Parser from "tree-sitter";
import type { Cfg, CfgBlock } from "../cfg-builder.js";

/** The simple-variable defs and uses observed in one basic block. */
export interface DefUse {
  /** Variable names this block (re)defines — its gen set. */
  readonly defs: readonly string[];
  /** Variable names this block reads. */
  readonly uses: readonly string[];
}

/**
 * Per-language def/use extractor. `extract` is called once per block; the
 * `entry` block additionally receives the function's parameter names as defs
 * (the worklist wires that, not the extractor). Pure: reads the AST only.
 */
export interface DefUseExtractor {
  /** Defs + uses for a single block (reads `block.nodes`). */
  forBlock(block: CfgBlock): DefUse;
  /** The formal parameter names of `funcNode` (gen'd at the entry block). */
  params(funcNode: Parser.SyntaxNode): readonly string[];
}

/** Re-export so reaching-defs.ts imports the model from one place. */
export type { Cfg, CfgBlock };
