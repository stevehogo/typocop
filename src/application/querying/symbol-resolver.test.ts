/**
 * Unit tests for symbol-resolver.ts — exact, fuzzy, and not-found resolution.
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6, 2.1, 2.2
 */
import { describe, it, expect, vi } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import type { CypherNodeRow } from "./graph-helpers.js";
import { resolveSymbol, suggestSimilarSymbols } from "./symbol-resolver.js";

// ─── Factories ────────────────────────────────────────────────────────────────

/** Create a mock GraphAdapter with a controllable `runCypher` implementation. */
function getMockGraphAdapter(
  overrides?: Partial<GraphAdapter>,
): GraphAdapter {
  return {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn(),
    queryRelationships: vi.fn(),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher: vi.fn().mockResolvedValue([]),
    runCypherWrite: vi.fn(),
    ...overrides,
  };
}

/** Create a CypherNodeRow for a Symbol node with the given name and id. */
function getMockCypherNodeRow(
  overrides?: Partial<{ id: string; name: string; kind: string; filePath: string }>,
): CypherNodeRow {
  const id = overrides?.id ?? "sym-1";
  const name = overrides?.name ?? "myFunction";
  return {
    n: {
      labels: ["Symbol"],
      properties: {
        id,
        name,
        kind: overrides?.kind ?? "function",
        filePath: overrides?.filePath ?? "src/index.ts",
        startLine: "1",
        startColumn: "0",
        endLine: "10",
        endColumn: "1",
        visibility: "public",
      },
    },
  };
}

// ─── resolveSymbol ────────────────────────────────────────────────────────────

describe("resolveSymbol", () => {
  /**
   * Validates: Requirement 1.1 — exact match returns results for that symbol.
   * Validates: Requirement 1.6 — returns discriminated union with kind "exact".
   */
  it("returns kind 'exact' when graph has an exact match", async () => {
    const row = getMockCypherNodeRow({ id: "UserService", name: "UserService" });
    const graph = getMockGraphAdapter({
      runCypher: vi.fn().mockImplementation((query: string) => {
        if (!query.includes("CONTAINS")) return Promise.resolve([row]);
        return Promise.resolve([]);
      }),
    });

    const result = await resolveSymbol("UserService", graph);

    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.node.id).toBe("UserService");
    }
  });

  /**
   * Validates: Requirement 1.2 — fuzzy CONTAINS fallback when no exact match.
   * Validates: Requirement 1.3 — best fuzzy match is shortest name.
   * Validates: Requirement 1.6 — returns kind "fuzzy" with matchedName.
   */
  it("returns kind 'fuzzy' with shortest name when only CONTAINS matches exist", async () => {
    const longRow = getMockCypherNodeRow({ id: "s1", name: "UserServiceImpl" });
    const shortRow = getMockCypherNodeRow({ id: "s2", name: "UserService" });

    const graph = getMockGraphAdapter({
      runCypher: vi.fn().mockImplementation((query: string) => {
        if (query.includes("CONTAINS")) return Promise.resolve([longRow, shortRow]);
        return Promise.resolve([]); // no exact match
      }),
    });

    const result = await resolveSymbol("User", graph);

    expect(result.kind).toBe("fuzzy");
    if (result.kind === "fuzzy") {
      expect(result.matchedName).toBe("UserService");
      expect(result.node.id).toBe("s2");
    }
  });

  /**
   * Validates: Requirement 2.1 — not_found includes suggestions.
   * Validates: Requirement 1.6 — returns kind "not_found".
   */
  it("returns kind 'not_found' with suggestions when no match at all", async () => {
    const graph = getMockGraphAdapter({
      runCypher: vi.fn().mockImplementation((query: string) => {
        if (query.includes("DISTINCT")) {
          return Promise.resolve([
            { name: "UserService" },
            { name: "OrderService" },
          ]);
        }
        return Promise.resolve([]); // no exact or fuzzy match
      }),
    });

    const result = await resolveSymbol("Uzr", graph);

    expect(result.kind).toBe("not_found");
    if (result.kind === "not_found") {
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions.length).toBeLessThanOrEqual(5);
    }
  });

  /**
   * Validates: Requirement 1.4 — exact match takes precedence over fuzzy.
   */
  it("returns exact match even when fuzzy matches would also exist", async () => {
    const exactRow = getMockCypherNodeRow({ id: "User", name: "User" });
    const fuzzyRow = getMockCypherNodeRow({ id: "s2", name: "UserService" });

    const graph = getMockGraphAdapter({
      runCypher: vi.fn().mockImplementation((query: string) => {
        // Exact query returns a hit
        if (!query.includes("CONTAINS") && !query.includes("DISTINCT")) {
          return Promise.resolve([exactRow]);
        }
        // CONTAINS would also return hits — but should never be reached
        if (query.includes("CONTAINS")) {
          return Promise.resolve([fuzzyRow]);
        }
        return Promise.resolve([]);
      }),
    });

    const result = await resolveSymbol("User", graph);

    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.node.id).toBe("User");
    }
    // Verify CONTAINS query was never called (exact short-circuits)
    const calls = (graph.runCypher as ReturnType<typeof vi.fn>).mock.calls;
    const containsCalls = calls.filter((c: unknown[]) =>
      (c[0] as string).includes("CONTAINS"),
    );
    expect(containsCalls).toHaveLength(0);
  });
});

