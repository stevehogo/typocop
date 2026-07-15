/**
 * Task 3 — usage/dead-code verifier.
 *
 * Query-aware mock GraphAdapter answering the shapes verifyUsage issues:
 *   - exact resolve:    MATCH (n:Symbol) WHERE n.id = $val OR n.name = $val ... LIMIT 1
 *   - fuzzy resolve:    MATCH (n:Symbol) WHERE n.name CONTAINS $val
 *   - suggestions:      MATCH (n:Symbol) RETURN DISTINCT n.name AS name LIMIT 1000
 *   - incoming callers: MATCH (caller:Symbol)-[:CALLS]->(t:Symbol) WHERE t.id = $val ...
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { verifyUsage } from "./verify-usage.js";

interface FixtureNode {
  id: string;
  name?: string;
  kind?: string;
  visibility?: string;
  /** Persisted Wave 2 export flag ("true"/"false"); omit for pre-Wave-2 graphs. */
  isExported?: "true" | "false";
  /** Persisted Wave 2 entry-point classification; omit for non-entry-points. */
  entryPointKind?: string;
}

function makeGraph(nodes: FixtureNode[], callsEdges: Array<{ from: string; to: string }>): GraphAdapter {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  function nodeRow(n: FixtureNode) {
    return {
      n: {
        labels: ["Symbol"],
        properties: {
          id: n.id,
          name: n.name ?? n.id,
          kind: n.kind ?? "function",
          filePath: `/repo/${n.id}.ts`,
          startLine: "1",
          startColumn: "0",
          endLine: "9",
          endColumn: "0",
          visibility: n.visibility ?? "private",
          ...(n.isExported !== undefined ? { isExported: n.isExported } : {}),
          ...(n.entryPointKind !== undefined ? { entryPointKind: n.entryPointKind } : {}),
        },
      },
    };
  }

  const runCypher = async <T,>(query: string, params?: Record<string, unknown>): Promise<T[]> => {
    const val = params?.["val"] as string | undefined;

    if (query.includes("-[:CALLS]->") && query.includes("callerName")) {
      const callers = callsEdges
        .filter((e) => e.to === val)
        .map((e) => ({ callerId: e.from, callerName: byId.get(e.from)?.name ?? e.from }));
      return callers as unknown as T[];
    }

    if (query.includes("WHERE n.id = $val") && query.includes("LIMIT 1")) {
      const hit = (val ? byId.get(val) : undefined) ?? nodes.find((n) => (n.name ?? n.id) === val);
      return (hit ? [nodeRow(hit)] : []) as unknown as T[];
    }

    if (query.includes("n.name CONTAINS $val")) {
      return nodes.filter((n) => (n.name ?? n.id).includes(val ?? "")).map(nodeRow) as unknown as T[];
    }

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

describe("verifyUsage", () => {
  it("refutes 'X is dead' when callers exist, with the caller set as counterexample/trueAnswer", async () => {
    const graph = makeGraph(
      [
        { id: "helper", name: "helper" },
        { id: "a", name: "a" },
        { id: "b", name: "b" },
      ],
      [
        { from: "a", to: "helper" },
        { from: "b", to: "helper" },
      ],
    );

    const a = await verifyUsage("helper", graph);
    expect(a.verdict).toBe("refuted");
    expect(a.basis).toBe("presence");
    expect(a.counterexample).toMatch(/a/);
    expect(a.counterexample).toMatch(/b/);
    expect(a.trueAnswer).toBeDefined();
  });

  it("confirms an uncalled private util is dead", async () => {
    const graph = makeGraph([{ id: "orphan", name: "orphan", visibility: "private" }], []);
    const a = await verifyUsage("orphan", graph);
    expect(a.verdict).toBe("confirmed");
    expect(a.basis).toBe("absence");
    expect(a.dynamicReachable).toBe(false);
  });

  it("is uncertain for an uncalled but EXPORTED symbol (may be called externally)", async () => {
    const graph = makeGraph([{ id: "pub", name: "pub", visibility: "public" }], []);
    const a = await verifyUsage("pub", graph);
    expect(a.verdict).toBe("uncertain");
    expect(a.dynamicReachable).toBe(true);
  });

  it("is uncertain for an uncalled entry-point-named symbol (framework-invoked)", async () => {
    const graph = makeGraph([{ id: "h", name: "handleRequest", visibility: "private" }], []);
    const a = await verifyUsage("handleRequest", graph);
    expect(a.verdict).toBe("uncertain");
    expect(a.dynamicReachable).toBe(true);
  });

  it("is uncertain (graceful) for an unknown symbol with suggestions", async () => {
    const graph = makeGraph([{ id: "realName", name: "realName" }], []);
    const a = await verifyUsage("ghost", graph);
    expect(a.verdict).toBe("uncertain");
    expect(a.evidence).toContain("realName");
  });

  // ── Wave 8 (T1): real persisted fields with pre-Wave-2 fallback ───────────
  it("is uncertain for an uncalled symbol that is exported via the REAL persisted field (private visibility)", async () => {
    // visibility private (proxy would CONFIRM dead) but the persisted export
    // flag is true → uncertain, may be invoked externally.
    const graph = makeGraph([{ id: "p", name: "publicThing", visibility: "private", isExported: "true" }], []);
    const a = await verifyUsage("publicThing", graph);
    expect(a.verdict).toBe("uncertain");
    expect(a.dynamicReachable).toBe(true);
  });

  it("confirms dead for an uncalled symbol whose persisted isExported is false (overrides public visibility)", async () => {
    // visibility public (proxy would say uncertain) but the export flag is
    // false → not part of the public surface → confirmed dead.
    const graph = makeGraph([{ id: "i", name: "internalThing", visibility: "public", isExported: "false" }], []);
    const a = await verifyUsage("internalThing", graph);
    expect(a.verdict).toBe("confirmed");
  });

  it("is uncertain for an uncalled symbol classified as an entry point by persisted entryPointKind (name not entry-shaped)", async () => {
    // "renderWidget" does NOT match the entry-point name regex; only the
    // persisted entryPointKind keeps it from being confirmed dead.
    const graph = makeGraph(
      [{ id: "w", name: "renderWidget", visibility: "private", entryPointKind: "route" }],
      [],
    );
    const a = await verifyUsage("renderWidget", graph);
    expect(a.verdict).toBe("uncertain");
    expect(a.dynamicReachable).toBe(true);
  });
});
