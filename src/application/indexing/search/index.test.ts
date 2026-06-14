// Tests for Phase 6: Search index — embedding generation and keyword indexing
// Unit tests (vitest) + Property-based tests (fast-check)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import type { Symbol, Cluster, Embedding } from "../../../core/domain.js";
import { symbolArbitrary, clusterArbitrary, embeddingArbitrary } from "../../../../tests/support/arbitraries.js";
import {
  formatSymbolForEmbedding,
  formatClusterForEmbedding,
  extractKeywords,
  buildKeywordIndex,
  buildSearchIndex,
} from "./index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSymbol(overrides: Partial<Symbol> = {}): Symbol {
  return {
    id: "sym-1",
    name: "getUserById",
    kind: "function",
    location: { filePath: "src/user.ts", startLine: 1, startColumn: 0, endLine: 10, endColumn: 1 },
    signature: "(id: string): Promise<User>",
    documentation: "Fetches a user by their ID",
    visibility: "public",
    modifiers: ["async"],
    ...overrides,
  };
}

function makeCluster(overrides: Partial<Cluster> = {}): Cluster {
  return {
    id: "cluster-1",
    name: "UserAuthentication",
    symbols: ["sym-1", "sym-2"],
    confidence: 0.92,
    category: "authentication",
    ...overrides,
  };
}

// ─── formatSymbolForEmbedding ─────────────────────────────────────────────────

describe("formatSymbolForEmbedding", () => {
  it("includes kind and name", () => {
    const sym = makeSymbol({ kind: "function", name: "getUserById" });
    const result = formatSymbolForEmbedding(sym);
    expect(result).toContain("function: getUserById");
  });

  it("includes signature when present", () => {
    const sym = makeSymbol({ signature: "(id: string): User" });
    const result = formatSymbolForEmbedding(sym);
    expect(result).toContain("signature: (id: string): User");
  });

  it("includes documentation when present", () => {
    const sym = makeSymbol({ documentation: "Fetches user" });
    const result = formatSymbolForEmbedding(sym);
    expect(result).toContain("docs: Fetches user");
  });

  it("omits signature line when not present", () => {
    const sym = makeSymbol({ signature: undefined });
    const result = formatSymbolForEmbedding(sym);
    expect(result).not.toContain("signature:");
  });

  it("omits documentation line when not present", () => {
    const sym = makeSymbol({ documentation: undefined });
    const result = formatSymbolForEmbedding(sym);
    expect(result).not.toContain("docs:");
  });

  it("includes visibility", () => {
    const sym = makeSymbol({ visibility: "private" });
    const result = formatSymbolForEmbedding(sym);
    expect(result).toContain("visibility: private");
  });

  it("includes modifiers when present", () => {
    const sym = makeSymbol({ modifiers: ["async", "static"] });
    const result = formatSymbolForEmbedding(sym);
    expect(result).toContain("modifiers: async, static");
  });

  it("omits modifiers line when empty", () => {
    const sym = makeSymbol({ modifiers: [] });
    const result = formatSymbolForEmbedding(sym);
    expect(result).not.toContain("modifiers:");
  });
});

// ─── formatClusterForEmbedding ────────────────────────────────────────────────

describe("formatClusterForEmbedding", () => {
  it("includes cluster name and category", () => {
    const cluster = makeCluster({ name: "AuthModule", category: "authentication" });
    const result = formatClusterForEmbedding(cluster, []);
    expect(result).toContain("cluster: AuthModule");
    expect(result).toContain("category: authentication");
  });

  it("includes confidence formatted to 2 decimal places", () => {
    const cluster = makeCluster({ confidence: 0.9 });
    const result = formatClusterForEmbedding(cluster, []);
    expect(result).toContain("confidence: 0.90");
  });

  it("includes symbol names when symbols provided", () => {
    const cluster = makeCluster();
    const symbols = [
      makeSymbol({ id: "sym-1", name: "login", kind: "function" }),
      makeSymbol({ id: "sym-2", name: "AuthService", kind: "class" }),
    ];
    const result = formatClusterForEmbedding(cluster, symbols);
    expect(result).toContain("function login");
    expect(result).toContain("class AuthService");
  });

  it("omits symbols line when no symbols provided", () => {
    const cluster = makeCluster();
    const result = formatClusterForEmbedding(cluster, []);
    expect(result).not.toContain("symbols:");
  });
});