// ─── suggestSimilarSymbols ────────────────────────────────────────────────────

describe("suggestSimilarSymbols", () => {
  /**
   * Validates: Requirement 2.1 — suggestions never exceed limit of 5.
   */
  it("returns at most 5 suggestions even when many symbols exist", async () => {
    const names = Array.from({ length: 20 }, (_, i) => ({ name: `Symbol${i}` }));
    const graph = getMockGraphAdapter({
      runCypher: vi.fn().mockResolvedValue(names),
    });

    const result = await suggestSimilarSymbols("Symbl", graph, 5);

    expect(result.length).toBeLessThanOrEqual(5);
  });

  /**
   * Validates: Requirement 2.2 — suggestions ranked by ascending Levenshtein distance.
   */
  it("returns suggestions ordered by ascending edit distance", async () => {
    const graph = getMockGraphAdapter({
      runCypher: vi.fn().mockResolvedValue([
        { name: "zzzzz" },
        { name: "cat" },
        { name: "car" },
        { name: "bat" },
      ]),
    });

    const result = await suggestSimilarSymbols("cat", graph, 5);

    // "cat" should be first (distance 0), then "car"/"bat" (distance 1), then "zzzzz"
    expect(result[0]).toBe("cat");
    expect(result.indexOf("zzzzz")).toBeGreaterThan(result.indexOf("cat"));
  });

  it("returns empty array when graph has no symbols", async () => {
    const graph = getMockGraphAdapter({
      runCypher: vi.fn().mockResolvedValue([]),
    });

    const result = await suggestSimilarSymbols("anything", graph, 5);

    expect(result).toEqual([]);
  });
});

// ─── Property-Based Tests ─────────────────────────────────────────────────────

import * as fc from "fast-check";
import { levenshteinDistance } from "./levenshtein.js";

/**
 * Build a mock GraphAdapter that returns the given symbol names for all queries.
 * Exact/CONTAINS queries return CypherNodeRows; DISTINCT queries return { name }.
 */
function getMockGraphAdapterWithNames(names: string[]): GraphAdapter {
  const rows: CypherNodeRow[] = names.map((name, i) => ({
    n: {
      labels: ["Symbol"],
      properties: {
        id: `sym-${i}`,
        name,
        kind: "function",
        filePath: "src/index.ts",
        startLine: "1",
        startColumn: "0",
        endLine: "10",
        endColumn: "1",
        visibility: "public",
      },
    },
  }));

  return {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn(),
    queryRelationships: vi.fn(),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher: vi.fn().mockImplementation((query: string, params: Record<string, unknown>) => {
      const val = params?.val as string | undefined;

      // Exact match query
      if (!query.includes("CONTAINS") && !query.includes("DISTINCT") && val) {
        const exact = rows.filter(
          (r) => r.n.properties["id"] === val || r.n.properties["name"] === val,
        );
        return Promise.resolve(exact.slice(0, 1));
      }

      // CONTAINS query
      if (query.includes("CONTAINS") && val) {
        const matches = rows.filter((r) =>
          r.n.properties["name"]!.includes(val),
        );
        return Promise.resolve(matches);
      }

      // DISTINCT names query (for suggestions)
      if (query.includes("DISTINCT")) {
        return Promise.resolve(names.map((n) => ({ name: n })));
      }

      return Promise.resolve([]);
    }),
    runCypherWrite: vi.fn(),
  };
}

describe("resolveSymbol — property-based tests", () => {
  /**
   * **Validates: Requirements 1.6**
   * Property 10: Resolution exhaustiveness — resolveSymbol always returns one of
   * exactly three variants (never throws for a missing symbol).
   */
  it("always returns a valid SymbolResolution variant for any non-empty input", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 0, maxLength: 20 }),
        async (input, symbolNames) => {
          const graph = getMockGraphAdapterWithNames(symbolNames);
          const result = await resolveSymbol(input, graph);

          expect(["exact", "fuzzy", "not_found"]).toContain(result.kind);

          if (result.kind === "exact") {
            expect(result.node).toBeDefined();
            expect(result.node.id).toBeTruthy();
          } else if (result.kind === "fuzzy") {
            expect(result.node).toBeDefined();
            expect(result.matchedName).toBeTruthy();
          } else {
            expect(Array.isArray(result.suggestions)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("suggestSimilarSymbols — property-based tests", () => {
  /**
   * **Validates: Requirements 2.1**
   * Property 3: Suggestion limit — suggestSimilarSymbols(input, graph, limit)
   * returns at most `limit` results.
   */
  it("never returns more results than the specified limit", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 1, max: 20 }),
        async (input, symbolNames, limit) => {
          const graph = getMockGraphAdapterWithNames(symbolNames);
          const result = await suggestSimilarSymbols(input, graph, limit);

          expect(result.length).toBeLessThanOrEqual(limit);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.2**
   * Property 4: Suggestion ordering — suggestions are ordered by ascending
   * Levenshtein distance.
   */
  it("returns suggestions ordered by ascending Levenshtein distance", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 2, maxLength: 30 }),
        async (input, symbolNames) => {
          const graph = getMockGraphAdapterWithNames(symbolNames);
          const result = await suggestSimilarSymbols(input, graph, 10);

          const inputLower = input.toLowerCase();
          const distances = result.map((name) =>
            levenshteinDistance(inputLower, name.toLowerCase()),
          );

          for (let i = 1; i < distances.length; i++) {
            expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
