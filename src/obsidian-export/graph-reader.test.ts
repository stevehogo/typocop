/**
 * Unit tests for GraphReader — fetchAllGraphData with mocked Neo4j session.
 * Requirements: 2.1–2.9
 */
import { describe, it, expect } from "vitest";
import { fetchAllGraphData } from "./graph-reader.js";

// --- Mock helpers ---

function createMockRecord(data: Record<string, unknown>) {
  return {
    get: (key: string) => data[key] ?? null,
  };
}

function createMockNodeRecord(key: string, properties: Record<string, unknown>) {
  return createMockRecord({ [key]: { properties } });
}

function createMockSession(queryResults: Map<string, unknown[]>) {
  return {
    executeRead: async (callback: (tx: { run: (query: string) => Promise<{ records: unknown[] }> }) => Promise<unknown>) => {
      const tx = {
        run: async (query: string) => {
          // Match most specific patterns first to avoid ambiguity
          for (const [pattern, records] of queryResults) {
            if (query.includes(pattern)) return { records };
          }
          return { records: [] };
        },
      };
      return callback(tx);
    },
  } as never;
}

// --- 8.1: fetchAllGraphData with populated graph ---

describe("fetchAllGraphData", () => {
  it("returns symbols, clusters, processes, relationships, memberships, and steps", async () => {
    const queryResults = new Map<string, unknown[]>();

    // Use prefixed patterns that uniquely match each Cypher query
    // Symbols: MATCH (s:`tpc_Symbol`) RETURN s
    queryResults.set("tpc_Symbol`) RETURN s", [
      createMockNodeRecord("s", {
        id: "sym-1", name: "foo", kind: "function",
        filePath: "src/a.ts", startLine: 1, endLine: 10,
        visibility: "public", signature: "foo()", documentation: "Does foo",
      }),
      createMockNodeRecord("s", {
        id: "sym-2", name: "bar", kind: "class",
        filePath: "src/b.ts", startLine: 5, endLine: 20,
        visibility: "private", signature: "class Bar", documentation: "",
      }),
    ]);

    // Clusters: MATCH (c:`tpc_Cluster`) RETURN c
    queryResults.set("tpc_Cluster`) RETURN c", [
      createMockNodeRecord("c", {
        id: "cl-1", name: "core", category: "utility",
        confidence: 0.85, symbolCount: 2,
      }),
    ]);

    // Processes: MATCH (p:`tpc_Process`) RETURN p
    queryResults.set("tpc_Process`) RETURN p", [
      createMockNodeRecord("p", {
        id: "proc-1", name: "Main Flow", entryPoint: "foo", stepCount: 2,
      }),
    ]);

    // Relationships use `tpc_CALLS`, `tpc_IMPORTS`, etc.
    queryResults.set("tpc_CALLS", [
      createMockRecord({ sourceId: "sym-1", sourceName: "foo", targetId: "sym-2", targetName: "bar" }),
    ]);
    queryResults.set("tpc_IMPORTS", []);
    queryResults.set("tpc_INHERITS", []);
    queryResults.set("tpc_IMPLEMENTS", []);

    // Cluster memberships: contains `tpc_CONTAINS`
    queryResults.set("tpc_CONTAINS", [
      createMockRecord({ clusterId: "cl-1", symbolId: "sym-1" }),
      createMockRecord({ clusterId: "cl-1", symbolId: "sym-2" }),
    ]);

    // Process steps: contains `tpc_HAS_STEP`
    queryResults.set("tpc_HAS_STEP", [
      createMockRecord({ processId: "proc-1", symbolId: "sym-1", symbolName: "foo", stepOrder: 0 }),
      createMockRecord({ processId: "proc-1", symbolId: "sym-2", symbolName: "bar", stepOrder: 1 }),
    ]);

    const session = createMockSession(queryResults);
    const result = await fetchAllGraphData(session, "tpc_");

    expect(result.symbols).toHaveLength(2);
    expect(result.symbols[0].name).toBe("foo");
    expect(result.symbols[1].name).toBe("bar");

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].name).toBe("core");

    expect(result.processes).toHaveLength(1);
    expect(result.processes[0].name).toBe("Main Flow");

    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0].relType).toBe("CALLS");
    expect(result.relationships[0].sourceName).toBe("foo");

    expect(result.clusterMemberships.get("cl-1")).toEqual(["sym-1", "sym-2"]);

    const steps = result.processSteps.get("proc-1");
    expect(steps).toHaveLength(2);
    expect(steps![0].symbolName).toBe("foo");
    expect(steps![1].order).toBe(1);
  });

  // --- 8.2: fetchAllGraphData with empty graph ---

  it("returns empty GraphData when no symbols exist", async () => {
    const queryResults = new Map<string, unknown[]>();
    queryResults.set("tpc_Symbol`) RETURN s", []);

    const session = createMockSession(queryResults);
    const result = await fetchAllGraphData(session, "tpc_");

    expect(result.symbols).toHaveLength(0);
    expect(result.clusters).toHaveLength(0);
    expect(result.processes).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
    expect(result.clusterMemberships.size).toBe(0);
    expect(result.processSteps.size).toBe(0);
  });
});
