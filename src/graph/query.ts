/**
 * Graph database query operations.
 * Requirements: 16.3, 16.4, 16.5, 16.6, 16.7, 20.5, 23.4
 */
import type { Session, ManagedTransaction } from "neo4j-driver";
import type { GraphNode, GraphEdge } from "./connection.js";
import type { ProcessStep } from "../types/index.js";
import { MAX_TRAVERSAL_DEPTH } from "../utils/limits.js";

function rowToNode(record: Record<string, unknown>): GraphNode {
  const n = record["n"] as { labels: string[]; properties: Record<string, string> };
  return {
    id: n.properties["id"] ?? "",
    labels: n.labels,
    properties: n.properties,
  };
}

// ---------------------------------------------------------------------------
// Transaction-scoped variants — accept a ManagedTransaction so all reads for
// a single tool call can be consolidated into one session.executeRead() block.
// Requirements: 2.6
// ---------------------------------------------------------------------------

/**
 * Find a single node by ID or name within an existing managed transaction.
 */
export async function txFindNode(tx: ManagedTransaction, idOrName: string): Promise<GraphNode | null> {
  const result = await tx.run(
    `MATCH (n) WHERE n.id = $val OR n.name = $val RETURN n LIMIT 1`,
    { val: idOrName },
  );
  if (result.records.length === 0) return null;
  return rowToNode(result.records[0].toObject());
}

/**
 * Find all nodes that depend on the target symbol within an existing managed transaction.
 */
export async function txFindDependents(tx: ManagedTransaction, symbolId: string): Promise<GraphNode[]> {
  const result = await tx.run(
    `MATCH (n)-[*1..${MAX_TRAVERSAL_DEPTH}]->(t) WHERE t.id = $val OR t.name = $val RETURN DISTINCT n`,
    { val: symbolId },
  );
  return result.records.map((r) => rowToNode(r.toObject()));
}

/**
 * Find all nodes that the target symbol depends on within an existing managed transaction.
 */
export async function txFindDependencies(tx: ManagedTransaction, symbolId: string): Promise<GraphNode[]> {
  const result = await tx.run(
    `MATCH (s)-[*1..${MAX_TRAVERSAL_DEPTH}]->(n) WHERE s.id = $val OR s.name = $val RETURN DISTINCT n`,
    { val: symbolId },
  );
  return result.records.map((r) => rowToNode(r.toObject()));
}

/**
 * Find all Process nodes containing the symbol within an existing managed transaction.
 */
export async function txFindProcessesBySymbol(tx: ManagedTransaction, symbolId: string): Promise<GraphNode[]> {
  const result = await tx.run(
    `MATCH (p:Process)-[:HAS_STEP]->(s) WHERE s.id = $val OR s.name = $val RETURN DISTINCT p`,
    { val: symbolId },
  );
  return result.records.map((r) => {
    const n = r.get("p") as { labels: string[]; properties: Record<string, string> };
    return { id: n.properties["id"] ?? "", labels: n.labels, properties: n.properties };
  });
}

/**
 * Find all Cluster nodes containing the symbol within an existing managed transaction.
 */
export async function txFindClustersBySymbol(tx: ManagedTransaction, symbolId: string): Promise<GraphNode[]> {
  const result = await tx.run(
    `MATCH (c:Cluster)-[:CONTAINS]->(s) WHERE s.id = $val OR s.name = $val RETURN DISTINCT c`,
    { val: symbolId },
  );
  return result.records.map((r) => {
    const n = r.get("c") as { labels: string[]; properties: Record<string, string> };
    return { id: n.properties["id"] ?? "", labels: n.labels, properties: n.properties };
  });
}

/**
 * Find all ProcessStep records for a process within an existing managed transaction.
 */
