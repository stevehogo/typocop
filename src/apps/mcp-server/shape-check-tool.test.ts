/**
 * shape_check tool — two modes via the optional `route`:
 *   - no route → graph-wide contract drift (consumer reads a key no route returns)
 *   - route    → that route's blast radius (impact) + the drift surface (former api_impact)
 *
 * Query-aware mock answers: loadRoutes (responseKeys), loadConsumers
 * (accessedKeys), and the impact exact-match resolve for the route symbol.
 */
import { describe, it, expect } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executeShapeCheck } from "./shape-check-tool.js";

function routeRow() {
  return {
    n: {
      labels: ["Symbol"],
      properties: {
        id: "getUser", name: "getUser", kind: "function",
        filePath: "/repo/routes.ts", startLine: "1", startColumn: "0",
        endLine: "5", endColumn: "0", visibility: "public",
        responseKeys: JSON.stringify(["id", "name"]),
      },
    },
  };
}
function consumerRow() {
  return {
    n: {
      labels: ["Symbol"],
      properties: {
        id: "UserCard", name: "UserCard", kind: "function",
        filePath: "/repo/UserCard.ts", startLine: "1", startColumn: "0",
        endLine: "5", endColumn: "0", visibility: "public",
        accessedKeys: JSON.stringify(["id", "email"]), // reads 'email' — no route returns it
      },
    },
  };
}

function makeGraph(): GraphAdapter {
  const runCypher = async <T,>(query: string, params?: Record<string, unknown>): Promise<T[]> => {
    if (query.includes("s.responseKeys IS NOT NULL")) return [routeRow()] as unknown as T[];
    if (query.includes("s.accessedKeys IS NOT NULL")) return [consumerRow()] as unknown as T[];
    // impact exact-match resolve for the route symbol
    if (query.includes("WHERE n.id = $val") && query.includes("LIMIT 1")) {
      return (params?.["val"] === "getUser" ? [routeRow()] : []) as unknown as T[];
    }
    return [] as T[];
  };
  return {
    createNode: async () => {},
    createRelationship: async () => {},
    queryNodes: async () => [],
    queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0,
    deleteRelationshipsByType: async () => 0,
    runCypher: runCypher as GraphAdapter["runCypher"],
    runCypherWrite: async () => {},
  };
}

function makeAdapter(): DatabaseAdapter {
  const graph = makeGraph();
  return {
    initialize: async () => {},
    close: async () => {},
    getGraphAdapter: () => graph,
    getVectorAdapter: () => { throw new Error("not used"); },
    getEmbeddingAdapter: () => { throw new Error("not used"); },
  } as unknown as DatabaseAdapter;
}

describe("shape_check tool", () => {
  it("no route → graph-wide drift: flags the key no route returns", async () => {
    const res = await executeShapeCheck({}, makeAdapter());
    expect(res.summary).toMatch(/contract/i);
    const keys = (res.shapeCheck?.mismatches ?? []).map((m) => m.key);
    expect(keys).toContain("email");
    expect(keys).not.toContain("id"); // 'id' IS returned by the route
  });

  it("route → scoped: blast radius summary + drift still populated (former api_impact)", async () => {
    const res = await executeShapeCheck({ route: "getUser" }, makeAdapter());
    expect(res.summary).toMatch(/API impact for route 'getUser'/);
    // the route symbol resolved into the impact result
    expect(res.symbols.some((s) => s.name === "getUser")).toBe(true);
    // the drift surface rides along
    expect(res.shapeCheck).toBeDefined();
    expect((res.shapeCheck?.mismatches ?? []).map((m) => m.key)).toContain("email");
  });

  it("blank route string is treated as no-route (graph-wide)", async () => {
    const res = await executeShapeCheck({ route: "   " }, makeAdapter());
    expect(res.summary).toMatch(/contract/i);
  });
});
