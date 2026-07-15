/**
 * Route enumeration over persisted `HANDLES_ROUTE` edges (Wave 8 · T4).
 *
 * Lists every API endpoint the indexer linked a handler to — the
 * `(handler:Symbol)-[:HANDLES_ROUTE]->(endpoint:Symbol)` edges the data-touch
 * pass (W5) and the structured framework extractors (W6, incl. Laravel resource
 * expansion) emit. The endpoint node is either a synthetic `apiendpoint:<M>:<path>`
 * anchor or a reused real framework route Symbol, so this keys off the INBOUND
 * `HANDLES_ROUTE` edge (not the `apiendpoint:` id prefix), per the route detector
 * contract (`routes.ts ensureEndpoint`).
 *
 * Strictly READ-ONLY. DEGRADE-TO-EMPTY: when the data-touch pass did not run at
 * index time (`TYPOCOP_DATA_TOUCH` off) the query returns ZERO rows; and when the
 * DB's schema predates the `HANDLES_ROUTE` table (absent, not just empty),
 * `runCypherTolerant` turns the binder "Table does not exist" error into an empty
 * result. Either way the caller gets a clear empty result, never a failure.
 */
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { runCypherTolerant } from "./graph-helpers.js";

/** One enumerated route: the endpoint + the handler that serves it. */
export interface RouteEntry {
  /** Endpoint id — synthetic `apiendpoint:<METHOD>:<path>` or a real route Symbol id. */
  readonly endpointId: string;
  /** Endpoint display name, e.g. `"GET /users"`. */
  readonly endpointName: string;
  /** The handler Symbol id linked via `HANDLES_ROUTE`. */
  readonly handlerId: string;
  /** The handler Symbol name. */
  readonly handlerName: string;
  /** Handler file path (for the agent to locate the route). */
  readonly handlerFilePath: string;
  /** `[0,1]` confidence of the `HANDLES_ROUTE` edge, when present. */
  readonly confidence?: number;
  /** The edge's `reason` provenance string (e.g. `decorator-Get`), when present. */
  readonly reason?: string;
}

/** Result of a {@link findRoutes} query. */
export interface RouteMapResult {
  readonly routes: readonly RouteEntry[];
  /** Total routes found BEFORE the maxResults cap. */
  readonly totalFound: number;
}

/** Row shape projected by the route-enumeration query. */
interface RouteRow {
  endpointId: string | null;
  endpointName: string | null;
  handlerId: string | null;
  handlerName: string | null;
  handlerFilePath: string | null;
  confidence: string | number | null;
  reason: string | null;
}

const DEFAULT_MAX_RESULTS = 100;

/** Parse a STRING/number confidence prop into a clamped `[0,1]` number, or undefined. */
function parseConfidence(raw: string | number | null): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

/**
 * Enumerate all routes via the persisted `HANDLES_ROUTE` edges.
 *
 * @param graph   graph adapter
 * @param options optional `maxResults` cap
 */
export async function findRoutes(
  graph: GraphAdapter,
  options: { readonly maxResults?: number } = {},
): Promise<RouteMapResult> {
  const maxResults = options.maxResults && options.maxResults > 0 ? options.maxResults : DEFAULT_MAX_RESULTS;

  // Bare labels/types — the adapter prefixes `:Symbol` / `[:HANDLES_ROUTE]`.
  // runCypherTolerant degrades a missing HANDLES_ROUTE table (a DB whose schema
  // predates the data-touch tables) to an empty result, per the tool contract.
  const rows = await runCypherTolerant<RouteRow>(
    graph,
    `MATCH (h:Symbol)-[e:HANDLES_ROUTE]->(ep:Symbol)
     RETURN ep.id AS endpointId, ep.name AS endpointName,
            h.id AS handlerId, h.name AS handlerName, h.filePath AS handlerFilePath,
            e.confidence AS confidence, e.reason AS reason`,
  );

  const routes: RouteEntry[] = [];
  for (const row of rows) {
    if (!row?.endpointId || !row?.handlerId) continue;
    routes.push({
      endpointId: row.endpointId,
      endpointName: row.endpointName ?? row.endpointId,
      handlerId: row.handlerId,
      handlerName: row.handlerName ?? row.handlerId,
      handlerFilePath: row.handlerFilePath ?? "",
      ...(parseConfidence(row.confidence) !== undefined ? { confidence: parseConfidence(row.confidence) } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    });
  }

  return { routes: routes.slice(0, maxResults), totalFound: routes.length };
}
