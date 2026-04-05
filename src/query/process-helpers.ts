/**
 * Shared helpers for converting graph nodes to Process and Cluster domain objects.
 * Centralises the previously duplicated graphNodeToProcess / graphNodeToCluster
 * functions and fixes the bug where steps were always returned as [].
 * Requirements: 2.1, 3.2
 */
import type { Session } from "neo4j-driver";
import type { Process, Cluster, ClusterCategory } from "../types/index.js";
import type { GraphNode } from "../graph/connection.js";
import { findProcessSteps } from "../graph/query.js";

/**
 * Convert a Process GraphNode to a Process domain object.
 * Populates `steps` by querying HAS_STEP edges via findProcessSteps.
 * Requirements: 2.1
 */
export async function graphNodeToProcess(node: GraphNode, session: Session): Promise<Process> {
  const p = node.properties;
  const steps = await findProcessSteps(session, node.id);
  return {
    id: node.id,
    name: p["name"] ?? node.id,
    entryPoint: p["entryPoint"] ?? "",
    steps,
    dataFlow: [],
  };
}

/**
 * Convert a Cluster GraphNode to a Cluster domain object.
 * Logic is identical to the copies previously in all three query files.
 * Requirements: 3.2
 */
export function graphNodeToCluster(node: GraphNode): Cluster {
  const p = node.properties;
  return {
    id: node.id,
    name: p["name"] ?? node.id,
    symbols: [],
    confidence: parseFloat(p["confidence"] ?? "0.8"),
    category: (p["category"] ?? "unknown") as ClusterCategory,
  };
}
