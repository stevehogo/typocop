/**
 * D6 — dead-code detection tests.
 *
 * Uses a query-aware mock GraphAdapter that answers the single query shape
 * findDeadCode issues:
 *   MATCH (s:Symbol) WHERE NOT (s)<-[:CALLS]-() RETURN s AS n
 *
 * The fixture supplies the set of UNCALLED symbol nodes (those with no incoming
 * CALLS edge); the mock returns them as `{ n: {...} }` rows.
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { findDeadCode } from "./dead-code.js";
import type { Visibility, SymbolKind, EntryPointKind } from "../../core/domain.js";

interface FixtureNode {
  id: string;
  name: string;
  kind?: SymbolKind;
  visibility?: Visibility;
  /** Persisted Wave 2 export flag ("true"/"false"); omit for pre-Wave-2 graphs. */
  isExported?: "true" | "false";
  /** Persisted Wave 2 entry-point classification; omit for non-entry-points. */
  entryPointKind?: EntryPointKind;
  /** Persisted Wave 2 entry-point explainability trail. */
  entryPointReason?: string;
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
          ...(n.isExported !== undefined ? { isExported: n.isExported } : {}),
          ...(n.entryPointKind !== undefined ? { entryPointKind: n.entryPointKind } : {}),
          ...(n.entryPointReason !== undefined ? { entryPointReason: n.entryPointReason } : {}),
        },
      },
    };
  }

  const runCypher = async <T,>(query: string): Promise<T[]> => {
    if (query.includes("NOT (s)<-[:CALLS]-()")) {
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

  // ── Wave 8 (T1): real persisted fields with pre-Wave-2 fallback ───────────
  it("excludes an uncalled symbol via the REAL persisted isExported field (private visibility)", async () => {
    // visibility is private (the old proxy would flag it dead) but the
    // language-level export flag is true → not dead.
    const graph = makeGraph([
      { id: "x1", name: "publicApiThing", kind: "function", visibility: "private", isExported: "true" },
    ]);
    const result = await findDeadCode(graph);
    expect(result.candidates).toHaveLength(0);
  });

  it("flags a symbol whose persisted isExported is explicitly false (overrides public visibility)", async () => {
    // visibility public (old proxy would KEEP it) but the language export flag
    // is false → not part of the public surface → dead candidate.
    const graph = makeGraph([
      { id: "x2", name: "internalHelper", kind: "function", visibility: "public", isExported: "false" },
    ]);
    const result = await findDeadCode(graph);
    expect(result.candidates.map((c) => c.symbol.name)).toEqual(["internalHelper"]);
  });

  it("excludes an entry point via persisted entryPointKind even when its NAME is not entry-point-shaped", async () => {
    // "renderWidget" does NOT match the entry-point name regex; only the
    // persisted entryPointKind keeps it out.
    const graph = makeGraph([
      {
        id: "ep1",
        name: "renderWidget",
        kind: "function",
        visibility: "private",
        entryPointKind: "route",
        entryPointReason: "base:2.00, framework:nextjs-api-route",
      },
    ]);
    const result = await findDeadCode(graph);
    expect(result.candidates).toHaveLength(0);
    expect(result.keptEntryPoints).toHaveLength(1);
    expect(result.keptEntryPoints[0]).toMatchObject({
      name: "renderWidget",
      entryPointKind: "route",
      entryPointReason: "base:2.00, framework:nextjs-api-route",
    });
  });

  it("still excludes entry-point-NAMED symbols on a pre-Wave-2 graph (regex fallback, no persisted reason)", async () => {
    const graph = makeGraph([
      { id: "m1", name: "main", kind: "function", visibility: "private" },
    ]);
    const result = await findDeadCode(graph);
    expect(result.candidates).toHaveLength(0);
    // No entryPointKind persisted → not surfaced in the "kept because" list.
    expect(result.keptEntryPoints).toHaveLength(0);
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
