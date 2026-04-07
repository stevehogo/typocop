/**
 * Graph database interface — public API.
 * Requirements: 3.8, 16.1–16.7, 19.1, 19.2, 20.5, 23.4
 */
export type { GraphNode, GraphEdge } from "./connection.js";
export { createDriver, withRetry, type Driver } from "./connection.js";
export { storeNodes, storeEdges } from "./store.js";
export { GraphStore } from "./graph-store.js";
export { findNode, findDependents, findDependencies, traversePath, findProcessesBySymbol, findClustersBySymbol } from "./query.js";
