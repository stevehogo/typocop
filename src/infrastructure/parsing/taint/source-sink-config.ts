/**
 * Source / sink / sanitizer registry (Plan D, source task #5).
 *
 * The per-language registry (`Map<Language, TaintSpec>`) with a `getTaintSpec`
 * lookup — the per-language seam, mirroring Plan B's `visitorFor` dispatch. The
 * model types (`SinkKind`/`TaintSpec`/`TaintNodeCtx`/`ImportProvenance`) live in
 * the leaf `./types.js` and are re-exported here so existing consumers keep
 * importing them from `source-sink-config.js` — while the specs import them from
 * `./types.js` directly, avoiding an import cycle through this registry.
 *
 * PURE: the matchers read AST nodes + import provenance only; no I/O, no DB,
 * never throw (mirrors complexity.ts). Adding a language = add `specs/<lang>.ts`
 * + one registry entry — NO engine change.
 *
 * Soundness: context-insensitive, import-gated NAME matching — sound-but-over-
 * reporting (expect false positives). Reference implementation: an open-source
 * CFG/taint indexer (no product names per repo convention).
 */
import type { Language } from "../../../core/domain.js";
import type { ImportProvenance, SinkKind, TaintNodeCtx, TaintSpec } from "./types.js";
import { typescriptTaintSpec } from "./specs/typescript.js";

// Re-export the model so existing consumers import it from one place.
export type { SinkKind, ImportProvenance, TaintNodeCtx, TaintSpec } from "./types.js";

/**
 * The `language → TaintSpec` registry. The per-language seam: adding a language
 * is `specs/<lang>.ts` + one entry here. No solver change. TS and JS share one
 * spec (same grammar shapes).
 */
const SPECS: Partial<Record<Language, TaintSpec>> = {
  typescript: typescriptTaintSpec,
  javascript: typescriptTaintSpec,
};

/** The registered spec for `language`, or `null` if none (caller skips taint). */
export function getTaintSpec(language: Language): TaintSpec | null {
  return SPECS[language] ?? null;
}

/**
 * Empty provenance — convenience for callers/tests with no import context.
 * The matchers degrade gracefully: with no provenance, import-gated bare-name
 * sinks (`exec`) do NOT classify, but receiver-rooted patterns (`req.query`,
 * `res.send`, `eval`) still do.
 */
export const EMPTY_PROVENANCE: ImportProvenance = {
  bySymbol: new Map(),
  namespaces: new Map(),
};
