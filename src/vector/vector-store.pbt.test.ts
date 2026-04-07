/**
 * Property-based tests for VectorStore PostgreSQL prefixing.
 * Validates: Requirements 3.1, 3.2
 */
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { VectorStore } from "./vector-store.js";
import type { Embedding } from "../types/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEmbedding(): Embedding {
  return { vector: new Array(1536).fill(0.1), dimensions: 1536 };
}

type MockPool = { query: ReturnType<typeof vi.fn> };

function makeMockPool(): MockPool {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) };
}

/** Collect all SQL strings passed to pool.query across all calls. */
function capturedSql(pool: MockPool): string[] {
  return (pool.query.mock.calls as unknown[][]).map((args) =>
    typeof args[0] === "string" ? args[0] : "",
  );
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Valid normalized prefix: starts with [a-z], contains [a-z0-9_], ends with _, max 32 chars. */
const validPrefixArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,29}_$/);

const baseTableArb = fc.constantFrom("embeddings" as const, "metadata" as const);

// ─── Property 3: Table Name Construction ──────────────────────────────────────

describe("Property 3: Table Name Construction", () => {
  /**
   * For any valid prefix and base table name, the VectorStore SHALL construct
   * the final table name as prefix + base name.
   * Validates: Requirements 3.1, 3.2
   */
  it("getTableName returns prefix + base for any valid prefix and base table", () => {
    fc.assert(
      fc.property(validPrefixArb, baseTableArb, (prefix, base) => {
        const store = new VectorStore(prefix);
        const result = store.getTableName(base);
        expect(result).toBe(`${prefix}${base}`);
      }),
      { numRuns: 100 },
    );
  });

  it("getTableName result starts with the prefix", () => {
    fc.assert(
      fc.property(validPrefixArb, baseTableArb, (prefix, base) => {
        const store = new VectorStore(prefix);
        expect(store.getTableName(base)).toMatch(new RegExp(`^${prefix}`));
      }),
      { numRuns: 100 },
    );
  });

  it("getTableName result ends with the base table name", () => {
    fc.assert(
      fc.property(validPrefixArb, baseTableArb, (prefix, base) => {
        const store = new VectorStore(prefix);
        expect(store.getTableName(base)).toMatch(new RegExp(`${base}$`));
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 9: Query Prefix Consistency ─────────────────────────────────────

describe("Property 9: Query Prefix Consistency", () => {
  /**
   * For any database query constructed with a prefix, all table names in the
   * query SHALL be consistently prefixed with the same prefix.
   * Validates: Requirements 3.2
   */
  it("indexSymbol SQL contains the prefixed table name for any valid prefix", async () => {
    await fc.assert(
      fc.asyncProperty(validPrefixArb, async (prefix) => {
        const pool = makeMockPool();
        const store = new VectorStore(prefix);
        await store.indexSymbol(pool as never, "sym-1", makeEmbedding());

        const sqls = capturedSql(pool);
        expect(sqls.some((sql) => sql.includes(`${prefix}embeddings`))).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it("semanticSearch SQL contains the prefixed table name for any valid prefix", async () => {
    await fc.assert(
      fc.asyncProperty(validPrefixArb, async (prefix) => {
        const pool = makeMockPool();
        const store = new VectorStore(prefix);
        await store.semanticSearch(pool as never, makeEmbedding(), 5);

        const sqls = capturedSql(pool);
        expect(sqls.some((sql) => sql.includes(`${prefix}embeddings`))).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it("no bare base table name appears in SQL when prefix is non-empty", async () => {
    await fc.assert(
      fc.asyncProperty(validPrefixArb, async (prefix) => {
        const pool = makeMockPool();
        const store = new VectorStore(prefix);
        await store.indexSymbol(pool as never, "sym-1", makeEmbedding());

        const sqls = capturedSql(pool);
        // The table name must appear only as the prefixed form, never standalone
        for (const sql of sqls) {
          // Strip all occurrences of the prefixed table name, then check no bare name remains
          const stripped = sql.replaceAll(`${prefix}embeddings`, "");
          expect(stripped).not.toMatch(/\bembeddings\b/);
        }
      }),
      { numRuns: 50 },
    );
  });
});

// ─── 5.3 Integration test: tpc_-prefixed tables ───────────────────────────────

describe("Integration: tpc_-prefixed tables", () => {
  it("createTables SQL contains tpc_embeddings", async () => {
    const pool = makeMockPool();
    const store = new VectorStore("tpc_");
    await store.createTables(pool as never);

    const sqls = capturedSql(pool);
    expect(sqls.some((sql) => sql.includes("tpc_embeddings"))).toBe(true);
  });

  it("indexSymbol SQL contains tpc_embeddings", async () => {
    const pool = makeMockPool();
    const store = new VectorStore("tpc_");
    await store.indexSymbol(pool as never, "sym-1", makeEmbedding());

    const sqls = capturedSql(pool);
    expect(sqls.some((sql) => sql.includes("tpc_embeddings"))).toBe(true);
  });

  it("semanticSearch SQL contains tpc_embeddings", async () => {
    const pool = makeMockPool();
    const store = new VectorStore("tpc_");
    await store.semanticSearch(pool as never, makeEmbedding(), 10);

    const sqls = capturedSql(pool);
    expect(sqls.some((sql) => sql.includes("tpc_embeddings"))).toBe(true);
  });
});