export async function txFindProcessSteps(tx: ManagedTransaction, processId: string): Promise<ProcessStep[]> {
  const result = await tx.run(
    `MATCH (p:Process {id: $processId})-[r:HAS_STEP]->(s)
     RETURN s.id AS symbolId, r.order AS order, s.name AS description
     ORDER BY r.order ASC`,
    { processId },
  );
  if (result.records.length === 0) return [];
  return result.records.map((record) => ({
    order: record.get("order") as number,
    symbolId: record.get("symbolId") as string,
    description: (record.get("description") as string | null) ?? "",
  }));
}

/**
 * Find a single node by ID or name. Target: <100ms (Req 16.3, 20.5).
 */
export async function findNode(session: Session, idOrName: string): Promise<GraphNode | null> {
  const result = await session.executeRead((tx) =>
    tx.run(`MATCH (n) WHERE n.id = $val OR n.name = $val RETURN n LIMIT 1`, { val: idOrName }),
  );
  if (result.records.length === 0) return null;
  return rowToNode(result.records[0].toObject());
}

/**
 * Find all nodes that depend on (call/import/inherit from) the target symbol.
 * Enforces MAX_TRAVERSAL_DEPTH (Req 16.4, 16.7, 23.4).
 */
export async function findDependents(session: Session, symbolId: string): Promise<GraphNode[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (n)-[*1..${MAX_TRAVERSAL_DEPTH}]->(t) WHERE t.id = $val OR t.name = $val RETURN DISTINCT n`,
      { val: symbolId },
    ),
  );
  return result.records.map((r) => rowToNode(r.toObject()));
}

/**
 * Find all nodes that the target symbol depends on.
 * Enforces MAX_TRAVERSAL_DEPTH (Req 16.5, 16.7, 23.4).
 */
export async function findDependencies(session: Session, symbolId: string): Promise<GraphNode[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (s)-[*1..${MAX_TRAVERSAL_DEPTH}]->(n) WHERE s.id = $val OR s.name = $val RETURN DISTINCT n`,
      { val: symbolId },
    ),
  );
  return result.records.map((r) => rowToNode(r.toObject()));
}

/**
 * Find all Process nodes that contain the given symbol as a step.
 * Requirements: 10.3, 12.4
 */
export async function findProcessesBySymbol(session: Session, symbolId: string): Promise<GraphNode[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (p:Process)-[:HAS_STEP]->(s) WHERE s.id = $val OR s.name = $val RETURN DISTINCT p`,
      { val: symbolId },
    ),
  );
  return result.records.map((r) => {
    const n = r.get("p") as { labels: string[]; properties: Record<string, string> };
    return { id: n.properties["id"] ?? "", labels: n.labels, properties: n.properties };
  });
}

/**
 * Find all ProcessStep records for a given process by querying HAS_STEP edges.
 * Returns steps ordered ascending by the `order` relationship property.
 * Requirements: 2.1
 */
export async function findProcessSteps(session: Session, processId: string): Promise<ProcessStep[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (p:Process {id: $processId})-[r:HAS_STEP]->(s)
       RETURN s.id AS symbolId, r.order AS order, s.name AS description
       ORDER BY r.order ASC`,
      { processId },
    ),
  );
  if (result.records.length === 0) return [];
  return result.records.map((record) => ({
    order: record.get("order") as number,
    symbolId: record.get("symbolId") as string,
    description: (record.get("description") as string | null) ?? "",
  }));
}

/**
 * Find all Cluster nodes that contain the given symbol.
 * Requirements: 12.5
 */
export async function findClustersBySymbol(session: Session, symbolId: string): Promise<GraphNode[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (c:Cluster)-[:CONTAINS]->(s) WHERE s.id = $val OR s.name = $val RETURN DISTINCT c`,
      { val: symbolId },
    ),
  );
  return result.records.map((r) => {
    const n = r.get("c") as { labels: string[]; properties: Record<string, string> };
    return { id: n.properties["id"] ?? "", labels: n.labels, properties: n.properties };
  });
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
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH p = (a {id: $from})-[*1..${MAX_TRAVERSAL_DEPTH}]->(b {id: $to})
       RETURN relationships(p) AS rels`,
      { from, to },
    ),
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
