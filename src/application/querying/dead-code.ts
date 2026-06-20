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
import type { Symbol, SymbolKind } from "../../core/domain.js";
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

/** Result of a {@link findDeadCode} query. */
export interface DeadCodeResult {
  readonly candidates: readonly DeadCodeCandidate[];
  /** Total candidates found BEFORE the maxResults cap was applied. */
  readonly totalFound: number;
}

const DEFAULT_MAX_RESULTS = 100;

/**
 * True when a symbol is considered "exported" — part of the public surface, so
 * an in-repo caller is not required for it to be live.
 */
function isExported(symbol: Symbol): boolean {
  return symbol.visibility === "public" || symbol.kind === "export";
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
  const rows = await graph.runCypher<CypherNodeRow>(
    `MATCH (s:Symbol)
     WHERE NOT EXISTS { (s)<-[:CALLS]-() }
     RETURN s AS n`,
    {},
  ) ?? [];

  const candidates: DeadCodeCandidate[] = [];
  for (const row of rows) {
    if (!row?.n?.properties) continue;
    const symbol = graphNodeToSymbol(rowToNode(row));

    // Apply the optional kind filter first.
    if (options.kind && symbol.kind !== options.kind) continue;

    // Exclude exports (public surface) and entry-point-named symbols
    // (framework/runtime invoked) — these are legitimately uncalled in-repo.
    if (isExported(symbol)) continue;
    if (isEntryPointName(symbol.name)) continue;

    candidates.push({ symbol });
  }

  const totalFound = candidates.length;
  return { candidates: candidates.slice(0, maxResults), totalFound };
}

/** The standing caveat appended to every find_dead_code summary. */
export const DEAD_CODE_CAVEAT =
  "These are candidates, verify before deletion — dynamic/reflective calls are not tracked.";
