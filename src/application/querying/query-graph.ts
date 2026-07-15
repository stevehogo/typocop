/**
 * Guarded read-only Cypher query layer (Wave 8 · T9).
 *
 * A SAFE WRAPPER over the existing graph read path (`GraphAdapter.runCypher`),
 * NOT a new engine. It lets an agent run ad-hoc Cypher against the knowledge
 * graph while guaranteeing the query is **read-only and bounded**:
 *
 *   1. Reject mutations / DDL / procedure calls / multi-statement input
 *      BEFORE execution (fail-closed), matching keywords as whole words and
 *      case-insensitively AFTER stripping string literals and comments (so a
 *      keyword inside a quoted string or comment neither hides a real mutation
 *      nor causes a false reject).
 *   2. Require the statement to be a read (MATCH / OPTIONAL MATCH / WITH /
 *      UNWIND / RETURN / CALL-free).
 *   3. Cap the number of returned rows (hard max; truncation is reported).
 *   4. Apply a JS-side statement timeout (best-effort — the underlying Kùzu
 *      query cannot be cancelled, so the hard row cap is the real protection).
 *   5. Strip the persisted `tpc_`-style node/edge-label prefix from every
 *      returned row (mirrors `mcp-server/server.ts:stripPrefixFromMCPResponse`,
 *      but applied recursively to row `labels[]` / rel `type`, not the fixed
 *      `.relationship` field).
 *
 * The adapter auto-injects the persisted label prefix for known schema labels
 * (`prefixQuery` in `ladybug-graph-adapter.ts`), so the query is written with
 * BARE labels (`:Symbol`, `[:CALLS]`) — this layer never prefixes the query
 * itself, and strips the prefix back off the results.
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { withQueryTimeout, QUERY_TIMEOUT_MS } from "../../platform/utils/limits.js";

/** Hard upper bound on rows returned, regardless of any requested `limit`. */
export const QUERY_GRAPH_MAX_ROWS = 200;
/** Default row cap when the caller does not specify a `limit`. */
export const QUERY_GRAPH_DEFAULT_ROWS = 100;

/** Options for {@link queryGraph}. */
export interface QueryGraphOptions {
  /** The raw user Cypher. Bare (unprefixed) labels; single read statement. */
  readonly cypher: string;
  /** Requested row cap; clamped to (0, {@link QUERY_GRAPH_MAX_ROWS}]. */
  readonly limit?: number;
  /** Persisted label prefix to strip from results (e.g. "tpc_"). */
  readonly prefix?: string;
  /** Best-effort JS-side statement timeout (ms). */
  readonly timeoutMs?: number;
}

/** A single returned row: a column-alias → value map (prefix already stripped). */
export type QueryGraphRow = Record<string, unknown>;

/** Result of a {@link queryGraph} call. */
export interface QueryGraphResult {
  /** True when the query passed the read-only guardrails and executed. */
  readonly ok: boolean;
  /** The returned rows (capped at the effective limit). Empty on rejection. */
  readonly rows: readonly QueryGraphRow[];
  /** Number of rows returned (= `rows.length`). */
  readonly rowCount: number;
  /** The effective row cap that was applied. */
  readonly limit: number;
  /** True when the result was truncated to the row cap. */
  readonly truncated: boolean;
  /**
   * When `ok` is false: a stable, human-readable reason the query was rejected
   * pre-execution (prefixed with `unsupported: …` for guardrail failures).
   */
  readonly unsupported?: string;
}

/**
 * Cypher keywords that mutate the graph, change the schema, run procedures, or
 * load/attach external data. Any of these (as a WHOLE WORD, case-insensitive)
 * in the de-literalized / de-commented query rejects it fail-closed.
 *
 * `DETACH DELETE` is covered by both `DETACH` and `DELETE`. `REMOVE`/`SET` cover
 * property mutation; `CALL`/`LOAD`/`COPY`/`INSTALL`/`ATTACH`/`USE` cover
 * procedures and external/multi-db access.
 */
const FORBIDDEN_KEYWORDS: readonly string[] = [
  "CREATE", "MERGE", "SET", "DELETE", "DETACH", "REMOVE",
  "DROP", "ALTER", "CALL", "LOAD", "COPY", "INSTALL", "ATTACH",
  "USE", "FOREACH",
];

/**
 * Read-statement leading keywords. After trimming, a vetted query must begin
 * with one of these (whole-word, case-insensitive) — anything else is rejected.
 */
const READ_LEADERS: readonly string[] = ["MATCH", "OPTIONAL", "WITH", "UNWIND", "RETURN", "CALL"];
// NOTE: "CALL" appears here only so the more specific "starts with CALL" reject
// message wins; CALL is in FORBIDDEN_KEYWORDS and is rejected before this check.

/**
 * Strip Cypher string literals and comments so keyword scanning operates on
 * structural tokens only. Replaces each literal/comment with a single space so
 * token boundaries are preserved (a keyword glued to a stripped literal stays a
 * separate word). Handles: single-quoted `'…'`, double-quoted `"…"`, and
 * backtick-quoted `` `…` `` strings (with `\` escapes inside quotes), line
 * comments (`//`), and C-style block comments.
 */
