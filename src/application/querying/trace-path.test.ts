/**
 * D3 — trace shortest-path tests.
 *
 * Uses a small in-memory graph fixture and a query-aware mock GraphAdapter that
 * answers the four query shapes executeTracePath issues:
 *   - exact resolve:   MATCH (n:Symbol) WHERE n.id = $val OR n.name = $val ... LIMIT 1
 *   - fuzzy resolve:   MATCH (n:Symbol) WHERE n.name CONTAINS $val
 *   - neighbour expand: MATCH (n:Symbol)-[e:CALLS|CONTAINS]->(m:Symbol) WHERE n.id = $val
 *   - node hydrate:    MATCH (n:Symbol) WHERE n.id = $val RETURN n LIMIT 1
 *   - suggestions:     MATCH (n:Symbol) RETURN DISTINCT n.name AS name LIMIT 1000
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { executeTracePath, clampTraceDepth } from "./trace-path.js";
import { MAX_TRAVERSAL_DEPTH } from "../../platform/utils/limits.js";

interface FixtureNode {
  id: string;
  name?: string;
  filePath?: string;
  startLine?: number;
}
interface FixtureEdge {
  from: string;
  to: string;
  type: string; // CALLS | CONTAINS | other
}

function makeGraph(nodes: FixtureNode[], edges: FixtureEdge[]): GraphAdapter {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  function nodeRow(n: FixtureNode) {
    return {
      n: {
        labels: ["Symbol"],
        properties: {
          id: n.id,
          name: n.name ?? n.id,
          kind: "function",
          filePath: n.filePath ?? `/repo/${n.id}.ts`,
          startLine: String(n.startLine ?? 1),
          startColumn: "0",
          endLine: "9",
          endColumn: "0",
          visibility: "public",
        },
      },
    };
  }

  const runCypher = async <T,>(query: string, params?: Record<string, unknown>): Promise<T[]> => {
    const val = params?.["val"] as string | undefined;

    // Neighbour expansion (CALLS|CONTAINS, directed out).
    if (query.includes("-[e:CALLS|CONTAINS]->")) {
      const out = edges
        .filter((e) => e.from === val && (e.type === "CALLS" || e.type === "CONTAINS"))
        .map((e) => ({ neighbourId: e.to, edgeType: e.type }));
      return out as unknown as T[];
    }

    // Exact resolve / node hydrate (both `n.id = $val ...` with LIMIT 1).
    if (query.includes("WHERE n.id = $val") && query.includes("LIMIT 1")) {
      const node = val ? byId.get(val) : undefined;
      // also match by name for the resolver's exact step
      const byName = !node && val ? nodes.find((n) => (n.name ?? n.id) === val) : undefined;
      const hit = node ?? byName;
      return (hit ? [nodeRow(hit)] : []) as unknown as T[];
    }

    // Fuzzy resolve — CONTAINS on name.
    if (query.includes("n.name CONTAINS $val")) {
      const matches = nodes.filter((n) => (n.name ?? n.id).includes(val ?? ""));
      return matches.map(nodeRow) as unknown as T[];
    }

    // Suggestions.
    if (query.includes("RETURN DISTINCT n.name AS name")) {
      return nodes.map((n) => ({ name: n.name ?? n.id })) as unknown as T[];
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

describe("executeTracePath — clampTraceDepth", () => {
  it("defaults to MAX_TRAVERSAL_DEPTH for undefined/invalid", () => {
    expect(clampTraceDepth(undefined)).toBe(MAX_TRAVERSAL_DEPTH);
    expect(clampTraceDepth(0)).toBe(MAX_TRAVERSAL_DEPTH);
    expect(clampTraceDepth(-3)).toBe(MAX_TRAVERSAL_DEPTH);
    expect(clampTraceDepth(NaN)).toBe(MAX_TRAVERSAL_DEPTH);
  });
  it("clamps above MAX and floors fractional", () => {
    expect(clampTraceDepth(1000)).toBe(MAX_TRAVERSAL_DEPTH);
    expect(clampTraceDepth(2.9)).toBe(2);
    expect(clampTraceDepth(5)).toBe(5);
  });
});

describe("executeTracePath", () => {
  it("finds a direct (1-hop) path with edge type and file:line", async () => {
    const graph = makeGraph(
      [
        { id: "a", filePath: "/repo/a.ts", startLine: 10 },
        { id: "b", filePath: "/repo/b.ts", startLine: 20 },
      ],
      [{ from: "a", to: "b", type: "CALLS" }],
    );

    const res = await executeTracePath("a", "b", undefined, graph);

    expect(res.found).toBe(true);
    expect(res.length).toBe(1);
    expect(res.hops.map((h) => h.symbolId)).toEqual(["a", "b"]);
    expect(res.hops[0].edgeToNext).toBe("calls");
    expect(res.hops[1].edgeToNext).toBeUndefined();
    expect(res.hops[0].filePath).toBe("/repo/a.ts");
    expect(res.hops[0].startLine).toBe(10);
    expect(res.hops[1].startLine).toBe(20);
  });

  it("finds a transitive multi-hop path and reports the shortest one", async () => {
    // a -> b -> c -> d  (chain), plus a long detour a -> x -> y -> ... that is longer.
    const graph = makeGraph(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      [
        { from: "a", to: "b", type: "CALLS" },
        { from: "b", to: "c", type: "CONTAINS" },
        { from: "c", to: "d", type: "CALLS" },
      ],
    );

    const res = await executeTracePath("a", "d", undefined, graph);

    expect(res.found).toBe(true);
    expect(res.length).toBe(3);
    expect(res.hops.map((h) => h.symbolId)).toEqual(["a", "b", "c", "d"]);
    expect(res.hops.map((h) => h.edgeToNext)).toEqual(["calls", "contains", "calls", undefined]);
  });

  it("picks the SHORTEST path when multiple exist", async () => {
    // a -> b -> d (2 hops) and a -> c1 -> c2 -> d (3 hops). BFS must pick a->b->d.
    const graph = makeGraph(
      [{ id: "a" }, { id: "b" }, { id: "c1" }, { id: "c2" }, { id: "d" }],
      [
        { from: "a", to: "b", type: "CALLS" },
        { from: "b", to: "d", type: "CALLS" },
        { from: "a", to: "c1", type: "CALLS" },
        { from: "c1", to: "c2", type: "CALLS" },
        { from: "c2", to: "d", type: "CALLS" },
      ],
    );

    const res = await executeTracePath("a", "d", undefined, graph);
    expect(res.found).toBe(true);
    expect(res.length).toBe(2);
    expect(res.hops.map((h) => h.symbolId)).toEqual(["a", "b", "d"]);
  });

  it("returns found:false when there is no CALLS/CONTAINS path", async () => {
    // a and b are connected only by a non-traversed edge type (IMPORTS).
    const graph = makeGraph(
      [{ id: "a" }, { id: "b" }],
      [{ from: "a", to: "b", type: "IMPORTS" }],
    );

    const res = await executeTracePath("a", "b", undefined, graph);
    expect(res.found).toBe(false);
    expect(res.hops).toEqual([]);
    expect(res.length).toBe(0);
    // endpoints still resolved
    expect(res.resolution.from.kind).toBe("exact");
    expect(res.resolution.to.kind).toBe("exact");
  });

  it("returns found:false when an endpoint cannot be resolved", async () => {
    const graph = makeGraph([{ id: "a" }], []);
    const res = await executeTracePath("a", "ghost", undefined, graph);
    expect(res.found).toBe(false);
    expect(res.resolution.from.kind).toBe("exact");
    expect(res.resolution.to.kind).toBe("not_found");
  });

  it("maxDepth clamps the search: a path longer than maxDepth is not found", async () => {
    // a -> b -> c -> d  (3 hops). With maxDepth=2, d is unreachable.
    const graph = makeGraph(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      [
        { from: "a", to: "b", type: "CALLS" },
        { from: "b", to: "c", type: "CALLS" },
        { from: "c", to: "d", type: "CALLS" },
      ],
    );

    const shallow = await executeTracePath("a", "d", 2, graph);
    expect(shallow.found).toBe(false);

    // With enough depth it IS found.
    const deep = await executeTracePath("a", "d", 3, graph);
    expect(deep.found).toBe(true);
    expect(deep.length).toBe(3);
  });

  it("handles a cycle without looping forever", async () => {
    // a -> b -> a (cycle); target c is unreachable.
    const graph = makeGraph(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { from: "a", to: "b", type: "CALLS" },
        { from: "b", to: "a", type: "CALLS" },
      ],
    );
    const res = await executeTracePath("a", "c", undefined, graph);
    expect(res.found).toBe(false);
  });

  it("returns a single-node path when from === to (length 0)", async () => {
    const graph = makeGraph([{ id: "a" }], []);
    const res = await executeTracePath("a", "a", undefined, graph);
    expect(res.found).toBe(true);
    expect(res.length).toBe(0);
    expect(res.hops.map((h) => h.symbolId)).toEqual(["a"]);
  });
});
