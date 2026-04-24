/**
 * Unit tests for LadybugVectorAdapter.
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LbugValue } from "@ladybugdb/core";
import { LadybugVectorAdapter, SEMANTIC_SEARCH_THRESHOLD } from "./ladybug-vector-adapter.js";
import type { VectorAdapter } from "./types.js";
import type { Embedding } from "../types/index.js";

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createAdapter(prefix = "tpc_"): VectorAdapter {
  return new LadybugVectorAdapter(mockConnection as never, prefix);
}

function makeEmbedding(dims = 4): Embedding {
  return {
    vector: Array.from({ length: dims }, (_, i) => i * 0.1),
    dimensions: dims,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("LadybugVectorAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue(mockQueryResult([]));
  });

  // ── SEMANTIC_SEARCH_THRESHOLD constant ─────────────────────────────────

  describe("SEMANTIC_SEARCH_THRESHOLD", () => {
    it("should be 0.60 (Req 3.4)", () => {
      expect(SEMANTIC_SEARCH_THRESHOLD).toBe(0.60);
    });
  });

  // ── createTables (Req 3.2) ─────────────────────────────────────────────

  describe("createTables", () => {
    it("should create prefix-aware embeddings table (Req 3.2)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.createTables();

      expect(mockQuery).toHaveBeenCalledOnce();
      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("tpc_embeddings");
      expect(query).toContain("CREATE");
    });

    it("should include symbol_id as PRIMARY KEY", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.createTables();

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("symbol_id");
      expect(query).toContain("PRIMARY KEY");
    });

    it("should include embedding and dimensions columns (Req 3.5)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.createTables();

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("embedding");
      expect(query).toContain("dimensions");
    });

    it("should include metadata column with default", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.createTables();

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("metadata");
      expect(query).toContain("DEFAULT");
    });

    it("should use the configured prefix in table name", async () => {
      const adapter = createAdapter("dev_");
      await adapter.createTables();

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("dev_embeddings");
      expect(query).not.toContain("tpc_embeddings");
    });
  });

  // ── indexSymbol (Req 3.3, 3.5) ───────────────────────────────────────────

  describe("indexSymbol", () => {
    it("should use MERGE for upsert (Req 3.3)", async () => {
      const adapter = createAdapter("tpc_");
      const embedding = makeEmbedding(4);
      await adapter.indexSymbol("sym1", embedding, { kind: "function" });

      expect(mockQuery).toHaveBeenCalledOnce();
      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("MERGE");
      expect(query).toContain("tpc_embeddings");
    });

    it("should include symbolId in the query", async () => {
      const adapter = createAdapter("tpc_");
      const embedding = makeEmbedding(3);
      await adapter.indexSymbol("sym1", embedding, { kind: "class" });

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("sym1");
    });

    it("should support variable dimensions (Req 3.5)", async () => {
      const adapter = createAdapter("tpc_");
      const embedding = makeEmbedding(2560);
      await adapter.indexSymbol("sym1", embedding);

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("2560");
    });

    it("should use prefix-aware table name", async () => {
      const adapter = createAdapter("dev_");
      await adapter.indexSymbol("sym1", makeEmbedding(4));

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("dev_embeddings");
    });

    it("emits DOUBLE[] literals for integer-valued embeddings", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.indexSymbol("sym1", {
        vector: [1, 0, -2],
        dimensions: 3,
      });

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("[1.0,0.0,-2.0]");
    });
  });

  // ── semanticSearch (Req 3.4) ───────────────────────────────────────────

  describe("semanticSearch", () => {
    it("should use cosine similarity search (Req 3.4)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.semanticSearch(makeEmbedding(4), 10);

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("array_cosine_similarity");
    });

    it("should filter by threshold >= 0.60 (Req 3.4)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.semanticSearch(makeEmbedding(4), 10);

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain(`>= ${SEMANTIC_SEARCH_THRESHOLD}`);
    });

    it("should order results by score DESC (Req 3.4)", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.semanticSearch(makeEmbedding(4), 10);

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("ORDER BY score DESC");
    });

    it("should apply LIMIT from parameter", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.semanticSearch(makeEmbedding(4), 5);

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("LIMIT 5");
    });

    it("should map rows to SearchResult objects", async () => {
      mockQuery.mockResolvedValueOnce(
        mockQueryResult([
          { symbol_id: "sym1", score: 0.95, metadata: '{"kind":"function"}' },
          { symbol_id: "sym2", score: 0.82, metadata: '{"kind":"class"}' },
        ]),
      );

      const adapter = createAdapter("tpc_");
      const results = await adapter.semanticSearch(makeEmbedding(4), 10);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        symbolId: "sym1",
        score: 0.95,
        metadata: { kind: "function" },
      });
      expect(results[1]).toEqual({
        symbolId: "sym2",
        score: 0.82,
        metadata: { kind: "class" },
      });
    });

    it("should return empty array when no results match threshold", async () => {
      const adapter = createAdapter("tpc_");
      const results = await adapter.semanticSearch(makeEmbedding(4), 10);

      expect(results).toEqual([]);
    });

    it("should use prefix-aware table name", async () => {
      const adapter = createAdapter("dev_");
      await adapter.semanticSearch(makeEmbedding(4), 10);

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("dev_embeddings");
    });

    it("emits DOUBLE[] literals for integer-valued query embeddings", async () => {
      const adapter = createAdapter("tpc_");
      await adapter.semanticSearch({
        vector: [1, 0],
        dimensions: 2,
      }, 10);

      const query = mockQuery.mock.calls[0][0] as string;
      expect(query).toContain("[1.0,0.0]");
    });
  });

  // ── deleteAll (Req 3.1) ────────────────────────────────────────────────

  describe("deleteAll", () => {
    it("should execute DETACH DELETE with prefix-aware table name", async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ count: 5 }])); // count query
      mockQuery.mockResolvedValueOnce(mockQueryResult([])); // delete query
      
      const adapter = createAdapter("tpc_");
      const count = await adapter.deleteAll();

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(count).toBe(5);
      
      const deleteQuery = mockQuery.mock.calls[1][0] as string;
      expect(deleteQuery).toContain("tpc_embeddings");
      expect(deleteQuery).toContain("DETACH DELETE");
    });

    it("should use the configured prefix", async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([{ count: 3 }])); // count query
      mockQuery.mockResolvedValueOnce(mockQueryResult([])); // delete query
      
      const adapter = createAdapter("dev_");
      await adapter.deleteAll();

      const deleteQuery = mockQuery.mock.calls[1][0] as string;
      expect(deleteQuery).toContain("dev_embeddings");
      expect(deleteQuery).not.toContain("tpc_embeddings");
    });
  });

  // ── Prefix isolation ──────────────────────────────────────────────────

  describe("prefix isolation", () => {
    it("should use different table names for different prefixes", async () => {
      const adapterA = createAdapter("alpha_");
      const adapterB = createAdapter("beta_");

      await adapterA.createTables();
      const queryA = mockQuery.mock.calls[0][0] as string;

      vi.clearAllMocks();
      mockQuery.mockResolvedValue(mockQueryResult([]));

      await adapterB.createTables();
      const queryB = mockQuery.mock.calls[0][0] as string;

      expect(queryA).toContain("alpha_embeddings");
      expect(queryA).not.toContain("beta_embeddings");
      expect(queryB).toContain("beta_embeddings");
      expect(queryB).not.toContain("alpha_embeddings");
    });
  });
});
