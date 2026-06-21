/**
 * Unit tests for LadybugGraphAdapter.
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LbugValue, NodeValue, RelValue } from "@ladybugdb/core";

// ─── Mock LadybugDB Connection ───────────────────────────────────────────────

/** Helper: create a mock QueryResult wrapping rows. */
function mockQueryResult(rows: Record<string, LbugValue>[]): { getAll: () => Promise<Record<string, LbugValue>[]> } {
  return { getAll: async () => rows };
}

const mockQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
// The batch / parameterized path uses prepare() + execute() rather than query().
// prepare() returns a PreparedStatement-like; execute() returns a QueryResult.
const mockPreparedStatement = {
  isSuccess: () => true,
  getErrorMessage: () => "",
};
const mockPrepare = vi.fn().mockResolvedValue(mockPreparedStatement);
const mockExecute = vi.fn().mockResolvedValue(mockQueryResult([]));
const mockConnection = {
  query: mockQuery,
  prepare: mockPrepare,
  execute: mockExecute,
  init: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

import { LadybugGraphAdapter } from "./ladybug-graph-adapter.js";
import type { GraphAdapter } from "../../core/ports/persistence.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createAdapter(prefix = "tpc_"): GraphAdapter {
  return new LadybugGraphAdapter(mockConnection as never, prefix);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("LadybugGraphAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue(mockQueryResult([]));
    mockPrepare.mockResolvedValue(mockPreparedStatement);
    mockExecute.mockResolvedValue(mockQueryResult([]));
  });

  // ── createNode (Req 2.2, 2.3) ──────────────────────────────────────────

  describe("createNode", () => {
    it("should use MERGE with SET for upsert semantics (Req 2.3)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.createNode("Symbol", { id: "s1", name: "foo", kind: "function" });

      expect(mockQuery).toHaveBeenCalledOnce();
      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("MERGE");
    });

    it("should prefix the label (Req 2.2)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.createNode("Symbol", { id: "s1" });

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("tpc_Symbol");
    });

    it("should execute a query via connection.query()", async () => {
      const adapter = createAdapter();
      await adapter.createNode("Symbol", { id: "s1" });

      expect(mockQuery).toHaveBeenCalledOnce();
    });

    it("recreates schema and retries when a table is missing", async () => {
      const adapter = createAdapter("tpc_");
      mockQuery
        .mockRejectedValueOnce(new Error("Binder exception: Table tpc_ExternalDependency does not exist."))
        .mockResolvedValue(mockQueryResult([]));

      await adapter.createNode("ExternalDependency", { id: "ext:pkg", name: "pkg" });

      expect(mockQuery.mock.calls.some((call) =>
        String(call[0]).includes("CREATE NODE TABLE IF NOT EXISTS tpc_ExternalDependency"),
      )).toBe(true);
      expect(mockQuery.mock.calls.at(-1)?.[0]).toContain("MERGE (n:tpc_ExternalDependency");
    });
  });

  // ── createRelationship (Req 2.2, 2.4) ──────────────────────────────────

  describe("createRelationship", () => {
    it("should use MATCH + MERGE pattern (Req 2.4)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.createRelationship("s1", "s2", "CALLS", { weight: 1 });

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("MATCH");
      expect(query).toContain("MERGE");
    });

    it("should prefix the relationship type (Req 2.2)", async () => {
      const adapter = createAdapter("dev_");
      await adapter.createRelationship("s1", "s2", "CALLS");

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("dev_CALLS");
    });

    it("should execute a query via connection.query()", async () => {
      const adapter = createAdapter();
      await adapter.createRelationship("s1", "s2", "CALLS");

      expect(mockQuery).toHaveBeenCalledOnce();
    });

    it("uses Symbol -> ExternalDependency labels for DEPENDS_ON", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.createRelationship("sym-1", "ext:pkg", "DEPENDS_ON");

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("MATCH (a:tpc_Symbol");
      expect(query).toContain("(b:tpc_ExternalDependency");
    });
  });

  // ── createNodes (batch fast-path) ──────────────────────────────────────

  describe("createNodes", () => {
    it("builds one parameterized UNWIND/MERGE query per call with prefixed label and non-id SET columns", async () => {
      const adapter = createAdapter("tpc_") as LadybugGraphAdapter;
      await adapter.createNodes("Symbol", [
        { id: "s1", name: "foo", kind: "function" },
        { id: "s2", name: "bar", kind: "class" },
      ]);

      expect(mockPrepare).toHaveBeenCalledOnce();
      expect(mockExecute).toHaveBeenCalledOnce();
      const query = mockPrepare.mock.calls[0][0] as string;
      expect(query).toContain("UNWIND $rows AS row");
      expect(query).toContain("MERGE (n:tpc_Symbol {id: row.id})");
      expect(query).toContain("n.name = row.name");
      expect(query).toContain("n.kind = row.kind");
      // id must NOT appear in a SET assignment (it is the primary key).
      expect(query).not.toContain("n.id = row.id");

      const params = mockExecute.mock.calls[0][1] as { rows: unknown[] };
      expect(params.rows).toHaveLength(2);
      expect(params.rows[0]).toEqual({ id: "s1", name: "foo", kind: "function" });
    });

    it("no-ops on an empty array", async () => {
      const adapter = createAdapter("tpc_") as LadybugGraphAdapter;
      await adapter.createNodes("Symbol", []);
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("omits the SET clause when rows have only an id", async () => {
      const adapter = createAdapter("tpc_") as LadybugGraphAdapter;
      await adapter.createNodes("Symbol", [{ id: "s1" }]);
      const query = mockPrepare.mock.calls[0][0] as string;
      expect(query).not.toContain("SET");
      expect(query).toContain("MERGE (n:tpc_Symbol {id: row.id})");
    });

    it("recreates schema and retries when a table is missing", async () => {
      const adapter = createAdapter("tpc_") as LadybugGraphAdapter;
      mockExecute
        .mockRejectedValueOnce(new Error("Binder exception: Table tpc_Symbol does not exist."))
        .mockResolvedValue(mockQueryResult([]));

      await adapter.createNodes("Symbol", [{ id: "s1", name: "foo" }]);

      expect(mockQuery.mock.calls.some((call) =>
        String(call[0]).includes("CREATE NODE TABLE IF NOT EXISTS tpc_Symbol"),
      )).toBe(true);
      // Two execute attempts: the failing one, then the post-schema retry.
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });
  });

  // ── createRelationships (batch fast-path) ──────────────────────────────

  describe("createRelationships", () => {
    it("builds a parameterized UNWIND/MATCH/MERGE query with prefixed labels and type", async () => {
      const adapter = createAdapter("tpc_") as LadybugGraphAdapter;
      await adapter.createRelationships("CALLS", [
        { fromId: "s1", toId: "s2" },
        { fromId: "s3", toId: "s4" },
      ]);

      const query = mockPrepare.mock.calls[0][0] as string;
      expect(query).toContain("UNWIND $rels AS rel");
      expect(query).toContain("MATCH (a:tpc_Symbol), (b:tpc_Symbol)");
      expect(query).toContain("WHERE a.id = rel.fromId AND b.id = rel.toId");
      expect(query).toContain("MERGE (a)-[r:tpc_CALLS]->(b)");
      // CALLS has no schema props, so no SET clause.
      expect(query).not.toContain("SET");

      const params = mockExecute.mock.calls[0][1] as { rels: unknown[] };
      expect(params.rels).toEqual([
        { fromId: "s1", toId: "s2" },
        { fromId: "s3", toId: "s4" },
      ]);
    });

    it("uses Process -> Symbol labels and sets only step_order for HAS_STEP", async () => {
      const adapter = createAdapter("tpc_") as LadybugGraphAdapter;
      await adapter.createRelationships("HAS_STEP", [
        { fromId: "p1", toId: "s1", properties: { step_order: "0", ignored: "x" } },
      ]);

      const query = mockPrepare.mock.calls[0][0] as string;
      expect(query).toContain("MATCH (a:tpc_Process), (b:tpc_Symbol)");
      expect(query).toContain("WHERE a.id = rel.fromId AND b.id = rel.toId");
      expect(query).toContain("MERGE (a)-[r:tpc_HAS_STEP]->(b)");
      expect(query).toContain("ON CREATE SET r.step_order = rel.step_order");
      expect(query).toContain("ON MATCH SET r.step_order = rel.step_order");
      expect(query).not.toContain("ignored");

      const params = mockExecute.mock.calls[0][1] as { rels: Array<Record<string, unknown>> };
      // Only fromId/toId and the allowed prop are flattened in.
      expect(params.rels[0]).toEqual({ fromId: "p1", toId: "s1", step_order: "0" });
    });

    it("uses Symbol -> ExternalDependency labels for DEPENDS_ON", async () => {
      const adapter = createAdapter("tpc_") as LadybugGraphAdapter;
      await adapter.createRelationships("DEPENDS_ON", [{ fromId: "sym-1", toId: "ext:pkg" }]);

      const query = mockPrepare.mock.calls[0][0] as string;
      expect(query).toContain("MATCH (a:tpc_Symbol), (b:tpc_ExternalDependency)");
      expect(query).toContain("WHERE a.id = rel.fromId AND b.id = rel.toId");
    });

    it("no-ops on an empty array", async () => {
      const adapter = createAdapter("tpc_") as LadybugGraphAdapter;
      await adapter.createRelationships("CALLS", []);
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe("initializeSchema", () => {
    it("creates ExternalDependency and DEPENDS_ON tables", async () => {
      const adapter = createAdapter("tpc_") as LadybugGraphAdapter;
      await adapter.initializeSchema();

      const executedQueries = mockQuery.mock.calls.map((call) => call[0] as string);
      expect(executedQueries.some((query) => query.includes("tpc_ExternalDependency"))).toBe(true);
      expect(executedQueries.some((query) => query.includes("tpc_DEPENDS_ON"))).toBe(true);
    });
  });

  // ── queryNodes (Req 2.1, 2.2) ──────────────────────────────────────────

  describe("queryNodes", () => {
    it("should query with prefixed label (Req 2.2)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.queryNodes("Symbol");

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("MATCH (n:tpc_Symbol)");
    });

    it("should execute via connection.query()", async () => {
      const adapter = createAdapter();
      await adapter.queryNodes("Symbol");

      expect(mockQuery).toHaveBeenCalledOnce();
    });

    it("should return mapped GraphNode objects", async () => {
      const nodeValue: NodeValue = {
        _label: "tpc_Symbol",
        _id: { offset: 0, table: 0 },
        id: "s1",
        name: "foo",
        kind: "function",
      };
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ n: nodeValue }]));

      const adapter = createAdapter("tpc_");
      const nodes = await adapter.queryNodes("Symbol");

      expect(nodes).toHaveLength(1);
      expect(nodes[0].id).toBe("s1");
      expect(nodes[0].labels).toEqual(["tpc_Symbol"]);
    });

    it("should apply filter as WHERE clause when provided", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.queryNodes("Symbol", { kind: "function" });

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("WHERE");
    });

    it("should omit WHERE clause when no filter provided", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.queryNodes("Symbol");

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).not.toContain("WHERE");
    });

    it("should return empty array when no records found", async () => {
      const adapter = createAdapter();
      const nodes = await adapter.queryNodes("Symbol");

      expect(nodes).toEqual([]);
    });
  });

  // ── queryRelationships (Req 2.1, 2.2) ──────────────────────────────────

  describe("queryRelationships", () => {
    it("should query with prefixed type (Req 2.2)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.queryRelationships("CALLS");

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("tpc_CALLS");
    });

    it("should execute via connection.query()", async () => {
      const adapter = createAdapter();
      await adapter.queryRelationships("CALLS");

      expect(mockQuery).toHaveBeenCalledOnce();
    });

    it("should return mapped GraphRelationship objects", async () => {
      const relValue: RelValue = {
        _label: "tpc_CALLS",
        _src: { offset: 0, table: 0 },
        _dst: { offset: 1, table: 0 },
        _id: 0,
        weight: 1,
      };
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ r: relValue }]));

      const adapter = createAdapter("tpc_");
      const rels = await adapter.queryRelationships("CALLS");

      expect(rels).toHaveLength(1);
      expect(rels[0].type).toBe("tpc_CALLS");
    });
  });

  // ── deleteNodesByLabel (Req 2.1, 2.2) ──────────────────────────────────

  describe("deleteNodesByLabel", () => {
    it("should use DETACH DELETE with prefixed label (Req 2.2)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.deleteNodesByLabel("Symbol");

      // First query counts, second deletes — assert against the DELETE query.
      const deleteQuery = mockQuery.mock.calls[1][0] as string;
      expect(deleteQuery).toContain("MATCH (n:tpc_Symbol)");
      expect(deleteQuery).toContain("DETACH DELETE n");
    });

    it("should count then delete via connection.query()", async () => {
      const adapter = createAdapter();
      await adapter.deleteNodesByLabel("Symbol");

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[0][0]).toContain("count(n)");
    });

    it("returns the pre-delete node count (not a hardcoded 0)", async () => {
      const adapter = createAdapter("tpc_");
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ count: 42 }]));

      await expect(adapter.deleteNodesByLabel("Symbol")).resolves.toBe(42);
    });
  });

  // ── deleteRelationshipsByType (Req 2.1, 2.2) ──────────────────────────

  describe("deleteRelationshipsByType", () => {
    it("should DELETE with prefixed type (Req 2.2)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.deleteRelationshipsByType("CALLS");

      // First query counts, second deletes — assert against the DELETE query.
      const deleteQuery = mockQuery.mock.calls[1][0] as string;
      expect(deleteQuery).toContain("tpc_CALLS");
      expect(deleteQuery).toContain("DELETE r");
    });

    it("should count then delete via connection.query()", async () => {
      const adapter = createAdapter();
      await adapter.deleteRelationshipsByType("CALLS");

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[0][0]).toContain("count(r)");
    });

    it("returns the pre-delete relationship count (not a hardcoded 0)", async () => {
      const adapter = createAdapter("tpc_");
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ count: 7 }]));

      await expect(adapter.deleteRelationshipsByType("CALLS")).resolves.toBe(7);
    });
  });

  // ── deleteSymbolsByFilePaths (A4 diff-based persistence) ────────────────

  describe("deleteSymbolsByFilePaths", () => {
    it("DETACH DELETEs symbols WHERE filePath IN $paths (parameterized, prefixed)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.deleteSymbolsByFilePaths!(["a.ts", "b.ts"]);

      // Parameterized path → prepare/execute. First call counts, second deletes.
      expect(mockPrepare).toHaveBeenCalledTimes(2);
      const deleteQuery = mockPrepare.mock.calls[1][0] as string;
      expect(deleteQuery).toContain("MATCH (n:tpc_Symbol)");
      expect(deleteQuery).toContain("WHERE n.filePath IN $paths");
      expect(deleteQuery).toContain("DETACH DELETE n");
      // The $paths param is bound (not interpolated).
      expect(mockExecute.mock.calls[1][1]).toEqual({ paths: ["a.ts", "b.ts"] });
    });

    it("returns the pre-delete matching count", async () => {
      const adapter = createAdapter("tpc_");
      mockExecute.mockResolvedValueOnce(mockQueryResult([{ count: 3 }]));

      await expect(adapter.deleteSymbolsByFilePaths!(["a.ts"])).resolves.toBe(3);
    });

    it("is a no-op returning 0 for an empty path list (no query issued)", async () => {
      const adapter = createAdapter("tpc_");
      await expect(adapter.deleteSymbolsByFilePaths!([])).resolves.toBe(0);
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // ── runCypher (Req 2.5, 2.6) ──────────────────────────────────────────

  describe("runCypher", () => {
    it("should execute query via connection.query() (Req 2.5)", async () => {
      const adapter = createAdapter();
      await adapter.runCypher("MATCH (n) RETURN n LIMIT 1");

      expect(mockQuery).toHaveBeenCalledOnce();
    });

    it("binds params via prepare/execute when params are provided (gap fix)", async () => {
      const adapter = createAdapter();
      await adapter.runCypher("MATCH (n:Symbol) WHERE n.id = $id RETURN n", { id: "s1" });

      // Previously runCypher silently dropped params and used connection.query(),
      // so `WHERE x = $p` never filtered. The parameterized path must be taken.
      expect(mockPrepare).toHaveBeenCalledOnce();
      expect(mockExecute).toHaveBeenCalledOnce();
      expect(mockQuery).not.toHaveBeenCalled();
      // Prefixing is still applied to the query text.
      expect(mockPrepare.mock.calls[0][0]).toBe("MATCH (n:tpc_Symbol) WHERE n.id = $id RETURN n");
      // Params are actually bound.
      expect(mockExecute.mock.calls[0][1]).toEqual({ id: "s1" });
    });

    it("uses connection.query() (no prepare) when there are no params", async () => {
      const adapter = createAdapter();
      await adapter.runCypher("MATCH (n) RETURN n LIMIT 1");

      expect(mockQuery).toHaveBeenCalledOnce();
      expect(mockPrepare).not.toHaveBeenCalled();
    });

    it("should map records to objects (Req 2.6)", async () => {
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([{ n: { id: "s1", name: "foo" } as unknown as LbugValue, count: 42 }]),
      );

      const adapter = createAdapter();
      const results = await adapter.runCypher<{ n: unknown; count: number }>(
        "MATCH (n) RETURN n, count(*) AS count",
      );

      expect(results).toHaveLength(1);
      expect(results[0].n).toEqual({ id: "s1", name: "foo" });
      expect(results[0].count).toBe(42);
    });

    it("should return empty array when no records", async () => {
      const adapter = createAdapter();
      const results = await adapter.runCypher("MATCH (n) RETURN n");

      expect(results).toEqual([]);
    });

    it("prefixes EVERY rel type in a multi-type alternation, not just the first", async () => {
      const adapter = createAdapter();
      await adapter.runCypher("MATCH (n:Symbol)-[e:CALLS|CONTAINS]->(m:Symbol) RETURN m");

      // Both CALLS and CONTAINS (the `|`-led one) must be prefixed.
      expect(mockQuery.mock.calls[0][0]).toBe(
        "MATCH (n:tpc_Symbol)-[e:tpc_CALLS|tpc_CONTAINS]->(m:tpc_Symbol) RETURN m",
      );
    });
  });

  // ── runCypherWrite (Req 2.5, 2.6) ─────────────────────────────────────

  describe("runCypherWrite", () => {
    it("should execute a no-param write via connection.query() (Req 2.5)", async () => {
      const adapter = createAdapter();
      await adapter.runCypherWrite("MATCH (n:Symbol) DETACH DELETE n");

      expect(mockQuery).toHaveBeenCalledOnce();
      expect(mockPrepare).not.toHaveBeenCalled();
    });

    it("binds params via prepare/execute when params are provided (gap fix)", async () => {
      const adapter = createAdapter();
      await adapter.runCypherWrite("CREATE (n:Symbol {id: $id})", { id: "t1" });

      // No longer ignored: the parameterized path must be taken.
      expect(mockPrepare).toHaveBeenCalledOnce();
      expect(mockExecute).toHaveBeenCalledOnce();
      // Prefixing is still applied to the query text.
      expect(mockPrepare.mock.calls[0][0]).toBe("CREATE (n:tpc_Symbol {id: $id})");
      // Params are actually bound.
      expect(mockExecute.mock.calls[0][1]).toEqual({ id: "t1" });
    });
  });

  // ── Prefix isolation (Req 2.2) ─────────────────────────────────────────

  describe("prefix isolation", () => {
    it("should use different prefixed labels for different adapters", async () => {
      const adapterA = createAdapter("alpha_");
      const adapterB = createAdapter("beta_");

      await adapterA.createNode("Symbol", { id: "s1" });
      const queryA = mockQuery.mock.calls[0][0] as string;

      vi.clearAllMocks();
      mockQuery.mockResolvedValue(mockQueryResult([]));

      await adapterB.createNode("Symbol", { id: "s1" });
      const queryB = mockQuery.mock.calls[0][0] as string;

      expect(queryA).toContain("alpha_Symbol");
      expect(queryA).not.toContain("beta_Symbol");
      expect(queryB).toContain("beta_Symbol");
      expect(queryB).not.toContain("alpha_Symbol");
    });

    it("should use different prefixed types for different adapters", async () => {
      const adapterA = createAdapter("alpha_");
      const adapterB = createAdapter("beta_");

      await adapterA.createRelationship("s1", "s2", "CALLS");
      const queryA = mockQuery.mock.calls[0][0] as string;

      vi.clearAllMocks();
      mockQuery.mockResolvedValue(mockQueryResult([]));

      await adapterB.createRelationship("s1", "s2", "CALLS");
      const queryB = mockQuery.mock.calls[0][0] as string;

      expect(queryA).toContain("alpha_CALLS");
      expect(queryB).toContain("beta_CALLS");
    });
  });
});
