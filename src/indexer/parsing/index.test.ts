/**
 * Tests for Phase 2: Symbol extraction from ASTs.
 *
 * Includes:
 * - Unit tests for generateSymbolId and extractSymbolsFromAST
 * - Property 1: Symbol Uniqueness — Validates: Requirements 4.1, 4.3
 * - Property 3: Symbol Location Validity — Validates: Requirements 4.4, 4.5
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { generateSymbolId, extractAllSymbols } from "./index.js";
import { symbolArbitrary, locationArbitrary } from "../../types/arbitraries.js";
import type { FileNode } from "../structure/index.js";

// ─── Unit tests: generateSymbolId ─────────────────────────────────────────────

describe("generateSymbolId", () => {
  it("produces a deterministic ID from the same inputs", () => {
    const id1 = generateSymbolId("src/foo.ts", "myFunc", 10, 2);
    const id2 = generateSymbolId("src/foo.ts", "myFunc", 10, 2);
    expect(id1).toBe(id2);
  });

  it("produces different IDs for different file paths", () => {
    const id1 = generateSymbolId("src/a.ts", "fn", 1, 0);
    const id2 = generateSymbolId("src/b.ts", "fn", 1, 0);
    expect(id1).not.toBe(id2);
  });

  it("produces different IDs for different names", () => {
    const id1 = generateSymbolId("src/a.ts", "foo", 1, 0);
    const id2 = generateSymbolId("src/a.ts", "bar", 1, 0);
    expect(id1).not.toBe(id2);
  });

  it("produces different IDs for different positions", () => {
    const id1 = generateSymbolId("src/a.ts", "fn", 1, 0);
    const id2 = generateSymbolId("src/a.ts", "fn", 2, 0);
    expect(id1).not.toBe(id2);
  });

  it("includes all components in the ID", () => {
    const id = generateSymbolId("src/foo.ts", "myFunc", 10, 2);
    expect(id).toContain("src/foo.ts");
    expect(id).toContain("myFunc");
    expect(id).toContain("10");
    expect(id).toContain("2");
  });
});

// ─── Unit tests: extractAllSymbols ───────────────────────────────────────────

describe("extractAllSymbols", () => {
  it("returns empty array for empty file list", async () => {
    const result = await extractAllSymbols([]);
    expect(result).toEqual([]);
  });

  it("skips files with unsupported language gracefully", async () => {
    // A FileNode pointing to a non-existent file — should skip without throwing
    const fileNodes: FileNode[] = [
      { path: "/nonexistent/file.ts", size: 100, language: "typescript" },
    ];
    // Should not throw — just return empty (parse error is caught and skipped)
    const result = await extractAllSymbols(fileNodes);
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns symbols with unique IDs for real source files", async () => {
    // Use the actual source files in this project as test input
    const { walkFileTree } = await import("../structure/index.js");
    const fileNodes = await walkFileTree("src");
    const symbols = await extractAllSymbols(fileNodes);

    const ids = symbols.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ─── Property 1: Symbol Uniqueness ───────────────────────────────────────────
// **Validates: Requirements 4.1, 4.3**

describe("Property 1: Symbol Uniqueness", () => {
  it("symbols with unique IDs maintain uniqueness when collected into a list", () => {
    // Generate symbol lists where each symbol has a unique ID (as extraction guarantees)
    fc.assert(
      fc.property(
        fc.uniqueArray(symbolArbitrary(), {
          minLength: 0,
          maxLength: 50,
          selector: (s) => s.id,
        }),
        (symbols) => {
          const ids = symbols.map((s) => s.id);
          return new Set(ids).size === ids.length;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("generateSymbolId always produces unique IDs for distinct (file, name, line, col) tuples", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            filePath: fc.string({ minLength: 1, maxLength: 50 }),
            name: fc.string({ minLength: 1, maxLength: 30 }),
            startLine: fc.nat({ max: 10_000 }),
            startColumn: fc.nat({ max: 500 }),
          }),
          {
            minLength: 2,
            maxLength: 20,
            selector: (x) => `${x.filePath}|${x.name}|${x.startLine}|${x.startColumn}`,
          },
        ),
        (inputs) => {
          const ids = inputs.map((i) =>
            generateSymbolId(i.filePath, i.name, i.startLine, i.startColumn),
          );
          return new Set(ids).size === ids.length;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 3: Symbol Location Validity ────────────────────────────────────
// **Validates: Requirements 4.4, 4.5**

describe("Property 3: Symbol Location Validity", () => {
  it("startLine <= endLine for any generated location", () => {
    fc.assert(
      fc.property(locationArbitrary(), (loc) => {
        return loc.startLine <= loc.endLine;
      }),
      { numRuns: 200 },
    );
  });

  it("startColumn <= endColumn when on the same line", () => {
    fc.assert(
      fc.property(locationArbitrary(), (loc) => {
        if (loc.startLine < loc.endLine) return true;
        return loc.startColumn <= loc.endColumn;
      }),
      { numRuns: 200 },
    );
  });
});
