/**
 * `--pdg` phase orchestrator (Plan E, source task #7).
 *
 * PURE composition of Plans B/C/D over every callable Symbol:
 *   buildCfg (B) → computeControlDependence + computeReachingDefs (C) →
 *   assemble FunctionPdg → solveTaint (D).
 * Returns the persistable BasicBlocks + TaintFindings + PDG/taint edge rows; the
 * pipeline (gated behind config.pdg) persists them. NO Symbol→Symbol edge is
 * produced (program HARD RULE) — cfg/cdg/reachingDef are BasicBlock→BasicBlock
 * and findings hang off the non-Symbol TaintFinding node.
 *
 * `buildCfg` returns null for a language with no visitor ⇒ that symbol is
 * silently skipped (no findings, no error — README per-language seam).
 *
 * Soundness: sound-but-over-reporting (closures/callbacks often invisible,
 * field-level flows untracked, context-insensitive name matching) ⇒ expect false
 * positives; the `explain` tool is for human verification — never auto-act.
 * Reference implementation: an open-source CFG/taint indexer.
 */
import type Parser from "tree-sitter";
import type {
  BasicBlock, Language, Relationship, Symbol, TaintFinding,
} from "../../../core/domain.js";
import { initParser } from "../../../infrastructure/parsing/init.js";
import { buildCfg } from "../../../infrastructure/parsing/cfg/cfg-builder.js";
import { computeControlDependence } from "../../../infrastructure/parsing/cfg/control-dependence.js";
import { computeReachingDefs } from "../../../infrastructure/parsing/cfg/reaching-defs.js";
import { getTaintSpec } from "../../../infrastructure/parsing/taint/source-sink-config.js";
import { buildImportProvenance } from "../../../infrastructure/parsing/taint/specs/typescript.js";
import { solveTaint, type FunctionPdg } from "../taint/solver.js";

export interface PdgEdgeRow {
  readonly fromId: string;
  readonly toId: string;
  readonly props: Record<string, string>;
}
export interface PdgPhaseResult {
  readonly blocks: readonly BasicBlock[];
  readonly findings: readonly TaintFinding[];
  readonly cfgEdges: readonly PdgEdgeRow[];
  readonly cdgEdges: readonly PdgEdgeRow[];
  readonly reachingDefEdges: readonly PdgEdgeRow[];
}

const CALLABLE_KINDS = new Set(["function", "method"]);
// Tree-sitter definition node types the CFG visitor understands (Plan B).
const FN_NODE_TYPES = new Set([
  "function_declaration", "method_definition", "arrow_function",
  "function_expression", "generator_function_declaration",
]);
// Languages with a registered CFG visitor today (Plan B = TS/JS only).
const PDG_LANGUAGES = new Set<Language>(["typescript", "javascript"]);

const langOfPath = (path: string): Language | null => {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx") || path.endsWith(".mjs")) return "javascript";
  return null;
};

/** Find the smallest function-definition node spanning the symbol's start line. */
function findDefNode(root: Parser.SyntaxNode, startLine: number): Parser.SyntaxNode | null {
  let best: Parser.SyntaxNode | null = null;
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    // Symbol.location.startLine is the 0-based tree-sitter row (extract-symbols.ts
    // stores `node.startPosition.row`), so compare in the SAME 0-based basis.
    const nStart = n.startPosition.row;
    const nEnd = n.endPosition.row;
    if (FN_NODE_TYPES.has(n.type) && nStart <= startLine && nEnd >= startLine) {
      if (!best || (n.endPosition.row - n.startPosition.row) <= (best.endPosition.row - best.startPosition.row)) {
        best = n;
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) stack.push(c); }
  }
  return best;
}

