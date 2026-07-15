/**
 * Reaching-definitions (Plan C — per-function PDG program).
 *
 * Intra-procedural forward gen/kill reaching-definitions over Plan B's `Cfg`,
 * emitting def->use edges: for each variable use in a block, an edge from every
 * block whose definition of that variable reaches the use without being killed
 * by an intervening redefinition. The worklist engine is written ONCE and is
 * language-agnostic; the per-language part — what counts as a def vs a use — is
 * a `DefUseExtractor` dispatched on `language`. Returns `[]` (no edges, no error)
 * for a language with no extractor (mirrors buildCfg => null "skip, don't fail").
 *
 * Soundness: only simple variable names are tracked; field/element flows (o.x,
 * a[i]) and aliasing are out of scope for the MVP (documented posture). Pure:
 * reads the Cfg + funcNode only, never mutates, never throws.
 */
import type Parser from "tree-sitter";
import type { Language } from "../../../core/domain.js";
import type { Cfg } from "./cfg-builder.js";
import type { DefUse, DefUseExtractor } from "./defuse/types.js";
import { typescriptDefUseExtractor } from "./defuse/typescript.js";

/** A reaching def->use edge for one variable. */
export interface DefUseEdge {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly variable: string;
}

/** The `language -> DefUseExtractor` registry (the per-language seam). */
const EXTRACTORS: Partial<Record<Language, DefUseExtractor>> = {
  typescript: typescriptDefUseExtractor,
  javascript: typescriptDefUseExtractor,
};

export function extractorFor(language: Language): DefUseExtractor | null {
  return EXTRACTORS[language] ?? null;
}

/** A single definition: the block that produced it + the variable. */
interface Def {
  readonly block: number;
  readonly variable: string;
}

const defKey = (d: Def): string => `${d.block} ${d.variable}`;

export function computeReachingDefs(
  cfg: Cfg,
  funcNode: Parser.SyntaxNode,
  language: Language,
): DefUseEdge[] {
  if (cfg.blocks.length === 0) return [];
  const extractor = extractorFor(language);
  if (!extractor) return [];

  let perBlock: Map<number, DefUse>;
  try {
    perBlock = new Map();
    for (const b of cfg.blocks) perBlock.set(b.id, extractor.forBlock(b));
  } catch {
    return []; // grammar drift => degrade to no edges, never throw
  }

  // Parameters are defs at the entry block.
  try {
    const params = funcNode ? extractor.params(funcNode) : [];
    if (params.length > 0) {
      const entryDU = perBlock.get(cfg.entry);
      const baseDefs = entryDU ? entryDU.defs : [];
      const baseUses = entryDU ? entryDU.uses : [];
      perBlock.set(cfg.entry, { defs: [...new Set([...params, ...baseDefs])], uses: baseUses });
    }
  } catch {
    /* params are best-effort; ignore extraction failure */
  }

  // CFG adjacency.
  const preds = new Map<number, number[]>();
  for (const b of cfg.blocks) preds.set(b.id, []);
  for (const e of cfg.edges) preds.get(e.to)?.push(e.from);

  // GEN[b] = { (b, v) : v in defs(b) }; KILL[b] = every def of any v in defs(b).
  const gen = new Map<number, Def[]>();
  const killVars = new Map<number, Set<string>>(); // the variable names b redefines
  for (const b of cfg.blocks) {
    const du = perBlock.get(b.id)!;
    gen.set(b.id, du.defs.map((v) => ({ block: b.id, variable: v })));
    killVars.set(b.id, new Set(du.defs));
  }

  // Forward worklist: IN[b] = ⋃ OUT[pred]; OUT[b] = GEN[b] ∪ (IN[b] \ KILL[b]).
  const IN = new Map<number, Map<string, Def>>();
  const OUT = new Map<number, Map<string, Def>>();
  for (const b of cfg.blocks) {
    IN.set(b.id, new Map());
    // seed OUT with GEN so the first sweep propagates.
    const og = new Map<string, Def>();
    for (const d of gen.get(b.id)!) og.set(defKey(d), d);
    OUT.set(b.id, og);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const b of cfg.blocks) {
      // IN = union of predecessors' OUT.
      const inMap = new Map<string, Def>();
      for (const p of preds.get(b.id) ?? []) {
        for (const [k, d] of OUT.get(p)!) inMap.set(k, d);
      }
      IN.set(b.id, inMap);

      // OUT = GEN ∪ (IN \ KILL).
      const kill = killVars.get(b.id)!;
      const outMap = new Map<string, Def>();
      for (const [k, d] of inMap) {
        if (!kill.has(d.variable)) outMap.set(k, d); // survives unless this block redefines v
      }
      for (const d of gen.get(b.id)!) outMap.set(defKey(d), d);

      const prevOut = OUT.get(b.id)!;
      if (!mapsEqual(prevOut, outMap)) {
        OUT.set(b.id, outMap);
        changed = true;
      }
    }
  }

  // Emit def->use edges. For each block u and each var v it uses, every reaching
  // def (d, v) in IN[u] yields d.block -> u. A block that BOTH defs and then uses
  // v (e.g. `x = 1; return x;` in one block) is covered by its own GEN: such a
  // use sees the block's own def (block self-edge collapses to fromBlock == u,
  // which we keep — it records the in-block def site).
  const seen = new Set<string>();
  const edges: DefUseEdge[] = [];
  for (const b of cfg.blocks) {
    const du = perBlock.get(b.id)!;
    if (du.uses.length === 0) continue;
    // Reaching defs visible to this block's uses: IN[b] plus this block's own GEN
    // (an in-block def precedes an in-block later use under our last-write model).
    const visible = new Map<string, Def>(IN.get(b.id)!);
    for (const d of gen.get(b.id)!) visible.set(defKey(d), d);

    for (const v of du.uses) {
      for (const d of visible.values()) {
        if (d.variable !== v) continue;
        const key = `${d.block} ${b.id} ${v}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ fromBlock: d.block, toBlock: b.id, variable: v });
      }
    }
  }

  edges.sort((a, b) =>
    a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : (a.fromBlock - b.fromBlock) || (a.toBlock - b.toBlock),
  );
  return edges;
}

function mapsEqual(a: Map<string, Def>, b: Map<string, Def>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a.keys()) if (!b.has(k)) return false;
  return true;
}
