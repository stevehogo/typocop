/**
 * Graph database query operations.
 * Requirements: 16.3, 16.4, 16.5, 16.6, 16.7, 20.5, 23.4
 */
import type { Session } from "neo4j-driver";
import type { GraphNode, GraphEdge } from "./connection.js";
import { MAX_TRAVERSAL_DEPTH } from "../utils/limits.js";

function rowToNode(record: Record<string, unknown>): GraphNode {
  const n = record["n"] as { labels: string[]; properties: Record<string, string> };
  return {
    id: n.properties["id"] ?? "",
    labels: n.labels,
    properties: n.properties,
  };
}

/**
 * Find a single node by ID. Target: <100ms (Req 16.3, 20.5).
 */
export async function findNode(session: Session, id: string): Promise<GraphNode | null> {
  const result = await session.run(`MATCH (n {id: $id}) RETURN n LIMIT 1`, { id });
  if (result.records.length === 0) return null;
  return rowToNode(result.records[0].toObject());
}

/**
 * Find all nodes that depend on (call/import/inherit from) the target symbol.
 * Enforces MAX_TRAVERSAL_DEPTH (Req 16.4, 16.7, 23.4).
 */
export async function findDependents(session: Session, symbolId: string): Promise<GraphNode[]> {
  const result = await session.run(
    `MATCH (n)-[*1..${MAX_TRAVERSAL_DEPTH}]->(t {id: $id}) RETURN DISTINCT n`,
    { id: symbolId },
  );
  return result.records.map((r) => rowToNode(r.toObject()));
}

/**
 * Find all nodes that the target symbol depends on.
 * Enforces MAX_TRAVERSAL_DEPTH (Req 16.5, 16.7, 23.4).
 */
export async function findDependencies(session: Session, symbolId: string): Promise<GraphNode[]> {
  const result = await session.run(
    `MATCH (s {id: $id})-[*1..${MAX_TRAVERSAL_DEPTH}]->(n) RETURN DISTINCT n`,
    { id: symbolId },
  );
  return result.records.map((r) => rowToNode(r.toObject()));
}

/**
 * Find all paths between two symbols up to MAX_TRAVERSAL_DEPTH hops.
 * Requirements: 16.6, 16.7, 23.4
 */
export async function traversePath(
  session: Session,
  from: string,
  to: string,
): Promise<GraphEdge[][]> {
  const result = await session.run(
    `MATCH p = (a {id: $from})-[*1..${MAX_TRAVERSAL_DEPTH}]->(b {id: $to})
     RETURN relationships(p) AS rels`,
    { from, to },
  );

  return result.records.map((record) => {
    const rels = record.get("rels") as Array<{
      type: string;
      startNodeElementId: string;
      endNodeElementId: string;
      properties: Record<string, string>;
    }>;
    return rels.map((r) => ({
      source: r.startNodeElementId,
      target: r.endNodeElementId,
      relType: r.type,
      properties: r.properties,
    }));
  });
}
