/**
 * Wave 8 · T9 — guarded read-only Cypher querying fn tests.
 *
 * Covers: the read-only guardrails (write/DDL/procedure rejection, multi-
 * statement rejection, read-leader requirement), evasion resistance (case,
 * keywords hidden in string literals / comments, glued tokens), the row cap,
 * the JS-side timeout, and prefix stripping from returned rows. The single
 * load-bearing invariant: a rejected query NEVER reaches the adapter.
 */
import { describe, it, expect, vi } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import {
  queryGraph,
  validateReadOnlyCypher,
  stripLiteralsAndComments,
  stripPrefixFromValue,
  clampLimit,
  QUERY_GRAPH_MAX_ROWS,
  QUERY_GRAPH_DEFAULT_ROWS,
} from "./query-graph.js";

/** Build a graph whose runCypher returns `rows` and records read/write calls. */
function makeGraph(rows: Record<string, unknown>[] = []): {
  graph: GraphAdapter;
  runCypher: ReturnType<typeof vi.fn>;
  runCypherWrite: ReturnType<typeof vi.fn>;
} {
  const runCypher = vi.fn(async () => rows);
  const runCypherWrite = vi.fn(async () => {});
  const graph = {
    createNode: async () => {},
    createRelationship: async () => {},
    queryNodes: async () => [],
    queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0,
    deleteRelationshipsByType: async () => 0,
    runCypher: runCypher as unknown as GraphAdapter["runCypher"],
    runCypherWrite: runCypherWrite as unknown as GraphAdapter["runCypherWrite"],
  } as GraphAdapter;
  return { graph, runCypher, runCypherWrite };
}

describe("validateReadOnlyCypher", () => {
  it("accepts read statements (MATCH/OPTIONAL MATCH/WITH/UNWIND/RETURN)", () => {
    expect(validateReadOnlyCypher("MATCH (s:Symbol) RETURN s")).toBeNull();
    expect(validateReadOnlyCypher("OPTIONAL MATCH (s:Symbol) RETURN s")).toBeNull();
    expect(validateReadOnlyCypher("WITH 1 AS x RETURN x")).toBeNull();
    expect(validateReadOnlyCypher("UNWIND [1,2,3] AS x RETURN x")).toBeNull();
    expect(validateReadOnlyCypher("RETURN 1")).toBeNull();
    // A trailing semicolon on a single statement is fine.
    expect(validateReadOnlyCypher("MATCH (s:Symbol) RETURN s ;")).toBeNull();
  });

  it("rejects each mutation/DDL/procedure keyword (case-insensitive, whole word)", () => {
    for (const q of [
      "CREATE (n:Symbol) RETURN n",
      "MATCH (n) MERGE (n)-[:CALLS]->(m) RETURN n",
      "MATCH (n) SET n.x = 1 RETURN n",
      "MATCH (n) DELETE n",
      "MATCH (n) DETACH DELETE n",
      "MATCH (n) REMOVE n.x RETURN n",
      "DROP TABLE Symbol",
      "ALTER TABLE Symbol ADD x STRING",
      "CALL db.something() RETURN 1",
      "LOAD FROM 'x.csv' RETURN 1",
      "COPY Symbol FROM 'x.csv'",
      "INSTALL fts",
      "ATTACH 'other.db' AS o",
    ]) {
      const reason = validateReadOnlyCypher(q);
      expect(reason, q).not.toBeNull();
      expect(reason).toMatch(/^unsupported:/);
    }
  });

  it("rejects lowercase and mixed-case evasion (delete / DeTaCh DeLeTe)", () => {
    expect(validateReadOnlyCypher("match (n) delete n")).toMatch(/unsupported/i);
    expect(validateReadOnlyCypher("MATCH (n) DeTaCh DeLeTe n")).toMatch(/unsupported/i);
  });

  it("rejects a second statement (non-trailing semicolon)", () => {
    const reason = validateReadOnlyCypher("MATCH (n) RETURN n; DROP TABLE x");
    expect(reason).toMatch(/multiple statements/i);
  });

  it("is NOT tricked by a forbidden keyword inside a string literal", () => {
    // 'DELETE' here is data, not a clause — must be accepted.
    expect(validateReadOnlyCypher("MATCH (s:Symbol {name: 'DELETE'}) RETURN s")).toBeNull();
    expect(validateReadOnlyCypher("MATCH (s:Symbol) WHERE s.name = 'CREATE foo' RETURN s")).toBeNull();
    // A semicolon inside a string is data, not a statement separator.
    expect(validateReadOnlyCypher("MATCH (s:Symbol) WHERE s.name = 'a;b' RETURN s")).toBeNull();
  });

  it("is NOT tricked by a forbidden keyword inside a comment", () => {
    expect(validateReadOnlyCypher("MATCH (s:Symbol) RETURN s // DELETE everything")).toBeNull();
    expect(validateReadOnlyCypher("/* CREATE */ MATCH (s:Symbol) RETURN s")).toBeNull();
    expect(validateReadOnlyCypher("MATCH (s:Symbol) /* DROP TABLE */ RETURN s")).toBeNull();
  });

  it("still catches a REAL mutation that also has a decoy keyword in a string", () => {
    // The literal 'safe' must not mask the real DELETE clause.
    const reason = validateReadOnlyCypher("MATCH (n {tag:'safe'}) DELETE n");
    expect(reason).toMatch(/unsupported/i);
  });

  it("rejects a query that does not start with a read clause", () => {
    expect(validateReadOnlyCypher("FOO bar baz")).toMatch(/must start with a read clause/i);
    expect(validateReadOnlyCypher("")).toMatch(/empty query/i);
    expect(validateReadOnlyCypher("   ")).toMatch(/empty query/i);
  });
});

