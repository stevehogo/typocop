/**
 * Wave 8 · T4 — table-touch (findTableTouchers) tests.
 *
 * Query-aware mock GraphAdapter that branches on the READS_FROM_DB /
 * WRITES_TO_DB edge type in the query, returning the fixture data-access nodes
 * as `{ n, confidence, reason }` rows.
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { findTableTouchers } from "./table-touch.js";

interface ToucherFixture {
  id: string;
  name: string;
  confidence?: string;
  reason?: string;
}

function nodeRow(t: ToucherFixture) {
  return {
    n: {
      labels: ["Symbol"],
      properties: {
        id: t.id,
        name: t.name,
        kind: "function",
        filePath: `/repo/${t.id}.ts`,
        startLine: "3",
        startColumn: "0",
        endLine: "9",
        endColumn: "0",
        visibility: "public",
      },
    },
    confidence: t.confidence ?? null,
    reason: t.reason ?? null,
  };
}

function makeGraph(reads: ToucherFixture[], writes: ToucherFixture[]): GraphAdapter {
  const runCypher = async <T,>(query: string): Promise<T[]> => {
    if (query.includes("READS_FROM_DB")) return reads.map(nodeRow) as unknown as T[];
    if (query.includes("WRITES_TO_DB")) return writes.map(nodeRow) as unknown as T[];
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

describe("findTableTouchers", () => {
  it("lists readers via READS_FROM_DB with edge provenance", async () => {
    const graph = makeGraph(
      [{ id: "r1", name: "getUser", confidence: "0.85", reason: "prisma-findMany" }],
      [],
    );
    const result = await findTableTouchers(graph, "Users", "reads");
    expect(result.table).toBe("users"); // lower-cased
    expect(result.direction).toBe("reads");
    expect(result.touchers).toHaveLength(1);
    expect(result.touchers[0].symbol.name).toBe("getUser");
    expect(result.touchers[0].confidence).toBe(0.85);
    expect(result.touchers[0].reason).toBe("prisma-findMany");
  });

  it("lists writers via WRITES_TO_DB and ignores the readers fixture", async () => {
    const graph = makeGraph(
      [{ id: "r1", name: "getUser" }],
      [{ id: "w1", name: "saveUser", reason: "prisma-create" }],
    );
    const result = await findTableTouchers(graph, "users", "writes");
    expect(result.direction).toBe("writes");
    expect(result.touchers.map((t) => t.symbol.name)).toEqual(["saveUser"]);
  });

  it("degrades to an empty result when no touch edges exist", async () => {
    const graph = makeGraph([], []);
    const result = await findTableTouchers(graph, "orders", "reads");
    expect(result.touchers).toHaveLength(0);
    expect(result.totalFound).toBe(0);
  });

  it("caps at maxResults but reports totalFound", async () => {
    const graph = makeGraph(
      Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, name: `reader${i}` })),
      [],
    );
    const result = await findTableTouchers(graph, "users", "reads", { maxResults: 2 });
    expect(result.touchers).toHaveLength(2);
    expect(result.totalFound).toBe(4);
  });
});