/** Build per-file import provenance from the file's `import` statements. */
function provenanceOf(root: Parser.SyntaxNode): ReturnType<typeof buildImportProvenance> {
  const hints: { targetName: string; namedBindings?: { local: string; exported: string }[]; localName?: string }[] = [];
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "import_statement") {
      const src = n.childForFieldName("source");
      const mod = src ? src.text.replace(/^['"]|['"]$/g, "") : "";
      if (mod) {
        const named: { local: string; exported: string }[] = [];
        let localNs: string | undefined;
        const clause = n.namedChildren.find((c) => c.type === "import_clause") ?? n;
        const walk: Parser.SyntaxNode[] = [clause];
        while (walk.length > 0) {
          const w = walk.pop()!;
          if (w.type === "import_specifier") {
            const nm = w.childForFieldName("name")?.text;
            const alias = w.childForFieldName("alias")?.text;
            if (nm) named.push({ local: alias ?? nm, exported: nm });
          } else if (w.type === "namespace_import" || w.type === "identifier") {
            // `* as cp` / default import → namespace local name.
            const id = w.type === "identifier" ? w.text : w.namedChildren[0]?.text;
            if (id && w.parent?.type !== "import_specifier") localNs = id;
          }
          for (let i = 0; i < w.namedChildCount; i++) { const c = w.namedChild(i); if (c) walk.push(c); }
        }
        hints.push({ targetName: mod, ...(named.length ? { namedBindings: named } : {}), ...(localNs ? { localName: localNs } : {}) });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) stack.push(c); }
  }
  return buildImportProvenance(hints);
}

export async function runPdgPhase(
  symbols: readonly Symbol[],
  relationships: readonly Relationship[],
  fileNodes: readonly { readonly path: string; readonly content: string }[],
): Promise<PdgPhaseResult> {
  const contentByPath = new Map<string, string>();
  for (const f of fileNodes) contentByPath.set(f.path, f.content);

  // Group callable symbols by file so each file is parsed once.
  const byFile = new Map<string, Symbol[]>();
  for (const s of symbols) {
    if (!CALLABLE_KINDS.has(s.kind)) continue;
    const lang = langOfPath(s.location.filePath);
    if (!lang || !PDG_LANGUAGES.has(lang)) continue; // no visitor ⇒ skip silently
    const list = byFile.get(s.location.filePath);
    if (list) list.push(s); else byFile.set(s.location.filePath, [s]);
  }

  const blocks: BasicBlock[] = [];
  const cfgEdges: PdgEdgeRow[] = [];
  const cdgEdges: PdgEdgeRow[] = [];
  const reachingDefEdges: PdgEdgeRow[] = [];
  const pdgs = new Map<string, FunctionPdg>();

  for (const [filePath, fileSyms] of byFile) {
    const content = contentByPath.get(filePath);
    const lang = langOfPath(filePath);
    if (content === undefined || !lang) continue; // missing source ⇒ skip
    const parser = await initParser(lang);
    const tree = parser.parse(content);
    const imports = provenanceOf(tree.rootNode);

    for (const sym of fileSyms) {
      const def = findDefNode(tree.rootNode, sym.location.startLine);
      if (!def) continue;
      const cfg = buildCfg(def, lang);
      if (!cfg) continue; // no visitor for this language ⇒ skip
      const fnId = sym.logicalKey;

      // BasicBlock nodes (id = "<functionId>#<blockIndex>") + hasBlock owner.
      const blockId = (n: number): string => `${fnId}#${n}`;
      for (const b of cfg.blocks) {
        blocks.push({
          id: blockId(b.id), functionId: fnId, blockIndex: b.id,
          startLine: b.startLine, endLine: b.endLine, kind: b.kind,
        });
      }
      for (const e of cfg.edges) {
        cfgEdges.push({ fromId: blockId(e.from), toId: blockId(e.to), props: { edgeKind: e.kind } });
      }
      const cdg = computeControlDependence(cfg);
      for (const e of cdg) {
        cdgEdges.push({ fromId: blockId(e.from), toId: blockId(e.to), props: { branchSense: e.branchSense, guard: e.guard ? "true" : "false" } });
      }
      const defUse = computeReachingDefs(cfg, def, lang);
      for (const e of defUse) {
        reachingDefEdges.push({ fromId: blockId(e.fromBlock), toId: blockId(e.toBlock), props: { variable: e.variable } });
      }

      pdgs.set(sym.id, { symbolId: sym.id, language: lang, cfg, defUse, cdg, imports });
    }
  }

  const findings = solveTaint(pdgs, relationships, getTaintSpec);
  return { blocks, findings, cfgEdges, cdgEdges, reachingDefEdges };
}
