/**
 * Phase 4 clustering — property tests and unit tests.
 *
 * Properties:
 *   4: Cluster Confidence Bounds  — confidence in [0.0, 1.0]  (Req 6.2)
 *   5: Cluster Minimum Size       — at least 2 symbols         (Req 6.4)
 *   6: Cluster Symbol Validity    — all symbol IDs exist        (Req 6.5)
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { clusterArbitrary, symbolArbitrary } from "../../types/arbitraries.js";
import type { Symbol, Relationship } from "../../core/domain.js";
import { buildClusterGraph, calculateCohesion } from "./graph.js";
import { louvainClustering } from "./louvain.js";
import { classifyCluster } from "./enrichment.js";
import { clusterSymbols } from "./index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSymbol(
  id: string,
  name: string,
  kind: Symbol["kind"] = "function",
  filePath = "src/foo.ts",
): Symbol {
  return {
    id,
    name,
    kind,
    location: {
      filePath,
      startLine: 1,
      startColumn: 0,
      endLine: 5,
      endColumn: 0,
    },
    visibility: "public",
    modifiers: [],
  };
}

function makeRel(
  source: string,
  target: string,
  relType: Relationship["relType"] = "calls",
): Relationship {
  return {
    id: `${relType}:${source}->${target}`,
    source,
    target,
    relType,
    metadata: {},
  };
}

// ─── Property 4: Cluster Confidence Bounds ────────────────────────────────────

describe("Property 4: Cluster Confidence Bounds", () => {
  it("confidence is always in [0.0, 1.0] for arbitrary clusters", () => {
    fc.assert(
      fc.property(clusterArbitrary(), (cluster) => {
        expect(cluster.confidence).toBeGreaterThanOrEqual(0.0);
        expect(cluster.confidence).toBeLessThanOrEqual(1.0);
      }),
    );
  });

  it("clusterSymbols produces confidence in [0.0, 1.0]", async () => {
    const symbols = [
      makeSymbol("a", "foo"),
      makeSymbol("b", "bar"),
      makeSymbol("c", "baz"),
    ];
    const rels = [makeRel("a", "b"), makeRel("b", "c"), makeRel("a", "c")];
    const clusters = await clusterSymbols(symbols, rels);
    for (const c of clusters) {
      expect(c.confidence).toBeGreaterThanOrEqual(0.0);
      expect(c.confidence).toBeLessThanOrEqual(1.0);
    }
  });
});

// ─── Property 5: Cluster Minimum Size ────────────────────────────────────────

describe("Property 5: Cluster Minimum Size", () => {
  it("arbitrary cluster has at least 2 symbols", () => {
    fc.assert(
      fc.property(clusterArbitrary(), (cluster) => {
        expect(cluster.symbols.length).toBeGreaterThanOrEqual(2);
      }),
    );
  });

  it("clusterSymbols never returns a cluster with fewer than 2 symbols", async () => {
    const symbols = [
      makeSymbol("a", "foo"),
      makeSymbol("b", "bar"),
      makeSymbol("c", "baz"),
      makeSymbol("d", "qux"),
    ];
    const rels = [
      makeRel("a", "b"),
      makeRel("b", "c"),
      makeRel("c", "d"),
      makeRel("a", "d"),
    ];
    const clusters = await clusterSymbols(symbols, rels);
    for (const c of clusters) {
      expect(c.symbols.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ─── Property 6: Cluster Symbol Validity ─────────────────────────────────────

describe("Property 6: Cluster Symbol Validity", () => {
  it("all symbol IDs in clusters exist in the input symbol set", async () => {
    // Use fast-check to generate symbol sets and verify cluster membership
    await fc.assert(
      fc.asyncProperty(
        fc.array(symbolArbitrary(), { minLength: 4, maxLength: 20 }).map(
          (syms) => {
            // Deduplicate IDs
            const seen = new Set<string>();
            return syms.filter((s) => {
              if (seen.has(s.id)) return false;
              seen.add(s.id);
              return true;
            });
          },
        ),
        async (symbols) => {
          if (symbols.length < 2) return;
          // Build relationships between consecutive symbols
          const rels: Relationship[] = [];
          for (let i = 0; i < symbols.length - 1; i++) {
            rels.push(makeRel(symbols[i].id, symbols[i + 1].id));
          }
          const symbolIds = new Set(symbols.map((s) => s.id));
          const clusters = await clusterSymbols(symbols, rels);
          for (const cluster of clusters) {
            for (const symId of cluster.symbols) {
              expect(symbolIds.has(symId)).toBe(true);
            }
          }
        },
      ),
    );
  });
});

// ─── Unit tests: buildClusterGraph ───────────────────────────────────────────

describe("buildClusterGraph", () => {
  it("only includes calls/inherits/implements edges", () => {
    const symbols = [makeSymbol("a", "A", "class"), makeSymbol("b", "B", "class")];
    const rels: Relationship[] = [
      makeRel("a", "b", "calls"),
      makeRel("a", "b", "imports"), // should be excluded
    ];
    const graph = buildClusterGraph(symbols, rels);
    expect(graph.edgeCount).toBe(1);
    expect(graph.adjacency.get("a")?.has("b")).toBe(true);
  });

  it("excludes self-loops", () => {
    const symbols = [makeSymbol("a", "A", "function")];
    const rels = [makeRel("a", "a", "calls")];
    const graph = buildClusterGraph(symbols, rels);
    expect(graph.edgeCount).toBe(0);
  });

  it("builds undirected edges (both directions)", () => {
    const symbols = [makeSymbol("a", "A", "function"), makeSymbol("b", "B", "function")];
    const rels = [makeRel("a", "b", "calls")];
    const graph = buildClusterGraph(symbols, rels);
    expect(graph.adjacency.get("a")?.has("b")).toBe(true);
    expect(graph.adjacency.get("b")?.has("a")).toBe(true);
  });

  it("deduplicates parallel edges", () => {
    const symbols = [makeSymbol("a", "A", "function"), makeSymbol("b", "B", "function")];
    const rels = [makeRel("a", "b", "calls"), makeRel("b", "a", "calls")];
    const graph = buildClusterGraph(symbols, rels);
    expect(graph.edgeCount).toBe(1);
  });
});

// ─── Unit tests: calculateCohesion ───────────────────────────────────────────

describe("calculateCohesion", () => {
  it("returns 1.0 for a single-member community", () => {
    const adj = new Map([["a", new Set(["b"])]]);
    expect(calculateCohesion(["a"], adj)).toBe(1.0);
  });

  it("returns 1.0 when all edges are internal", () => {
    const adj = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["a"])],
    ]);
    expect(calculateCohesion(["a", "b"], adj)).toBe(1.0);
  });

  it("returns < 1.0 when some edges are external", () => {
    const adj = new Map([
      ["a", new Set(["b", "c"])],
      ["b", new Set(["a"])],
    ]);
    // a has 2 edges: 1 internal (b), 1 external (c)
    const cohesion = calculateCohesion(["a", "b"], adj);
    expect(cohesion).toBeLessThan(1.0);
    expect(cohesion).toBeGreaterThanOrEqual(0.0);
  });
});

// ─── Unit tests: louvainClustering ───────────────────────────────────────────

describe("louvainClustering", () => {
  it("returns empty array for empty graph", () => {
    const graph = buildClusterGraph([], []);
    expect(louvainClustering(graph)).toEqual([]);
  });

  it("returns empty array when no edges exist", () => {
    const symbols = [makeSymbol("a", "A", "function"), makeSymbol("b", "B", "function")];
    const graph = buildClusterGraph(symbols, []);
    expect(louvainClustering(graph)).toEqual([]);
  });

  it("groups connected nodes into communities with >= 2 members each", () => {
    // Two tight triangles: {a,b,c} and {d,e,f}
    const symbols = [
      makeSymbol("a", "A", "function"),
      makeSymbol("b", "B", "function"),
      makeSymbol("c", "C", "function"),
      makeSymbol("d", "D", "function"),
      makeSymbol("e", "E", "function"),
      makeSymbol("f", "F", "function"),
    ];
    const rels: Relationship[] = [
      makeRel("a", "b"), makeRel("b", "c"), makeRel("a", "c"),
      makeRel("d", "e"), makeRel("e", "f"), makeRel("d", "f"),
    ];
    const graph = buildClusterGraph(symbols, rels);
    const communities = louvainClustering(graph);
    // Every community must have >= 2 members (no singletons)
    for (const c of communities) {
      expect(c.members.length).toBeGreaterThanOrEqual(2);
    }
    // All 6 nodes must appear across all communities (no node is dropped)
    const allMembers = new Set(communities.flatMap((c) => c.members));
    expect(allMembers.size).toBe(6);
  });

  it("modularity is in [0.0, 1.0]", () => {
    const symbols = [
      makeSymbol("a", "A", "function"),
      makeSymbol("b", "B", "function"),
      makeSymbol("c", "C", "function"),
    ];
    const rels = [makeRel("a", "b"), makeRel("b", "c")];
    const graph = buildClusterGraph(symbols, rels);
    const communities = louvainClustering(graph);
    for (const c of communities) {
      expect(c.modularity).toBeGreaterThanOrEqual(0.0);
      expect(c.modularity).toBeLessThanOrEqual(1.0);
    }
  });
});

// ─── Unit tests: classifyCluster ─────────────────────────────────────────────

describe("classifyCluster", () => {
  it("classifies auth-related symbols as authentication", () => {
    const symbols = [
      makeSymbol("a", "loginUser"),
      makeSymbol("b", "validateToken"),
    ];
    const symbolMap = new Map(symbols.map((s) => [s.id, s]));
    expect(classifyCluster(["a", "b"], symbolMap)).toBe("authentication");
  });

  it("classifies repository symbols as dataAccess", () => {
    const symbols = [
      makeSymbol("a", "UserRepository"),
      makeSymbol("b", "findByEmail"),
    ];
    const symbolMap = new Map(symbols.map((s) => [s.id, s]));
    expect(classifyCluster(["a", "b"], symbolMap)).toBe("dataAccess");
  });

  it("returns unknown for unrecognised symbols", () => {
    const symbols = [makeSymbol("a", "xyzAbc"), makeSymbol("b", "qwerty")];
    const symbolMap = new Map(symbols.map((s) => [s.id, s]));
    expect(classifyCluster(["a", "b"], symbolMap)).toBe("unknown");
  });
});

// ─── Unit tests: clusterSymbols (integration) ─────────────────────────────────

describe("clusterSymbols", () => {
  it("returns empty array when no relationships exist", async () => {
    const symbols = [makeSymbol("a", "A"), makeSymbol("b", "B")];
    const clusters = await clusterSymbols(symbols, []);
    expect(clusters).toEqual([]);
  });

  it("returns clusters with valid structure", async () => {
    const symbols = [
      makeSymbol("a", "loginUser", "function"),
      makeSymbol("b", "validateToken", "function"),
      makeSymbol("c", "UserRepository", "class"),
    ];
    const rels = [makeRel("a", "b"), makeRel("b", "c")];
    const clusters = await clusterSymbols(symbols, rels);
    for (const c of clusters) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.symbols.length).toBeGreaterThanOrEqual(2);
      expect(c.confidence).toBeGreaterThanOrEqual(0.0);
      expect(c.confidence).toBeLessThanOrEqual(1.0);
    }
  });
});
