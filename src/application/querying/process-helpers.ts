/**
 * Shared helpers for converting graph nodes to Process and Cluster domain objects.
 * Requirements: 2.1, 3.2
 */
import type { Process, Cluster, ClusterCategory } from "../../core/domain.js";
import type { GraphAdapter, GraphNode } from "../../core/ports/persistence.js";
import { prop } from "../../core/ports/persistence.js";

/**
 * Convert a Process GraphNode to a Process domain object.
 * Populates `steps` by querying HAS_STEP edges via GraphAdapter.runCypher().
 * Requirements: 2.1
 */
export async function graphNodeToProcess(node: GraphNode, graphAdapter: GraphAdapter): Promise<Process> {
  interface CypherStepRow {
    symbolId: string;
    stepOrder: number;
    description: string | null;
  }

  const rows = await graphAdapter.runCypher<CypherStepRow>(
    `MATCH (p:Process {id: $processId})-[r:HAS_STEP]->(s:Symbol)
     RETURN s.id AS symbolId, r.step_order AS stepOrder, s.name AS description
     ORDER BY r.step_order ASC`,
    { processId: node.id },
  );

  const steps = rows.map((r) => ({
    order: r.stepOrder,
    symbolId: r.symbolId,
    description: r.description ?? "",
  }));

  return {
    id: node.id,
    name: prop(node, "name", node.id),
    entryPoint: prop(node, "entryPoint"),
    steps,
    dataFlow: [],
  };
}

/**
 * Convert a Cluster GraphNode to a Cluster domain object.
 * Requirements: 3.2
 */
export function graphNodeToCluster(node: GraphNode): Cluster {
  return {
    id: node.id,
    name: prop(node, "name", node.id),
    symbols: [],
    confidence: parseFloat(prop(node, "confidence", "0.8")),
    category: prop(node, "category", "unknown") as ClusterCategory,
  };
}
