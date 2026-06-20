/**
 * D6 — dead-code detection tests.
 *
 * Uses a query-aware mock GraphAdapter that answers the single query shape
 * findDeadCode issues:
 *   MATCH (s:Symbol) WHERE NOT EXISTS { (s)<-[:CALLS]-() } RETURN s AS n
 *
 * The fixture supplies the set of UNCALLED symbol nodes (those with no incoming
 * CALLS edge); the mock returns them as `{ n: {...} }` rows.
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { findDeadCode } from "./dead-code.js";
import type { Visibility, SymbolKind } from "../../core/domain.js";

interface FixtureNode {
  id: string;
  name: string;
  kind?: SymbolKind;
  visibility?: Visibility;
}

/** Build a mock GraphAdapter whose dead-code query returns `uncalled`. */
function makeGraph(uncalled: FixtureNode[]): GraphAdapter {
  function nodeRow(n: FixtureNode) {
    return {
      n: {
        labels: ["Symbol"],
        properties: {
          id: n.id,
          name: n.name,
          kind: n.kind ?? "function",
          filePath: `/repo/${n.id}.ts`,
          startLine: "1",
          startColumn: "0",
          endLine: "9",
          endColumn: "0",
          visibility: n.visibility ?? "private",
        },
      },
    };
  }

  const runCypher = async <T,>(query: string): Promise<T[]> => {
    if (query.includes("NOT EXISTS { (s)<-[:CALLS]-() }")) {
      return uncalled.map(nodeRow) as unknown as T[];
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

describe("findDeadCode", () => {
  it("flags an uncalled, private, utility-named symbol", async () => {
    const graph = makeGraph([
      { id: "u1", name: "formatLabel", kind: "function", visibility: "private" },
    ]);
    const result = await findDeadCode(graph);
    expect(result.candidates.map((c) => c.symbol.name)).toEqual(["formatLabel"]);
    expect(result.totalFound).toBe(1);
  });

  it("excludes an exported (public) uncalled symbol", async () => {
    const graph = makeGraph([
      { id: "e1", name: "computeThing", kind: "function", visibility: "public" },
    ]);
    const result = await findDeadCode(graph);
    expect(result.candidates).toHaveLength(0);
    expect(result.totalFound).toBe(0);
  });

  it("excludes a symbol of kind 'export' even if private visibility", async () => {
    const graph = makeGraph([
      { id: "ex1", name: "reExported", kind: "export", visibility: "private" },
    ]);
    const result = await findDeadCode(graph);
    expect(result.candidates).toHaveLength(0);
  });

  it("excludes entry-point-named uncalled symbols (main, handler)", async () => {
    const graph = makeGraph([
      { id: "m1", name: "main", kind: "function", visibility: "private" },
      { id: "h1", name: "requestHandler", kind: "function", visibility: "private" },
      { id: "h2", name: "handleClick", kind: "function", visibility: "private" },
    ]);
    const result = await findDeadCode(graph);
    expect(result.candidates).toHaveLength(0);
  });

  it("applies the kind filter", async () => {
    const graph = makeGraph([
      { id: "f1", name: "scratchFn", kind: "function", visibility: "private" },
      { id: "v1", name: "scratchVar", kind: "variable", visibility: "private" },
    ]);
    const onlyFns = await findDeadCode(graph, { kind: "function" });
    expect(onlyFns.candidates.map((c) => c.symbol.name)).toEqual(["scratchFn"]);

    const onlyVars = await findDeadCode(graph, { kind: "variable" });
    expect(onlyVars.candidates.map((c) => c.symbol.name)).toEqual(["scratchVar"]);
  });

  it("caps results at maxResults but reports totalFound", async () => {
    const graph = makeGraph(
      Array.from({ length: 5 }, (_, i) => ({
        id: `d${i}`,
        name: `deadThing${i}`,
        kind: "function" as SymbolKind,
        visibility: "private" as Visibility,
      })),
    );
    const result = await findDeadCode(graph, { maxResults: 2 });
    expect(result.candidates).toHaveLength(2);
    expect(result.totalFound).toBe(5);
  });
});
