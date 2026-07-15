/**
 * Control-flow-graph builder (Plan B — per-function PDG program).
 *
 * Language-agnostic entry point: `buildCfg(funcNode, language)` dispatches to a
 * per-language `CfgVisitor` (the per-language seam). Returns `null` when no
 * visitor is registered for `language` — the caller (pipeline PDG phase) then
 * SKIPS PDG for that symbol. There is deliberately NO generic fallback: an
 * approximate CFG yields unsound taint, so each language needs a real visitor.
 *
 * Pure: the visitors are pure tree-sitter subtree walks (see complexity.ts).
 */
import type Parser from "tree-sitter";
import type { Language } from "../../../core/domain.js";
import type { Cfg, CfgVisitor } from "./types.js";
import { typescriptCfgVisitor } from "./visitors/typescript.js";

// Re-export the model so downstream plans import it from the builder (README:128).
export type { BlockKind, CfgBlock, CfgEdgeKind, CfgEdge, Cfg, CfgVisitor } from "./types.js";

/**
 * The `language → CfgVisitor` registry. Adding a language = add a visitor file
 * + one entry here (the per-language seam — NO engine change). TS and JS share
 * the same visitor (same grammar shapes).
 */
const VISITORS: Partial<Record<Language, CfgVisitor>> = {
  typescript: typescriptCfgVisitor,
  javascript: typescriptCfgVisitor,
};

/** The registered visitor for `language`, or `null` if none. */
export function visitorFor(language: Language): CfgVisitor | null {
  return VISITORS[language] ?? null;
}

/**
 * Build the intra-procedural CFG for a single function/method/constructor
 * definition node. Returns `null` when no visitor exists for `language`
 * (caller skips PDG). Never throws — a visitor failure degrades to `null`.
 */
export function buildCfg(funcNode: Parser.SyntaxNode, language: Language): Cfg | null {
  const visitor = visitorFor(language);
  if (!visitor) return null;
  try {
    return visitor.build(funcNode);
  } catch {
    return null; // graceful degradation, like computeComplexity never throwing
  }
}
