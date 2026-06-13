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
const mockConnection = {
  query: mockQuery,
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

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("MATCH (n:tpc_Symbol)");
      expect(query).toContain("DETACH DELETE n");
    });

    it("should execute via connection.query()", async () => {
      const adapter = createAdapter();
      await adapter.deleteNodesByLabel("Symbol");

      expect(mockQuery).toHaveBeenCalledOnce();
    });
  });

  // ── deleteRelationshipsByType (Req 2.1, 2.2) ──────────────────────────

  describe("deleteRelationshipsByType", () => {
    it("should DELETE with prefixed type (Req 2.2)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.deleteRelationshipsByType("CALLS");

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("tpc_CALLS");
      expect(query).toContain("DELETE r");
    });

    it("should execute via connection.query()", async () => {
      const adapter = createAdapter();
      await adapter.deleteRelationshipsByType("CALLS");

      expect(mockQuery).toHaveBeenCalledOnce();
    });
  });

  // ── runCypher (Req 2.5, 2.6) ──────────────────────────────────────────

  describe("runCypher", () => {
    it("should execute query via connection.query() (Req 2.5)", async () => {
      const adapter = createAdapter();
      await adapter.runCypher("MATCH (n) RETURN n LIMIT 1");

      expect(mockQuery).toHaveBeenCalledOnce();
    });

    it("should pass query string to connection.query()", async () => {
      const adapter = createAdapter();
      await adapter.runCypher("MATCH (n) WHERE n.id = $id RETURN n", { id: "s1" });

      expect(mockQuery).toHaveBeenCalledWith(
        "MATCH (n) WHERE n.id = $id RETURN n",
      );
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
  });

  // ── runCypherWrite (Req 2.5, 2.6) ─────────────────────────────────────

  describe("runCypherWrite", () => {
    it("should execute query via connection.query() (Req 2.5)", async () => {
      const adapter = createAdapter();
      await adapter.runCypherWrite("CREATE (n:Test {id: $id})", { id: "t1" });

      expect(mockQuery).toHaveBeenCalledOnce();
    });

    it("should pass query string to connection.query()", async () => {
      const adapter = createAdapter();
      await adapter.runCypherWrite("CREATE (n:Test {id: $id})", { id: "t1" });

      expect(mockQuery).toHaveBeenCalledWith("CREATE (n:Test {id: $id})");
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
