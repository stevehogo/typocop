/**
 * Shared graph query helpers extracted from context-retrieval.ts,
 * impact-analysis.ts, and data-flow-trace.ts to eliminate duplication.
 * Requirements: 5.5
 */
import type { GraphNode } from "../../core/ports/persistence.js";
import { prop } from "../../core/ports/persistence.js";
import type { Symbol, SymbolKind, Visibility, EntryPointKind } from "../../core/domain.js";

/** Shape returned by Cypher queries that project a single `n` node. */
export interface CypherNodeRow {
  n: { labels: string[]; properties: Record<string, string> };
}

/** Convert a raw Cypher node row into a database-agnostic GraphNode. */
export function rowToNode(row: CypherNodeRow): GraphNode {
  const n = row.n;
  return { id: n.properties["id"] ?? "", labels: n.labels, properties: n.properties };
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
  };
}
