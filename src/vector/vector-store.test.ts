/**
 * Unit tests for VectorStore class.
 * Requirements: 3.1–3.6
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VectorStore } from "./vector-store.js";
import type { Embedding } from "../types/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEmbedding(): Embedding {
  return { vector: new Array(1536).fill(0.1), dimensions: 1536 };
}

function makeMockPool(rows: Record<string, unknown>[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

// ─── getTableName ─────────────────────────────────────────────────────────────

describe("VectorStore.getTableName", () => {
  it("prepends prefix to embeddings", () => {
    const store = new VectorStore("tpc_");
    expect(store.getTableName("embeddings")).toBe("tpc_embeddings");
  });

  it("prepends prefix to metadata", () => {
    const store = new VectorStore("myapp_");
    expect(store.getTableName("metadata")).toBe("myapp_metadata");
  });

  it("returns base name when prefix is empty", () => {
    const store = new VectorStore("");
    expect(store.getTableName("embeddings")).toBe("embeddings");
    expect(store.getTableName("metadata")).toBe("metadata");
  });
});

// ─── createTables ─────────────────────────────────────────────────────────────

describe("VectorStore.createTables", () => {
  it("uses prefixed table name in CREATE TABLE", async () => {
    const pool = makeMockPool();
    const store = new VectorStore("tpc_");
    await store.createTables(pool as never);

    const calls: string[] = pool.query.mock.calls.map((c: unknown[]) =>
      typeof c[0] === "string" ? c[0] : "",
    );
    const createCall = calls.find((sql) => sql.includes("CREATE TABLE"));
    expect(createCall).toContain("tpc_embeddings");
  });

  it("uses prefixed table name in CREATE INDEX", async () => {
    const pool = makeMockPool();
    const store = new VectorStore("tpc_");
    await store.createTables(pool as never);

    const calls: string[] = pool.query.mock.calls.map((c: unknown[]) =>
      typeof c[0] === "string" ? c[0] : "",
    );
    const indexCall = calls.find((sql) => sql.includes("CREATE INDEX"));
    expect(indexCall).toContain("tpc_embeddings");
  });

  it("uses base table name when prefix is empty", async () => {
    const pool = makeMockPool();
    const store = new VectorStore("");
    await store.createTables(pool as never);

    const calls: string[] = pool.query.mock.calls.map((c: unknown[]) =>
      typeof c[0] === "string" ? c[0] : "",
    );
    const createCall = calls.find((sql) => sql.includes("CREATE TABLE"));
    expect(createCall).toContain("embeddings");
    expect(createCall).not.toContain("_embeddings");
  });
});

// ─── indexSymbol ──────────────────────────────────────────────────────────────

describe("VectorStore.indexSymbol", () => {
  it("uses prefixed table name in INSERT", async () => {
    const pool = makeMockPool();
    const store = new VectorStore("tpc_");
    await store.indexSymbol(pool as never, "sym-1", makeEmbedding());

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("tpc_embeddings");
  });

  it("passes symbolId, embedding vector, and metadata as params", async () => {
    const pool = makeMockPool();
    const store = new VectorStore("tpc_");
    const embedding = makeEmbedding();
    await store.indexSymbol(pool as never, "sym-1", embedding, { lang: "ts" });

    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("sym-1");
    expect(params[1]).toBe(JSON.stringify(embedding.vector));
    expect(params[2]).toBe(JSON.stringify({ lang: "ts" }));
  });
});

// ─── semanticSearch ───────────────────────────────────────────────────────────

describe("VectorStore.semanticSearch", () => {
  it("uses prefixed table name in SELECT", async () => {
    const pool = makeMockPool([]);
    const store = new VectorStore("tpc_");
    await store.semanticSearch(pool as never, makeEmbedding(), 5);

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("tpc_embeddings");
  });

  it("maps rows to SearchResult shape", async () => {
    const pool = makeMockPool([
      { symbol_id: "sym-1", score: "0.95", metadata: { lang: "ts" } },
    ]);
    const store = new VectorStore("tpc_");
    const results = await store.semanticSearch(pool as never, makeEmbedding(), 5);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ symbolId: "sym-1", score: 0.95, metadata: { lang: "ts" } });
  });

  it("returns empty array when no rows", async () => {
    const pool = makeMockPool([]);
    const store = new VectorStore("tpc_");
    const results = await store.semanticSearch(pool as never, makeEmbedding(), 5);
    expect(results).toHaveLength(0);
  });
});