describe("stripLiteralsAndComments", () => {
  it("replaces string literals and comments with spaces, preserving structure", () => {
    expect(stripLiteralsAndComments("MATCH (n {x:'CREATE'}) RETURN n")).not.toContain("CREATE");
    expect(stripLiteralsAndComments("RETURN 1 // DELETE")).not.toContain("DELETE");
    expect(stripLiteralsAndComments("/* DROP */ RETURN 1")).not.toContain("DROP");
    // Escaped quote inside a string does not end the literal early.
    expect(stripLiteralsAndComments("RETURN 'a\\'CREATE'")).not.toContain("CREATE");
  });
});

describe("clampLimit", () => {
  it("defaults and clamps to the hard max", () => {
    expect(clampLimit(undefined)).toBe(QUERY_GRAPH_DEFAULT_ROWS);
    expect(clampLimit(0)).toBe(QUERY_GRAPH_DEFAULT_ROWS);
    expect(clampLimit(-5)).toBe(QUERY_GRAPH_DEFAULT_ROWS);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(99999)).toBe(QUERY_GRAPH_MAX_ROWS);
  });
});

describe("stripPrefixFromValue", () => {
  it("strips the prefix from node labels and rel type, recursively", () => {
    const node = { labels: ["tpc_Symbol"], properties: { name: "foo" } };
    expect(stripPrefixFromValue(node, "tpc_")).toEqual({
      labels: ["Symbol"],
      properties: { name: "foo" },
    });
    const rel = { type: "tpc_CALLS", properties: {} };
    expect(stripPrefixFromValue(rel, "tpc_")).toEqual({ type: "CALLS", properties: {} });
    // Arrays of nodes (collection projections).
    expect(stripPrefixFromValue([node], "tpc_")).toEqual([
      { labels: ["Symbol"], properties: { name: "foo" } },
    ]);
  });

  it("leaves scalars and property values untouched", () => {
    expect(stripPrefixFromValue("tpc_not_a_label", "tpc_")).toBe("tpc_not_a_label");
    expect(stripPrefixFromValue(42, "tpc_")).toBe(42);
    // A property value that happens to start with the prefix is data, not a label.
    const node = { labels: ["tpc_Symbol"], properties: { name: "tpc_keepme" } };
    const out = stripPrefixFromValue(node, "tpc_") as Record<string, unknown>;
    expect((out.properties as Record<string, unknown>).name).toBe("tpc_keepme");
  });
});

