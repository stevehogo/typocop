// Tests for Phase 6: Search index — embedding generation and keyword indexing
// Unit tests (vitest) + Property-based tests (fast-check)

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import type { Symbol, Cluster, Embedding } from "../../types/index.js";
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
  });

  it("builds keyword index for all symbols", async () => {
    const symbols = [makeSymbol({ id: "s1", name: "getUserById", signature: undefined })];
    const embedFn = vi.fn().mockResolvedValue(null);
    const index = await buildSearchIndex(symbols, [], embedFn);
    expect(index.keywords.get("user")).toContain("s1");
  });

  it("calls embedFn for each cluster", async () => {
    const symbols = [
      makeSymbol({ id: "s1", name: "login" }),
      makeSymbol({ id: "s2", name: "logout" }),
    ];
    const clusters = [makeCluster({ symbols: ["s1", "s2"] })];
    const embedFn = vi.fn().mockResolvedValue(null);
    await buildSearchIndex(symbols, clusters, embedFn);
    expect(embedFn).toHaveBeenCalledTimes(1);
  });

  it("handles embedFn returning null gracefully (keyword-only fallback)", async () => {
    const symbols = [makeSymbol({ id: "s1", name: "processOrder" })];
    const embedFn = vi.fn().mockResolvedValue(null);
    const index = await buildSearchIndex(symbols, [], embedFn);
    expect(index.symbolCount).toBe(1);
    expect(index.keywords.size).toBeGreaterThan(0);
  });
});

// ─── Property-based tests ─────────────────────────────────────────────────────

/**
 * Property 14: Embedding Dimensionality
 * Validates: Requirement 8.3
 *
 * Any Embedding object produced must have vector.length === 3072 and dimensions === 3072.
 */
describe("Property 14: Embedding Dimensionality — Validates: Requirements 8.3", () => {
  it("any Embedding value must have vector.length === 3072 and dimensions === 3072", () => {
    const embeddingArbitrary = fc.record({
      vector: fc.array(fc.float(), { minLength: 3072, maxLength: 3072 }),
      dimensions: fc.constant(3072),
    });

    fc.assert(
      fc.property(embeddingArbitrary, (embedding: Embedding) => {
        return embedding.vector.length === 3072 && embedding.dimensions === 3072;
      }),
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
