/**
 * Dead-code candidate detection (D6).
 *
 * Finds :Symbol nodes with no incoming CALLS edge, then filters OUT symbols
 * that are legitimately uncalled-within-the-repo:
 *   - exports (visibility "public" or kind "export") — invoked by external
 *     callers or the public API surface, not necessarily in-repo.
 *   - entry-point-named symbols (main/init/handlers/REST verbs/controllers,
 *     reused from ENTRY_POINT_PATTERNS) — invoked by frameworks/the runtime.
 *
 * The result is a list of CANDIDATES only. Dynamic/reflective dispatch (string
 * keyed lookups, decorators, DI containers, `eval`) is not tracked by the CALLS
 * edge set, so a flagged symbol may still be reachable. This query is strictly
 * READ-ONLY — it never deletes or mutates anything.
 *
 * Requirements: 15.1, 15.5, 15.6, 15.8
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import type { Symbol, SymbolKind, EntryPointKind } from "../../core/domain.js";
import { graphNodeToSymbol, rowToNode } from "./graph-helpers.js";
import type { CypherNodeRow } from "./graph-helpers.js";
import { isEntryPointName } from "../../platform/utils/entry-point-names.js";

/** Options for {@link findDeadCode}. */
export interface FindDeadCodeOptions {
  /** Optional kind filter — only consider symbols of this kind. */
  readonly kind?: SymbolKind;
  /** Cap on the number of candidates returned (after filtering). */
  readonly maxResults?: number;
}

/** A dead-code candidate: an uncalled, non-exported, non-entry-point symbol. */
export interface DeadCodeCandidate {
  readonly symbol: Symbol;
}

/**
 * An uncalled symbol that was KEPT OUT of the candidate list because it is a
 * persisted entry point (Wave 2 `entryPointKind`/`entryPointReason`). Surfaced
 * so the tool can explain *why* a symbol was not flagged dead ("kept because").
 */
export interface KeptEntryPoint {
  readonly name: string;
  /** Persisted entry-point classification (main/route/task/event/…). */
  readonly entryPointKind: EntryPointKind;
  /** Persisted explainability trail for the entry-point score, when present. */
  readonly entryPointReason?: string;
}

/** Result of a {@link findDeadCode} query. */
export interface DeadCodeResult {
  readonly candidates: readonly DeadCodeCandidate[];
  /** Total candidates found BEFORE the maxResults cap was applied. */
  readonly totalFound: number;
  /**
   * Entry-point symbols excluded by the persisted `entryPointKind` field (Wave 2),
   * with their `entryPointReason`. Empty for pre-Wave-2 graphs (excluded purely by
   * the name regex, which carries no persisted reason). Capped for response size.
   */
  readonly keptEntryPoints: readonly KeptEntryPoint[];
}

const DEFAULT_MAX_RESULTS = 100;

/**
 * True when a symbol is considered "exported" — part of the public surface, so
 * an in-repo caller is not required for it to be live.
 *
 * Wave 2: prefer the real per-language `isExported` signal (1.3) when present,
 * falling back to the pre-Wave-2 `visibility === "public" || kind === "export"`
 * heuristic for graphs indexed before the field existed.
 */
function isExported(symbol: Symbol): boolean {
  return symbol.isExported ?? (symbol.visibility === "public" || symbol.kind === "export");
}

/** Cap on the number of {@link KeptEntryPoint} entries surfaced (response size). */
const KEPT_ENTRY_POINT_CAP = 50;

/**
 * True when a symbol is a framework/runtime entry point and so legitimately
 * uncalled in-repo.
 *
 * Wave 8 (T1): prefer the REAL persisted `entryPointKind` (Wave 2, scored by the
 * entry-point classifier) over the `isEntryPointName` NAME regex. The regex is
 * kept as the fallback for graphs indexed before Wave 2 (the field is absent).
 */
function isEntryPoint(symbol: Symbol): boolean {
  return symbol.entryPointKind !== undefined || isEntryPointName(symbol.name);
}

/**
 * Find dead-code candidates: symbols with no incoming CALLS edge that are
 * neither exported nor entry-point-named.
 *
 * @param graph   graph adapter
 * @param options optional `kind` filter and `maxResults` cap
 */
export async function findDeadCode(
  graph: GraphAdapter,
  options: FindDeadCodeOptions = {},
): Promise<DeadCodeResult> {
  const maxResults = options.maxResults && options.maxResults > 0
    ? options.maxResults
    : DEFAULT_MAX_RESULTS;

  // Symbols that are never the TARGET of a CALLS edge (no in-repo callers).
  // NOTE: pattern-predicate `NOT (s)<-[:CALLS]-()` rather than the `EXISTS { }`
  // subquery form — this backend's parser rejects the existential subquery block.
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (s:Symbol)
     WHERE NOT (s)<-[:CALLS]-()
     RETURN s AS n`,
    {},
  ) ?? [];

  const candidates: DeadCodeCandidate[] = [];
  const keptEntryPoints: KeptEntryPoint[] = [];
  for (const row of rows) {
    if (!row?.n?.properties) continue;
    const symbol = graphNodeToSymbol(rowToNode(row));

    // Apply the optional kind filter first.
    if (options.kind && symbol.kind !== options.kind) continue;

    // Exclude exports (public surface) and entry-point symbols
    // (framework/runtime invoked) — these are legitimately uncalled in-repo.
    if (isExported(symbol)) continue;
    if (isEntryPoint(symbol)) {
      // Surface the "kept because" reason from the persisted entry-point fields
      // (Wave 2). Only symbols with a real `entryPointKind` carry a reason; ones
      // excluded purely by the name regex (pre-Wave-2 graphs) are not listed.
      if (symbol.entryPointKind !== undefined && keptEntryPoints.length < KEPT_ENTRY_POINT_CAP) {
        keptEntryPoints.push({
          name: symbol.name,
          entryPointKind: symbol.entryPointKind,
          ...(symbol.entryPointReason ? { entryPointReason: symbol.entryPointReason } : {}),
        });
      }
      continue;
    }

    candidates.push({ symbol });
  }

  const totalFound = candidates.length;
  return { candidates: candidates.slice(0, maxResults), totalFound, keptEntryPoints };
}

/** The standing caveat appended to every find_dead_code summary. */
export const DEAD_CODE_CAVEAT =
  "These are candidates, verify before deletion — dynamic/reflective calls are not tracked.";
