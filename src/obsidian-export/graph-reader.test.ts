/**
 * Unit tests for GraphReader — fetchAllGraphData with mocked GraphAdapter.
 * Requirements: 2.1–2.9
 */
import { describe, it, expect, vi } from "vitest";
import { fetchAllGraphData } from "./graph-reader.js";
import type { GraphAdapter } from "../db/types.js";

// --- Mock helpers ---

function createMockGraphAdapter(queryResults: Map<string, unknown[]>): GraphAdapter {
  return {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn().mockResolvedValue([]),
    queryRelationships: vi.fn().mockResolvedValue([]),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher: vi.fn().mockImplementation(async (query: string) => {
      for (const [pattern, records] of queryResults) {
        if (query.includes(pattern)) return records;
      }
      return [];
    }),
    runCypherWrite: vi.fn(),
  };
}

describe("fetchAllGraphData", () => {
  it("returns symbols, clusters, processes, relationships, memberships, and steps", async () => {
    const queryResults = new Map<string, unknown[]>();

    // Symbols
    queryResults.set("tpc_Symbol`) RETURN", [
      { id: "sym-1", name: "foo", kind: "function", filePath: "src/a.ts", startLine: 1, endLine: 10, visibility: "public", signature: "foo()", documentation: "Does foo" },
      { id: "sym-2", name: "bar", kind: "class", filePath: "src/b.ts", startLine: 5, endLine: 20, visibility: "private", signature: "class Bar", documentation: "" },
    ]);

    // Clusters
    queryResults.set("tpc_Cluster`) RETURN", [
      { id: "cl-1", name: "core", category: "utility", confidence: 0.85, symbolCount: 2 },
    ]);

    // Processes
    queryResults.set("tpc_Process`) RETURN", [
      { id: "proc-1", name: "Main Flow", entryPoint: "foo", stepCount: 2 },
    ]);

    queryResults.set("RETURN ext.id AS id", [
      { id: "ext:lodash", name: "lodash", aliases: "lodash,Lodash", ecosystem: "npm" },
    ]);

    // Relationships
    queryResults.set("tpc_CALLS", [
      { sourceId: "sym-1", sourceName: "foo", targetId: "sym-2", targetName: "bar" },
    ]);
    queryResults.set("tpc_IMPORTS", []);
    queryResults.set("tpc_INHERITS", []);
    queryResults.set("tpc_IMPLEMENTS", []);

    // Cluster memberships
    queryResults.set("tpc_CONTAINS", [
      { clusterId: "cl-1", symbolId: "sym-1" },
      { clusterId: "cl-1", symbolId: "sym-2" },
    ]);

    // Process steps
    queryResults.set("tpc_HAS_STEP", [
      { processId: "proc-1", symbolId: "sym-1", symbolName: "foo", stepOrder: 0 },
      { processId: "proc-1", symbolId: "sym-2", symbolName: "bar", stepOrder: 1 },
    ]);
    queryResults.set("RETURN src.id AS sourceId", [
      { sourceId: "sym-1", sourceName: "foo", targetId: "ext:lodash", targetName: "lodash" },
    ]);

    const adapter = createMockGraphAdapter(queryResults);
    const result = await fetchAllGraphData(adapter, "tpc_");

    expect(result.symbols).toHaveLength(2);
    expect(result.symbols[0].name).toBe("foo");
    expect(result.symbols[1].name).toBe("bar");

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].name).toBe("core");

    expect(result.processes).toHaveLength(1);
    expect(result.processes[0].name).toBe("Main Flow");
    expect(result.externalDependencies).toHaveLength(1);
    expect(result.externalDependencies[0].name).toBe("lodash");

    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0].relType).toBe("CALLS");
    expect(result.relationships[0].sourceName).toBe("foo");

    expect(result.clusterMemberships.get("cl-1")).toEqual(["sym-1", "sym-2"]);

    const steps = result.processSteps.get("proc-1");
    expect(steps).toHaveLength(2);
    expect(steps![0].symbolName).toBe("foo");
    expect(steps![1].order).toBe(1);
    expect(result.dependsOnEdges).toEqual([
      expect.objectContaining({ relType: "DEPENDS_ON", targetName: "lodash" }),
    ]);
  });

  it("returns empty GraphData when no symbols exist", async () => {
    const queryResults = new Map<string, unknown[]>();
    queryResults.set("tpc_Symbol`) RETURN", []);

    const adapter = createMockGraphAdapter(queryResults);
    const result = await fetchAllGraphData(adapter, "tpc_");

    expect(result.symbols).toHaveLength(0);
    expect(result.clusters).toHaveLength(0);
    expect(result.processes).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
    expect(result.clusterMemberships.size).toBe(0);
    expect(result.processSteps.size).toBe(0);
    expect(result.externalDependencies).toEqual([]);
    expect(result.dependsOnEdges).toEqual([]);
  });
});