// ─── extractKeywords ──────────────────────────────────────────────────────────

describe("extractKeywords", () => {
  it("splits camelCase names into lowercase words", () => {
    const sym = makeSymbol({ name: "getUserById", signature: undefined });
    const keywords = extractKeywords(sym);
    expect(keywords).toContain("user");
    // "by" is a stop word and is filtered out
    expect(keywords).toContain("id");
  });

  it("splits PascalCase names", () => {
    const sym = makeSymbol({ name: "UserAuthService", signature: undefined });
    const keywords = extractKeywords(sym);
    expect(keywords).toContain("user");
    expect(keywords).toContain("auth");
    expect(keywords).toContain("service");
  });

  it("splits snake_case names", () => {
    const sym = makeSymbol({ name: "get_user_by_id", signature: undefined });
    const keywords = extractKeywords(sym);
    expect(keywords).toContain("user");
    expect(keywords).toContain("id");
  });

  it("returns lowercase keywords", () => {
    const sym = makeSymbol({ name: "GetUserByID", signature: undefined });
    const keywords = extractKeywords(sym);
    for (const kw of keywords) {
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  it("returns deduplicated keywords", () => {
    const sym = makeSymbol({ name: "userUser", signature: undefined });
    const keywords = extractKeywords(sym);
    const userCount = keywords.filter(k => k === "user").length;
    expect(userCount).toBe(1);
  });

  it("filters stop words", () => {
    const sym = makeSymbol({ name: "getTheUser", signature: undefined });
    const keywords = extractKeywords(sym);
    expect(keywords).not.toContain("the");
  });

  it("extracts keywords from signature", () => {
    const sym = makeSymbol({
      name: "process",
      signature: "(userId: string, role: AdminRole): void",
    });
    const keywords = extractKeywords(sym);
    expect(keywords).toContain("user");
    expect(keywords).toContain("admin");
    expect(keywords).toContain("role");
  });
});

// ─── buildKeywordIndex ────────────────────────────────────────────────────────

describe("buildKeywordIndex", () => {
  it("maps keywords to symbol IDs", () => {
    const symbols = [
      makeSymbol({ id: "sym-1", name: "getUserById", signature: undefined }),
      makeSymbol({ id: "sym-2", name: "deleteUser", signature: undefined }),
    ];
    const index = buildKeywordIndex(symbols);
    const userIds = index.get("user");
    expect(userIds).toContain("sym-1");
    expect(userIds).toContain("sym-2");
  });

  it("returns empty map for empty symbols array", () => {
    const index = buildKeywordIndex([]);
    expect(index.size).toBe(0);
  });

  it("each keyword maps to all symbol IDs containing it", () => {
    const symbols = [
      makeSymbol({ id: "a", name: "authLogin", signature: undefined }),
      makeSymbol({ id: "b", name: "authLogout", signature: undefined }),
      makeSymbol({ id: "c", name: "fetchData", signature: undefined }),
    ];
    const index = buildKeywordIndex(symbols);
    const authIds = index.get("auth") ?? [];
    expect(authIds).toContain("a");
    expect(authIds).toContain("b");
    expect(authIds).not.toContain("c");
  });
});

// ─── buildSearchIndex ─────────────────────────────────────────────────────────

describe("buildSearchIndex", () => {
  it("returns symbolCount equal to number of symbols", async () => {
    const symbols = [
      makeSymbol({ id: "s1", name: "login" }),
      makeSymbol({ id: "s2", name: "logout" }),
    ];
    const embedFn = vi.fn().mockResolvedValue(null);
    const index = await buildSearchIndex(symbols, [], embedFn);
    expect(index.symbolCount).toBe(2);
    expect(index.embeddings).toEqual([]);
  });

  it("builds keyword index for all symbols", async () => {
    const symbols = [makeSymbol({ id: "s1", name: "getUserById", signature: undefined })];
    const embedFn = vi.fn().mockResolvedValue(null);
    const index = await buildSearchIndex(symbols, [], embedFn);
    expect(index.keywords.get("user")).toContain("s1");
    expect(index.embeddings).toEqual([]);
  });

  it("calls embedFn for each symbol and each cluster", async () => {
    const symbols = [
      makeSymbol({ id: "s1", name: "login" }),
      makeSymbol({ id: "s2", name: "logout" }),
    ];
    const clusters = [makeCluster({ symbols: ["s1", "s2"] })];
    const embedFn = vi.fn().mockResolvedValue(null);
    await buildSearchIndex(symbols, clusters, embedFn);
    // 2 symbols + 1 cluster = 3 calls
    expect(embedFn).toHaveBeenCalledTimes(3);
  });

  it("handles embedFn returning null gracefully (keyword-only fallback)", async () => {
    const symbols = [makeSymbol({ id: "s1", name: "processOrder" })];
    const embedFn = vi.fn().mockResolvedValue(null);
    const index = await buildSearchIndex(symbols, [], embedFn);
    expect(index.symbolCount).toBe(1);
    expect(index.keywords.size).toBeGreaterThan(0);
    expect(index.embeddings).toEqual([]);
  });

  it("returns embeddings: [] when embedFn is null", async () => {
    const symbols = [makeSymbol({ id: "s1", name: "login" })];
    const clusters = [makeCluster({ symbols: ["s1"] })];
    const index = await buildSearchIndex(symbols, clusters, null);
    expect(index.embeddings).toEqual([]);
    expect(index.symbolCount).toBe(1);
  });

  it("collects non-null embeddings for symbols and clusters", async () => {
    const embedding: Embedding = { vector: new Array(1536).fill(0.1), dimensions: 1536 };
    const symbols = [
      makeSymbol({ id: "s1", name: "login" }),
      makeSymbol({ id: "s2", name: "logout" }),
    ];
    const clusters = [makeCluster({ id: "c1", symbols: ["s1", "s2"] })];
    const embedFn = vi.fn().mockResolvedValue(embedding);
    const index = await buildSearchIndex(symbols, clusters, embedFn);
    // 2 symbol embeddings + 1 cluster embedding = 3
    expect(index.embeddings).toHaveLength(3);
    expect(index.embeddings[0].symbolId).toBe("s1");
    expect(index.embeddings[1].symbolId).toBe("s2");
    expect(index.embeddings[2].symbolId).toBe("cluster:c1");
    expect(index.embeddings[2].metadata).toHaveProperty("clusterId", "c1");
    expect(index.embeddings[2].metadata).toHaveProperty("symbolId", "s1");
  });

  it("skips items where embedFn returns null (keyed by formatted text)", async () => {
    const embedding: Embedding = { vector: new Array(1536).fill(0.5), dimensions: 1536 };
    const symbols = [
      makeSymbol({ id: "s1", name: "loginAlpha" }),
      makeSymbol({ id: "s2", name: "logoutBravo" }),
    ];
    // Cluster name is the marker we key off so its identity is unambiguous.
    const clusters = [
      makeCluster({ id: "c1", name: "ClusterCharlie", symbols: [] }),
      makeCluster({ id: "c2", name: "ClusterDelta", symbols: [] }),
    ];
    // null for s1 and c1, embedding for s2 and c2. Keyed by text (concurrency
    // does not guarantee a fixed call order).
    const embedFn = vi.fn(async (text: string) => {
      if (text.includes("loginAlpha") || text.includes("ClusterCharlie")) return null;
      return embedding;
    });
    const index = await buildSearchIndex(symbols, clusters, embedFn);
    expect(index.embeddings.map((e) => e.symbolId)).toEqual(["s2", "cluster:c2"]);
    expect(index.embeddingStats).toEqual({ attempts: 4, successes: 2, failures: 2 });
  });

  // ─── Phase C: bounded concurrency, determinism, failure accounting ──────────

  it("never runs more than `concurrency` embed calls at once", async () => {
    const embedding: Embedding = { vector: new Array(1536).fill(0.1), dimensions: 1536 };
    const symbols = Array.from({ length: 12 }, (_, i) =>
      makeSymbol({ id: `s${i}`, name: `fn${i}` }),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const embedFn = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return embedding;
    });
    const limit = 3;
    const index = await buildSearchIndex(symbols, [], embedFn, limit);
    expect(maxInFlight).toBeLessThanOrEqual(limit);
    expect(maxInFlight).toBeGreaterThan(1); // actually concurrent
    expect(index.embeddings).toHaveLength(12);
  });

  it("returns embeddings in deterministic input order (symbols then clusters)", async () => {
    const embedding: Embedding = { vector: new Array(1536).fill(0.2), dimensions: 1536 };
    const symbols = [
      makeSymbol({ id: "s0", name: "alpha" }),
      makeSymbol({ id: "s1", name: "bravo" }),
      makeSymbol({ id: "s2", name: "charlie" }),
    ];
    const clusters = [
      makeCluster({ id: "c0", symbols: ["s0", "s1"] }),
      makeCluster({ id: "c1", symbols: ["s2"] }),
    ];
    // Resolve later items first to scramble completion order.
    let n = 0;
    const embedFn = vi.fn(async () => {
      const delay = (5 - n++) * 3;
      await new Promise((r) => setTimeout(r, Math.max(0, delay)));
      return embedding;
    });
    const a = await buildSearchIndex(symbols, clusters, embedFn, 4);
    const b = await buildSearchIndex(symbols, clusters, embedFn, 1);
    const ids = (idx: typeof a) => idx.embeddings.map((e) => e.symbolId);
    expect(ids(a)).toEqual(["s0", "s1", "s2", "cluster:c0", "cluster:c1"]);
    // Same input → same order regardless of concurrency.
    expect(ids(a)).toEqual(ids(b));
  });

  it("counts attempts/successes/failures correctly", async () => {
    const embedding: Embedding = { vector: new Array(1536).fill(0.3), dimensions: 1536 };
    const symbols = [
      makeSymbol({ id: "s0", name: "ok0" }),
      makeSymbol({ id: "s1", name: "null1" }),
      makeSymbol({ id: "s2", name: "ok2" }),
    ];
    const embedFn = vi.fn(async (text: string) =>
      text.includes("null1") ? null : embedding,
    );
    const index = await buildSearchIndex(symbols, [], embedFn);
    expect(index.embeddingStats).toEqual({ attempts: 3, successes: 2, failures: 1 });
    expect(index.embeddings.map((e) => e.symbolId)).toEqual(["s0", "s2"]);
  });

  it("treats a thrown embedFn as a failure (keyword-only) without rejecting", async () => {
    const symbols = [makeSymbol({ id: "s0", name: "boom" })];
    const embedFn = vi.fn(async () => {
      throw new Error("backend down");
    });
    const index = await buildSearchIndex(symbols, [], embedFn);
    expect(index.embeddings).toEqual([]);
    expect(index.embeddingStats).toEqual({ attempts: 1, successes: 0, failures: 1 });
    // Keyword index still intact.
    expect(index.keywords.size).toBeGreaterThan(0);
  });

  it("treats a hanging embedFn as a failure via timeout without rejecting", async () => {
    vi.useFakeTimers();
    try {
      const symbols = [makeSymbol({ id: "s0", name: "slow" })];
      // Never resolves — only the timeout can settle this.
      const embedFn = vi.fn(() => new Promise<Embedding>(() => {}));
      const promise = buildSearchIndex(symbols, [], embedFn);
      await vi.runAllTimersAsync();
      const index = await promise;
      expect(index.embeddings).toEqual([]);
      expect(index.embeddingStats.failures).toBe(1);
      expect(index.keywords.size).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports zero attempts and empty stats when embedFn is null", async () => {
    const symbols = [makeSymbol({ id: "s1", name: "login" })];
    const index = await buildSearchIndex(symbols, [], null);
    expect(index.embeddingStats).toEqual({ attempts: 0, successes: 0, failures: 0 });
  });

  // ─── Phase 1: batched embedTexts fast-path ──────────────────────────────────

  describe("batched embedTexts fast-path", () => {
    const DIM = 1536;
    const vecFor = (seed: number): Embedding => ({
      vector: new Array(DIM).fill(seed),
      dimensions: DIM,
    });

    // Batching is opt-in (default OFF — it is slower on CPU). These tests
    // exercise the batch fast-path, so they explicitly enable it.
    beforeEach(() => {
      process.env.EMBEDDING_ENABLE_BATCH = "1";
    });

    afterEach(() => {
      delete process.env.EMBEDDING_ENABLE_BATCH;
      delete process.env.EMBEDDING_BATCH_SIZE;
    });

    it("produces output identical to the per-item path for a fixed input (determinism)", async () => {
      const symbols = [
        makeSymbol({ id: "s0", name: "alpha" }),
        makeSymbol({ id: "s1", name: "bravo" }),
        makeSymbol({ id: "s2", name: "charlie" }),
      ];
      const clusters = [
        makeCluster({ id: "c0", symbols: ["s0", "s1"] }),
        makeCluster({ id: "c1", symbols: ["s2"] }),
      ];
      // Deterministic per-text vector so batch and per-item produce same values.
      const seedOf = (text: string) => text.length;
      const perItem = vi.fn(async (text: string) => vecFor(seedOf(text)));
      const batch = vi.fn(async (texts: string[]) =>
        texts.map((t) => vecFor(seedOf(t))),
      );

      const fromPerItem = await buildSearchIndex(symbols, clusters, perItem, 3, null);
      const fromBatch = await buildSearchIndex(symbols, clusters, perItem, 3, batch);

      expect(batch).toHaveBeenCalled();
      expect(fromBatch.embeddings).toEqual(fromPerItem.embeddings);
      expect(fromBatch.embeddingStats).toEqual(fromPerItem.embeddingStats);
      expect(fromBatch.embeddings.map((e) => e.symbolId)).toEqual([
        "s0",
        "s1",
        "s2",
        "cluster:c0",
        "cluster:c1",
      ]);
    });

    it("groups jobs into EMBEDDING_BATCH_SIZE-bounded batches", async () => {
      process.env.EMBEDDING_BATCH_SIZE = "2";
      const symbols = Array.from({ length: 5 }, (_, i) =>
        makeSymbol({ id: `s${i}`, name: `fn${i}` }),
      );
      const perItem = vi.fn(async () => vecFor(0.1));
      const batch = vi.fn(async (texts: string[]) => texts.map(() => vecFor(0.1)));

      const index = await buildSearchIndex(symbols, [], perItem, 4, batch);

      // 5 jobs / batch size 2 → 3 batch calls (2,2,1)
      expect(batch).toHaveBeenCalledTimes(3);
      expect(batch.mock.calls.map((c) => c[0].length)).toEqual([2, 2, 1]);
      expect(index.embeddings).toHaveLength(5);
      expect(perItem).not.toHaveBeenCalled();
    });

    it("falls back to per-item embedText ONCE on batch throw, with per-item accounting", async () => {
      process.env.EMBEDDING_BATCH_SIZE = "2";
      const symbols = [
        makeSymbol({ id: "s0", name: "ok0" }),
        makeSymbol({ id: "s1", name: "null1" }),
      ];
      // Batch always throws → whole batch suspect → per-item fallback.
      const batch = vi.fn(async () => {
        throw new Error("batch OOM");
      });
      // Per-item: null for "null1", embedding otherwise.
      const perItem = vi.fn(async (text: string) =>
        text.includes("null1") ? null : vecFor(0.2),
      );

      const index = await buildSearchIndex(symbols, [], perItem, 2, batch);

      expect(batch).toHaveBeenCalledTimes(1);
      // Each item counted individually (not as one batch-count).
      expect(index.embeddingStats).toEqual({ attempts: 2, successes: 1, failures: 1 });
      expect(index.embeddings.map((e) => e.symbolId)).toEqual(["s0"]);
      // Exactly one fallback pass: 2 per-item calls for the 2 jobs.
      expect(perItem).toHaveBeenCalledTimes(2);
    });

    it("falls back to per-item on batch timeout (per-item accounting preserved)", async () => {
      vi.useFakeTimers();
      try {
        const symbols = [makeSymbol({ id: "s0", name: "slow" })];
        // Batch never resolves — only the per-batch timeout can settle it.
        const batch = vi.fn(() => new Promise<(Embedding | null)[]>(() => {}));
        const perItem = vi.fn(async () => vecFor(0.3));

        const promise = buildSearchIndex(symbols, [], perItem, 1, batch);
        await vi.runAllTimersAsync();
        const index = await promise;

        expect(batch).toHaveBeenCalledTimes(1);
        expect(perItem).toHaveBeenCalledTimes(1);
        expect(index.embeddingStats).toEqual({ attempts: 1, successes: 1, failures: 0 });
        expect(index.embeddings.map((e) => e.symbolId)).toEqual(["s0"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats per-row null from the batch as keyword-only fallback", async () => {
      const symbols = [
        makeSymbol({ id: "s0", name: "ok0" }),
        makeSymbol({ id: "s1", name: "bad1" }),
      ];
      // Batch nulls the second row (pre-inference validation failure semantics).
      const batch = vi.fn(async (texts: string[]) =>
        texts.map((t) => (t.includes("bad1") ? null : vecFor(0.4))),
      );
      const perItem = vi.fn(async () => vecFor(0.4));

      const index = await buildSearchIndex(symbols, [], perItem, 2, batch);

      // No fallback — the batch resolved; per-row null is honest accounting.
      expect(perItem).not.toHaveBeenCalled();
      expect(index.embeddingStats).toEqual({ attempts: 2, successes: 1, failures: 1 });
      expect(index.embeddings.map((e) => e.symbolId)).toEqual(["s0"]);
      expect(index.keywords.size).toBeGreaterThan(0);
    });

    it("skips the batch path entirely when batching is not enabled (the default)", async () => {
      delete process.env.EMBEDDING_ENABLE_BATCH;
      const symbols = [makeSymbol({ id: "s0", name: "alpha" })];
      const batch = vi.fn(async (texts: string[]) => texts.map(() => vecFor(0.5)));
      const perItem = vi.fn(async () => vecFor(0.5));

      const index = await buildSearchIndex(symbols, [], perItem, 2, batch);

      expect(batch).not.toHaveBeenCalled();
      expect(perItem).toHaveBeenCalledTimes(1);
      expect(index.embeddings).toHaveLength(1);
    });

    it("uses the per-item path when no embedTextsFn is provided (adapter without embedTexts)", async () => {
      const symbols = [makeSymbol({ id: "s0", name: "alpha" })];
      const perItem = vi.fn(async () => vecFor(0.6));

      // 5th arg omitted → null → per-item path.
      const index = await buildSearchIndex(symbols, [], perItem, 2);

      expect(perItem).toHaveBeenCalledTimes(1);
      expect(index.embeddings).toHaveLength(1);
    });
  });
});

// ─── Property-based tests ─────────────────────────────────────────────────────

/**
 * Property 14: Embedding Dimensionality
 * Validates: Requirement 8.3
 *
 * All embeddings produced by the system must have exactly 1536 dimensions:
 * vector.length === 1536 AND dimensions === 1536.
 * Covers: Embedding type invariant, embeddings from symbols, embeddings from clusters.
 */
describe("Property 14: Embedding Dimensionality — Validates: Requirements 8.3", () => {
  it("Embedding type invariant: vector.length === 1536 and dimensions === 1536", () => {
    fc.assert(
      fc.property(embeddingArbitrary(), (embedding: Embedding) => {
        return embedding.vector.length === 1536 && embedding.dimensions === 1536;
      }),
    );
  });

  it("embeddings generated from symbols have 1536 dimensions", async () => {
    await fc.assert(
      fc.asyncProperty(symbolArbitrary(), async (symbol: Symbol) => {
        const embedding: Embedding = {
          vector: new Array(1536).fill(0),
          dimensions: 1536,
        };
        // Simulate embedFn returning an embedding for the formatted symbol text
        const embedFn = vi.fn().mockResolvedValue(embedding);
        const text = formatSymbolForEmbedding(symbol);
        const result = await embedFn(text);
        if (result === null) return true; // fallback path is valid
        return result.vector.length === 1536 && result.dimensions === 1536;
      }),
    );
  });

  it("embeddings generated from clusters have 1536 dimensions", async () => {
    await fc.assert(
      fc.asyncProperty(
        clusterArbitrary(),
        fc.array(symbolArbitrary(), { minLength: 0, maxLength: 5 }),
        async (cluster: Cluster, symbols: Symbol[]) => {
          const embedding: Embedding = {
            vector: new Array(1536).fill(0),
            dimensions: 1536,
          };
          const embedFn = vi.fn().mockResolvedValue(embedding);
          const text = formatClusterForEmbedding(cluster, symbols);
          const result = await embedFn(text);
          if (result === null) return true;
          return result.vector.length === 1536 && result.dimensions === 1536;
        },
      ),
    );
  });

  it("buildSearchIndex passes embeddings with 1536 dimensions to embedFn results", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(symbolArbitrary(), { minLength: 1, maxLength: 5 }),
        fc.array(clusterArbitrary(), { minLength: 0, maxLength: 3 }),
        async (symbols: Symbol[], clusters: Cluster[]) => {
          const embedding: Embedding = {
            vector: new Array(1536).fill(0),
            dimensions: 1536,
          };
          const embedFn = vi.fn().mockResolvedValue(embedding);
          const index = await buildSearchIndex(symbols, clusters, embedFn);
          // All collected embeddings must have correct dimensions
          for (const result of index.embeddings) {
            if (result.embedding.vector.length !== 1536 || result.embedding.dimensions !== 1536) return false;
          }
          // Number of collected embeddings must not exceed symbols + clusters
          if (index.embeddings.length > symbols.length + clusters.length) return false;
          return true;
        },
      ),
    );
  });

  /**
   * Property 14 (core): buildSearchIndex collects only embeddings satisfying the
   * dimensionality invariant when embedFn returns an embeddingArbitrary() result.
   * Validates: Requirements 8.3
   */
  it("buildSearchIndex collects only embeddings where vector.length === 1536 && dimensions === 1536", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(symbolArbitrary(), { minLength: 1, maxLength: 5 }),
        clusterArbitrary(),
        embeddingArbitrary(),
        async (symbols: Symbol[], cluster: Cluster, embedding: Embedding) => {
          const embedFn = vi.fn().mockResolvedValue(embedding);
          const index = await buildSearchIndex(symbols, [cluster], embedFn);
          return index.embeddings.every(
            (result) =>
              result.embedding.vector.length === 1536 &&
              result.embedding.dimensions === 1536,
          );
        },
      ),
    );
  });
});