describe("queryGraph", () => {
  it("happy path: a read query returns rows and reports the cap", async () => {
    const { graph, runCypher } = makeGraph([{ "s.name": "alpha" }, { "s.name": "beta" }]);
    const res = await queryGraph(graph, { cypher: "MATCH (s:Symbol) RETURN s.name" });
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBe(2);
    expect(res.rows).toEqual([{ "s.name": "alpha" }, { "s.name": "beta" }]);
    expect(res.truncated).toBe(false);
    expect(runCypher).toHaveBeenCalledTimes(1);
  });

  it("rejects write/DDL PRE-execution and never calls the adapter", async () => {
    for (const cypher of [
      "CREATE (n:Symbol) RETURN n",
      "MATCH (n) MERGE (n)-[:CALLS]->(m) RETURN n",
      "MATCH (n) SET n.x = 1 RETURN n",
      "MATCH (n) DELETE n",
      "DROP TABLE Symbol",
      "CALL db.x() RETURN 1",
    ]) {
      const { graph, runCypher, runCypherWrite } = makeGraph();
      const res = await queryGraph(graph, { cypher });
      expect(res.ok, cypher).toBe(false);
      expect(res.unsupported, cypher).toMatch(/^unsupported:/);
      expect(res.rows).toEqual([]);
      // The load-bearing invariant: NO adapter call of any kind.
      expect(runCypher, cypher).not.toHaveBeenCalled();
      expect(runCypherWrite, cypher).not.toHaveBeenCalled();
    }
  });

  it("rejects a second statement PRE-execution", async () => {
    const { graph, runCypher } = makeGraph();
    const res = await queryGraph(graph, { cypher: "MATCH (n) RETURN n; DROP TABLE x" });
    expect(res.ok).toBe(false);
    expect(res.unsupported).toMatch(/multiple statements/i);
    expect(runCypher).not.toHaveBeenCalled();
  });

  it("enforces the row cap and reports truncation", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ i }));
    const { graph } = makeGraph(rows);
    const res = await queryGraph(graph, { cypher: "MATCH (s:Symbol) RETURN s", limit: 999 });
    expect(res.limit).toBe(QUERY_GRAPH_MAX_ROWS); // clamped from 999
    expect(res.rowCount).toBe(QUERY_GRAPH_MAX_ROWS);
    expect(res.truncated).toBe(true);
  });

  it("strips the persisted prefix from returned node labels", async () => {
    const { graph } = makeGraph([
      { n: { labels: ["tpc_Symbol"], properties: { name: "foo" } } },
    ]);
    const res = await queryGraph(graph, { cypher: "MATCH (n:Symbol) RETURN n", prefix: "tpc_" });
    expect(res.ok).toBe(true);
    const row = res.rows[0] as { n: { labels: string[] } };
    expect(row.n.labels).toEqual(["Symbol"]);
  });

  it("does not prefix the query itself (passes the bare query to the adapter)", async () => {
    const { graph, runCypher } = makeGraph([]);
    await queryGraph(graph, { cypher: "MATCH (s:Symbol) RETURN s", prefix: "tpc_" });
    expect(runCypher.mock.calls[0]?.[0]).toBe("MATCH (s:Symbol) RETURN s");
  });

  it("returns a clean empty result for zero rows", async () => {
    const { graph } = makeGraph([]);
    const res = await queryGraph(graph, { cypher: "MATCH (s:Symbol) RETURN s" });
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBe(0);
    expect(res.rows).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it("applies a statement timeout (best-effort JS race)", async () => {
    const slowGraph = {
      ...makeGraph().graph,
      runCypher: (async () => {
        await new Promise((r) => setTimeout(r, 50));
        return [];
      }) as unknown as GraphAdapter["runCypher"],
    } as GraphAdapter;
    await expect(
      queryGraph(slowGraph, { cypher: "MATCH (s:Symbol) RETURN s", timeoutMs: 5 }),
    ).rejects.toThrow(/timeout/i);
  });
});
