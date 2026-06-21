/**
 * E2 — complexity hotspots query tests.
 *
 * Uses a query-aware mock GraphAdapter that emulates the single Cypher shape
 * findHotspots issues:
 *   MATCH (s:Symbol) WHERE CAST(s.cyclomatic AS INT64) > $min
 *   RETURN s AS n ORDER BY CAST(s.cyclomatic AS INT64) DESC, s.id ASC
 *   SKIP $skip LIMIT $limit
 *
 * The mock applies the $min/$skip/$limit params + DESC ordering over a fixture,
 * so the test exercises threshold filtering, ordering, paging, and metric
 * mapping without a real graph.
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { findHotspots } from "./hotspots.js";

interface FixtureNode {
  id: string;
  name: string;
  cyclomatic: number;
  cognitive?: number;
  maxLoopDepth?: number;
}

function makeGraph(symbols: FixtureNode[]): GraphAdapter {
  const nodeRow = (n: FixtureNode) => ({
    n: {
      labels: ["Symbol"],
      properties: {
        id: n.id,
        name: n.name,
        kind: "function",
        filePath: `/repo/${n.id}.ts`,
        startLine: "1",
        startColumn: "0",
        endLine: "9",
        endColumn: "0",
        visibility: "public",
        cyclomatic: String(n.cyclomatic),
        cognitive: String(n.cognitive ?? n.cyclomatic),
        maxLoopDepth: String(n.maxLoopDepth ?? 0),
      },
    },
  });

  const runCypher = async <T,>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<T[]> => {
    if (!query.includes("CAST(s.cyclomatic AS INT64) > $min")) return [] as T[];
    const min = (params?.min as number) ?? 0;
    const skip = (params?.skip as number) ?? 0;
    const limit = (params?.limit as number) ?? Number.MAX_SAFE_INTEGER;
    const ordered = symbols
      .filter((s) => s.cyclomatic > min)
      .sort((a, b) => (b.cyclomatic - a.cyclomatic) || a.id.localeCompare(b.id))
      .slice(skip, skip + limit);
    return ordered.map(nodeRow) as unknown as T[];
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

const FIXTURE: FixtureNode[] = [
  { id: "a", name: "low", cyclomatic: 3 },
  { id: "b", name: "mid", cyclomatic: 12, cognitive: 20, maxLoopDepth: 2 },
  { id: "c", name: "high", cyclomatic: 25, cognitive: 40, maxLoopDepth: 3 },
  { id: "d", name: "alsoMid", cyclomatic: 12 },
];

describe("findHotspots", () => {
  it("filters by minComplexity (default 10) and orders DESC", async () => {
    const graph = makeGraph(FIXTURE);
    const { hotspots } = await findHotspots(graph);
    // c(25) > b(12,id"b") > d(12,id"d"); 'low' (3) is below the default of 10.
    expect(hotspots.map((h) => h.symbol.name)).toEqual(["high", "mid", "alsoMid"]);
  });

  it("surfaces all three metrics per hotspot", async () => {
    const graph = makeGraph(FIXTURE);
    const { hotspots } = await findHotspots(graph, { minComplexity: 20 });
    expect(hotspots).toHaveLength(1);
    expect(hotspots[0]).toMatchObject({
      cyclomatic: 25,
      cognitive: 40,
      maxLoopDepth: 3,
    });
    expect(hotspots[0]!.symbol.name).toBe("high");
  });

  it("honours a custom minComplexity", async () => {
    const graph = makeGraph(FIXTURE);
    const { hotspots } = await findHotspots(graph, { minComplexity: 0 });
    expect(hotspots.map((h) => h.cyclomatic)).toEqual([25, 12, 12, 3]);
  });

  it("pages with maxResults + offset", async () => {
    const graph = makeGraph(FIXTURE);
    const page1 = await findHotspots(graph, { minComplexity: 0, maxResults: 2, offset: 0 });
    const page2 = await findHotspots(graph, { minComplexity: 0, maxResults: 2, offset: 2 });
    expect(page1.hotspots.map((h) => h.symbol.name)).toEqual(["high", "mid"]);
    expect(page2.hotspots.map((h) => h.symbol.name)).toEqual(["alsoMid", "low"]);
  });

  it("returns empty when nothing exceeds the threshold", async () => {
    const graph = makeGraph(FIXTURE);
    const { hotspots } = await findHotspots(graph, { minComplexity: 100 });
    expect(hotspots).toEqual([]);
  });
});
