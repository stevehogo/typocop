/**
 * "What code touches table X" over persisted `READS_FROM_DB` / `WRITES_TO_DB`
 * edges (Wave 8 · T4).
 *
 * Given a table/model name, resolves it to its DB-model node and lists the
 * INBOUND data-access symbols: `(code:Symbol)-[:READS_FROM_DB|WRITES_TO_DB]->(model:Symbol)`.
 * The model node is either a synthetic `dbmodel:<table>` anchor (Prisma / fallback
 * path) or a REAL class Symbol reused as the model (`detectDBModels` records
 * `table → real sym.id` with NO synthetic mint) — so resolution matches EITHER
 * the `dbmodel:<lowercased-table>` id OR a node whose lower-cased name equals the
 * table.
 *
 * Distinct from `impact_analysis` / `find_dependents` (keyed on CALLS) — this is
 * keyed on the DATA edges, answering a different question.
 *
 * Strictly READ-ONLY. DEGRADE-TO-EMPTY: when the data-touch pass did not run
 * (`TYPOCOP_DATA_TOUCH` off) the query returns ZERO rows; and when the DB's
 * schema predates the data-touch REL tables (so the table is absent, not just
 * empty) `runCypherTolerant` turns the binder "Table does not exist" error into
 * an empty result too. Either way the caller gets a clear empty result, never an error.
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import type { Symbol } from "../../core/domain.js";
import { runCypherTolerant } from "./graph-helpers.js";
import { graphNodeToSymbol, rowToNode } from "./graph-helpers.js";
import type { CypherNodeRow } from "./graph-helpers.js";

/** The data-access direction to query. */
export type TableTouchDirection = "reads" | "writes";

/** One code symbol that touches the table, plus the touch-edge provenance. */
export interface TableToucher {
  readonly symbol: Symbol;
  /** `[0,1]` confidence of the touch edge, when present. */
  readonly confidence?: number;
  /** The edge's `reason` provenance string (e.g. `prisma-findMany`), when present. */
  readonly reason?: string;
}

/** Result of a {@link findTableTouchers} query. */
export interface TableTouchResult {
  /** The table name that was queried (echoed back, lower-cased). */
  readonly table: string;
  /** `reads` → READS_FROM_DB, `writes` → WRITES_TO_DB. */
  readonly direction: TableTouchDirection;
  readonly touchers: readonly TableToucher[];
  /** Total touchers found BEFORE the maxResults cap. */
  readonly totalFound: number;
}

/** Row shape: the projected data-access node `n` + the edge props. */
interface TableTouchRow extends CypherNodeRow {
  confidence: string | number | null;
  reason: string | null;
}

const DEFAULT_MAX_RESULTS = 100;
/** Synthetic DB-model id prefix (mirrors data-touch `DB_MODEL_ID_PREFIX`). */
const DB_MODEL_ID_PREFIX = "dbmodel:";

/** Parse a STRING/number confidence prop into a clamped `[0,1]` number, or undefined. */
function parseConfidence(raw: string | number | null): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

/**
 * List the code symbols that read from / write to `table`.
 *
 * @param graph     graph adapter
 * @param table     table / model name (case-insensitive)
 * @param direction `reads` (READS_FROM_DB) or `writes` (WRITES_TO_DB)
 * @param options   optional `maxResults` cap
 */
export async function findTableTouchers(
  graph: GraphAdapter,
  table: string,
  direction: TableTouchDirection,
  options: { readonly maxResults?: number } = {},
): Promise<TableTouchResult> {
  const maxResults = options.maxResults && options.maxResults > 0 ? options.maxResults : DEFAULT_MAX_RESULTS;
  const lowered = table.trim().toLowerCase();
  const modelId = `${DB_MODEL_ID_PREFIX}${lowered}`;

  // Bare labels/types — the adapter prefixes `:Symbol` / `[:READS_FROM_DB]` etc.
  // The edge type is chosen by `direction` (not interpolated user input), so this
  // stays a fixed, safe read.
  const edgeType = direction === "reads" ? "READS_FROM_DB" : "WRITES_TO_DB";
  // NOTE: the bind param is named `tableName`, NOT `table` — `$table` collides
  // with the reserved TABLE keyword in this engine's parser and is rejected.
  const rows = await runCypherTolerant<TableTouchRow>(
    graph,
    `MATCH (s:Symbol)-[e:${edgeType}]->(m:Symbol)
     WHERE m.id = $modelId OR toLower(m.name) = $tableName
     RETURN DISTINCT s AS n, e.confidence AS confidence, e.reason AS reason`,
    { modelId, tableName: lowered },
  );

  const touchers: TableToucher[] = [];
  for (const row of rows) {
    if (!row?.n?.properties) continue;
    touchers.push({
      symbol: graphNodeToSymbol(rowToNode(row)),
      ...(parseConfidence(row.confidence) !== undefined ? { confidence: parseConfidence(row.confidence) } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    });
  }

  return {
    table: lowered,
    direction,
    touchers: touchers.slice(0, maxResults),
    totalFound: touchers.length,
  };
}
