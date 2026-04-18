/**
 * Graph database write operations.
 * Requirements: 3.8, 16.1, 16.2
 */
import type { Session } from "neo4j-driver";
import type { GraphNode, GraphEdge } from "./connection.js";

/**
 * Store nodes as Neo4j nodes with prefixed labels and properties.
 * Uses MERGE to avoid duplicates (Req 4.3).
 * Requirements: 16.1, 2.1
 */
export async function storeNodes(session: Session, nodes: GraphNode[], prefix: string): Promise<void> {
  if (nodes.length === 0) return;

  // Batch in groups of 500 to avoid large transactions
  const BATCH = 500;
  for (let i = 0; i < nodes.length; i += BATCH) {
    const batch = nodes.slice(i, i + BATCH);
    await session.executeWrite((tx) =>
      tx.run(
        `UNWIND $nodes AS n
         CALL apoc.merge.node(n.labels, {id: n.id}, n.properties) YIELD node
         RETURN count(node)`,
        {
          nodes: batch.map((n) => ({
            id: n.id,
            labels: n.labels.map((l) => `${prefix}${l}`),
            properties: { ...n.properties, id: n.id },
          })),
        },
      )
    ).catch(async () => {
      // Fallback without APOC: iterate individually
      for (const n of batch) {
        const label = `${prefix}${n.labels[0] ?? "Symbol"}`;
        await session.executeWrite((tx) =>
          tx.run(
            `MERGE (x:${label} {id: $id}) SET x += $props`,
            { id: n.id, props: { ...n.properties, id: n.id } },
          )
        );
      }
    });
  }
}

/**
 * Store edges as Neo4j relationships with a prefixed relationship type.
 * Requirements: 16.2, 2.2
 */
export async function storeEdges(session: Session, edges: GraphEdge[], prefix: string): Promise<void> {
  if (edges.length === 0) return;

  const BATCH = 500;
  for (let i = 0; i < edges.length; i += BATCH) {
    const batch = edges.slice(i, i + BATCH);
    for (const edge of batch) {
      const relType = `${prefix}${edge.relType}`;
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (a {id: $src}), (b {id: $tgt})
           MERGE (a)-[r:${relType}]->(b)
           SET r += $props`,
          { src: edge.source, tgt: edge.target, props: edge.properties },
        )
      );
    }
  }
}

/**
 * Clear all graph data for a given prefix.
 * Deletes all relationships first (to avoid foreign key constraint issues),
 * then deletes all nodes with prefixed labels.
 * Idempotent: safe to call multiple times.
 * Requirements: 3.7, 16.3
 */
export async function clearGraphData(session: Session, prefix: string): Promise<{ nodesDeleted: number; relationshipsDeleted: number }> {
  try {
    // Step 1: Delete all relationships with prefixed types
    const relResult = await session.executeWrite((tx) =>
      tx.run(
        `MATCH ()-[r]->()
         WHERE type(r) STARTS WITH $prefix
         DELETE r
         RETURN count(r) AS count`,
        { prefix },
      )
    );

    const relCount = relResult.records[0]?.get("count") ?? 0;

    // Step 2: Delete all nodes with prefixed labels
    const nodeResult = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (n)
         WHERE any(label IN labels(n) WHERE label STARTS WITH $prefix)
         DETACH DELETE n
         RETURN count(n) AS count`,
        { prefix },
      )
    );

    const nodeCount = nodeResult.records[0]?.get("count") ?? 0;

    // Step 3: Log deletion counts
    console.error(`[clearGraphData] Deleted ${relCount} relationships and ${nodeCount} nodes with prefix "${prefix}"`);
    
    return { nodesDeleted: nodeCount, relationshipsDeleted: relCount };
  } catch (err) {
    // Handle errors gracefully and propagate
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[clearGraphData] Error clearing graph data for prefix "${prefix}": ${message}`);
    throw err;
  }
}
