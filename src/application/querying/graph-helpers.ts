/**
 * Shared graph query helpers extracted from context-retrieval.ts,
 * impact-analysis.ts, and data-flow-trace.ts to eliminate duplication.
 * Requirements: 5.5
 */
import type { GraphAdapter, GraphNode } from "../../core/ports/persistence.js";
import { prop } from "../../core/ports/persistence.js";
import type { Symbol, SymbolKind, Visibility, EntryPointKind } from "../../core/domain.js";

/**
 * True when an error is a Kùzu "Table <X> does not exist" binder error — i.e.
 * the queried REL/NODE table is absent from this DB's schema (e.g. a graph
 * indexed before the data-touch tables existed, or never re-initialized).
 * The message arrives wrapped differently across the local vs remote/gRPC
 * adapters, so match on the stable substrings rather than an exact shape.
 */
function isMissingTableError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
  return /does not exist/i.test(msg) && /\btable\b/i.test(msg);
}

/**
 * Run a read-only Cypher query, tolerating a MISSING table as an empty result.
 * For the data-touch read tools (route_map / what_reads_table / event tools) a
 * DB whose schema predates the data-touch REL tables throws a "Table X does not
 * exist" binder error instead of returning zero rows — but semantically that is
 * just "no data-touch data indexed", so it degrades to `[]` (matching each
 * tool's documented degrade-to-empty contract). Any OTHER error still propagates.
 */
export async function runCypherTolerant<T>(
  graph: GraphAdapter,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  try {
    return (await graph.runCypher<T>(cypher, params)) ?? [];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
}

/** Shape returned by Cypher queries that project a single `n` node. */
export interface CypherNodeRow {
  n: { labels: string[]; properties: Record<string, string> };
}

/** Convert a raw Cypher node row into a database-agnostic GraphNode. */
export function rowToNode(row: CypherNodeRow): GraphNode {
  const n = row.n;
  return { id: n.properties["id"] ?? "", labels: n.labels, properties: n.properties };
}

/**
 * Wave 5: row for the data-flow trace query that ALSO projects, per reachable
 * node, whether it is a route handler (outbound `HANDLES_ROUTE` to an endpoint)
 * and/or a data-access symbol (outbound `READS_FROM_DB`/`WRITES_TO_DB` to a
 * model), plus the touch-edge's `confidence` prop (a STRING, since all Kùzu
 * columns are STRING). `hasRoute`/`hasDb` come back as boolean-ish values from
 * Cypher (`true`/`false`); `edgeConfidence` is the coalesced confidence STRING or
 * null when the node has no touch edge.
 */
export interface DataFlowTraceRow {
  n: { labels: string[]; properties: Record<string, string> };
  hasRoute: boolean | null;
  hasDb: boolean | null;
  edgeConfidence: string | number | null;
}

/** Edge-resolved per-node touch evidence carried alongside its GraphNode. */
export interface TouchedNode {
  node: GraphNode;
  /** `"api"` if the node has an outbound HANDLES_ROUTE, `"model"` if READS/WRITES_TO_DB, else undefined. */
  touchLayer?: "api" | "model";
  /** Parsed `[0,1]` confidence of the touch edge, when present. */
  edgeConfidence?: number;
}

/** Map a {@link DataFlowTraceRow} into a {@link TouchedNode} (edge-resolved layer + confidence). */
export function rowToTouchedNode(row: DataFlowTraceRow): TouchedNode {
  const node: GraphNode = {
    id: row.n.properties["id"] ?? "",
    labels: row.n.labels,
    properties: row.n.properties,
  };
  const hasRoute = row.hasRoute === true;
  const hasDb = row.hasDb === true;
  // HANDLES_ROUTE (api) takes precedence over a DB touch on the same node.
  const touchLayer: "api" | "model" | undefined = hasRoute ? "api" : hasDb ? "model" : undefined;
  let edgeConfidence: number | undefined;
  if (row.edgeConfidence !== null && row.edgeConfidence !== undefined) {
    const n = typeof row.edgeConfidence === "number" ? row.edgeConfidence : parseFloat(row.edgeConfidence);
    if (Number.isFinite(n)) edgeConfidence = Math.max(0, Math.min(1, n));
  }
  return { node, ...(touchLayer ? { touchLayer } : {}), ...(edgeConfidence !== undefined ? { edgeConfidence } : {}) };
}

/** Convert a GraphNode into the application-level Symbol type. */
export function graphNodeToSymbol(node: GraphNode): Symbol {
  return {
    id: node.id,
    // The PERSISTED node id IS the logicalKey (A1); post-persistence the
    // intra-run id no longer exists, so identity and persisted key coincide here.
    logicalKey: node.id,
    name: prop(node, "name", node.id),
    kind: prop(node, "kind", "function") as SymbolKind,
    location: {
      filePath: prop(node, "filePath"),
      startLine: parseInt(prop(node, "startLine", "0"), 10),
      startColumn: parseInt(prop(node, "startColumn", "0"), 10),
      endLine: parseInt(prop(node, "endLine", "0"), 10),
      endColumn: parseInt(prop(node, "endColumn", "0"), 10),
    },
    signature: node.properties["signature"] as string | undefined,
    // Wave 8 (T8): read back the persisted `documentation` (e.g. the framework
    // ORM-model enrichment summary). Persisted as a node prop but previously
    // dropped on the read path. Left UNDEFINED when absent/empty so the Symbol
    // shape stays unchanged for symbols without documentation.
    ...(prop(node, "documentation") ? { documentation: prop(node, "documentation") } : {}),
    visibility: prop(node, "visibility", "public") as Visibility,
    modifiers: [],
    // Wave 2: read back the export flag + entry-point classification props.
    // `isExported` is left UNDEFINED for pre-Wave-2 graphs (the column is absent
    // → `prop` returns ""), so consumers fall back to the `visibility`-based
    // heuristic. `entryPointKind`/`entryPointReason` are undefined when empty.
    ...(prop(node, "isExported") === "true"
      ? { isExported: true }
      : prop(node, "isExported") === "false"
        ? { isExported: false }
        : {}),
    ...(prop(node, "entryPointKind") ? { entryPointKind: prop(node, "entryPointKind") as EntryPointKind } : {}),
    ...(prop(node, "entryPointReason") ? { entryPointReason: prop(node, "entryPointReason") } : {}),
    // Wave 5: read back the synthetic-Symbol tag (data-touch DB-model / API-endpoint
    // anchors). Absent / "" for real source-derived Symbols (left undefined).
    ...(prop(node, "synthetic") === "true" ? { synthetic: true } : {}),
  };
}