export function stripLiteralsAndComments(query: string): string {
  let out = "";
  let i = 0;
  const n = query.length;
  while (i < n) {
    const c = query[i];
    // Line comment: // … to end of line
    if (c === "/" && query[i + 1] === "/") {
      i += 2;
      while (i < n && query[i] !== "\n") i++;
      out += " ";
      continue;
    }
    // Block comment: /* … */
    if (c === "/" && query[i + 1] === "*") {
      i += 2;
      while (i < n && !(query[i] === "*" && query[i + 1] === "/")) i++;
      i += 2; // skip closing */ (past-end is harmless)
      out += " ";
      continue;
    }
    // String literal: ' " or `
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (query[i] === "\\") {
          i += 2; // skip escaped char
          continue;
        }
        if (query[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** True when `keyword` appears as a whole word (case-insensitive) in `text`. */
function containsKeyword(text: string, keyword: string): boolean {
  // Word boundaries: Cypher identifiers are [A-Za-z0-9_]; treat anything else
  // (including `:` / `[` / whitespace) as a boundary.
  const re = new RegExp(`(?<![A-Za-z0-9_])${keyword}(?![A-Za-z0-9_])`, "i");
  return re.test(text);
}

/**
 * Validate that `cypher` is a single, read-only statement. Returns an
 * `unsupported: …` reason string when it must be rejected, or `null` when it is
 * safe to execute. Operates on the de-literalized / de-commented form so quoted
 * keywords and comments are neither false positives nor hiding places.
 */
export function validateReadOnlyCypher(cypher: string): string | null {
  const trimmed = cypher.trim();
  if (trimmed === "") {
    return "unsupported: empty query";
  }

  const stripped = stripLiteralsAndComments(cypher);

  // Multi-statement guard: a semicolon anywhere except as a single trailing
  // terminator means more than one statement was supplied.
  const withoutTrailing = stripped.replace(/\s*;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return "unsupported: multiple statements are not allowed (only a single read query)";
  }

  // Forbidden write/DDL/procedure keywords (whole word, case-insensitive).
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (containsKeyword(stripped, kw)) {
      return `unsupported: '${kw}' is not allowed — query_graph is read-only (no mutations, DDL, procedures, or external loads)`;
    }
  }

  // Must START with a read leader (after stripping literals/comments).
  const firstWord = (stripped.trim().match(/^[A-Za-z]+/) ?? [""])[0].toUpperCase();
  if (!READ_LEADERS.includes(firstWord)) {
    return `unsupported: query must start with a read clause (MATCH / OPTIONAL MATCH / WITH / UNWIND / RETURN), got '${firstWord || trimmed.slice(0, 16)}'`;
  }

  return null;
}

/** Clamp a requested limit to the allowed range, defaulting when absent/invalid. */
export function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return QUERY_GRAPH_DEFAULT_ROWS;
  }
  return Math.min(Math.floor(limit), QUERY_GRAPH_MAX_ROWS);
}

/**
 * Recursively strip the persisted label prefix from a returned value. Node/rel
 * values are normalized by the adapter to `{ labels: string[], properties }`
 * and carry the prefix on `labels[]`; relationship rows from the `type` path
 * carry it on a `type` field. Property *values* never carry the prefix, so only
 * `labels` / `type` are rewritten. Plain scalars and other shapes pass through.
 */
export function stripPrefixFromValue(value: unknown, prefix: string): unknown {
  if (!prefix || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((v) => stripPrefixFromValue(v, prefix));
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };

  if (Array.isArray(obj.labels)) {
    out.labels = (obj.labels as unknown[]).map((l) =>
      typeof l === "string" && l.startsWith(prefix) ? l.slice(prefix.length) : l,
    );
  }
  if (typeof obj.type === "string" && obj.type.startsWith(prefix)) {
    out.type = obj.type.slice(prefix.length);
  }
  // Recurse into nested properties (e.g. a node's `properties` map can hold
  // further node/rel values in path/collection projections).
  if (obj.properties && typeof obj.properties === "object") {
    out.properties = stripPrefixFromValue(obj.properties, prefix);
  }
  return out;
}

/** Strip the prefix from every column value of a single row. */
function stripPrefixFromRow(row: QueryGraphRow, prefix: string): QueryGraphRow {
  if (!prefix) return row;
  const out: QueryGraphRow = {};
  for (const [key, val] of Object.entries(row)) {
    out[key] = stripPrefixFromValue(val, prefix);
  }
  return out;
}

/**
 * Run a guarded, read-only, row-capped Cypher query against the graph.
 *
 * Fail-closed: if the query does not pass {@link validateReadOnlyCypher}, this
 * returns `{ ok: false, unsupported }` WITHOUT ever calling the adapter — so a
 * write/DDL string can never reach `runCypher`. On a clean query it executes via
 * the adapter's read path (which auto-prefixes known labels), applies the JS
 * timeout race, caps rows, and strips the prefix from the results.
 */
export async function queryGraph(
  graph: GraphAdapter,
  options: QueryGraphOptions,
): Promise<QueryGraphResult> {
  const limit = clampLimit(options.limit);
  const prefix = options.prefix ?? "";

  const rejection = validateReadOnlyCypher(options.cypher);
  if (rejection !== null) {
    return { ok: false, rows: [], rowCount: 0, limit, truncated: false, unsupported: rejection };
  }

  // Read-only path. The adapter auto-injects the label prefix for known schema
  // labels; we never prefix the query ourselves.
  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
  const rawRows = await withQueryTimeout(
    () => graph.runCypher<QueryGraphRow>(options.cypher, {}),
    timeoutMs,
  );

  const safeRows = rawRows ?? [];
  const truncated = safeRows.length > limit;
  const capped = truncated ? safeRows.slice(0, limit) : safeRows;
  const rows = capped.map((row) => stripPrefixFromRow(row, prefix));

  return { ok: true, rows, rowCount: rows.length, limit, truncated };
}