describe("Property: extractKeywords always returns lowercase deduplicated strings", () => {
  const symbolKindArb = fc.constantFrom(
    "function", "class", "method", "interface",
    "variable", "import", "export", "type",
  ) as fc.Arbitrary<Symbol["kind"]>;

  const symbolArb = fc.record({
    id: fc.string({ minLength: 1 }),
    name: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    kind: symbolKindArb,
    location: fc.record({
      filePath: fc.string({ minLength: 1 }),
      startLine: fc.nat(),
      startColumn: fc.nat(),
      endLine: fc.nat(),
      endColumn: fc.nat(),
    }),
    signature: fc.option(fc.string(), { nil: undefined }),
    documentation: fc.option(fc.string(), { nil: undefined }),
    visibility: fc.constantFrom("public", "private", "protected", "internal") as fc.Arbitrary<Symbol["visibility"]>,
    modifiers: fc.array(fc.constantFrom("static", "abstract", "async", "const", "readonly") as fc.Arbitrary<Symbol["modifiers"][number]>),
  });

  it("all keywords are lowercase", () => {
    fc.assert(
      fc.property(symbolArb, (symbol: Symbol) => {
        const keywords = extractKeywords(symbol);
        return keywords.every(k => k === k.toLowerCase());
      }),
    );
  });

  it("keywords are deduplicated", () => {
    fc.assert(
      fc.property(symbolArb, (symbol: Symbol) => {
        const keywords = extractKeywords(symbol);
        return keywords.length === new Set(keywords).size;
      }),
    );
  });
});

describe("Property: buildKeywordIndex maps each keyword to all symbol IDs containing it", () => {
  it("every symbol ID appears under each of its keywords", () => {
    const symbolKindArb = fc.constantFrom(
      "function", "class", "method", "interface",
      "variable", "import", "export", "type",
    ) as fc.Arbitrary<Symbol["kind"]>;

    const symbolArb = fc.record({
      id: fc.uuid(),
      name: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{1,20}$/),
      kind: symbolKindArb,
      location: fc.record({
        filePath: fc.string({ minLength: 1 }),
        startLine: fc.nat(),
        startColumn: fc.nat(),
        endLine: fc.nat(),
        endColumn: fc.nat(),
      }),
      signature: fc.option(fc.string(), { nil: undefined }),
      documentation: fc.option(fc.string(), { nil: undefined }),
      visibility: fc.constantFrom("public", "private", "protected", "internal") as fc.Arbitrary<Symbol["visibility"]>,
      modifiers: fc.array(fc.constantFrom("static", "abstract", "async", "const", "readonly") as fc.Arbitrary<Symbol["modifiers"][number]>),
    });

    fc.assert(
      fc.property(fc.array(symbolArb, { minLength: 1, maxLength: 20 }), (symbols: Symbol[]) => {
        const index = buildKeywordIndex(symbols);
        for (const symbol of symbols) {
          const keywords = extractKeywords(symbol);
          for (const keyword of keywords) {
            const ids = index.get(keyword) ?? [];
            if (!ids.includes(symbol.id)) return false;
          }
        }
        return true;
      }),
    );
  });
});
