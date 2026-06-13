import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createSymbolTable, buildSymbolTable } from "./symbol-table.js";
import { symbolArbitrary } from "../../../../tests/support/arbitraries.js";

// ─── createSymbolTable ────────────────────────────────────────────────────────

describe("createSymbolTable", () => {
  it("add + lookupExact returns nodeId for registered symbol", () => {
    const t = createSymbolTable();
    t.add("src/a.ts", "Foo", "sym-1", "class");
    expect(t.lookupExact("src/a.ts", "Foo")).toBe("sym-1");
  });

  it("add + lookupExactFull returns full SymbolDefinition", () => {
    const t = createSymbolTable();
    t.add("src/a.ts", "Foo", "sym-1", "class");
    expect(t.lookupExactFull("src/a.ts", "Foo")).toEqual({
      nodeId: "sym-1",
      filePath: "src/a.ts",
      type: "class",
    });
  });

  it("lookupExact returns undefined for unknown name", () => {
    const t = createSymbolTable();
    expect(t.lookupExact("src/a.ts", "Unknown")).toBeUndefined();
  });

  it("lookupExactFull returns undefined for unknown name", () => {
    const t = createSymbolTable();
    expect(t.lookupExactFull("src/a.ts", "Unknown")).toBeUndefined();
  });

  it("lookupFuzzy returns all definitions across files", () => {
    const t = createSymbolTable();
    t.add("src/a.ts", "Helper", "sym-1", "class");
    t.add("src/b.ts", "Helper", "sym-2", "class");
    const results = t.lookupFuzzy("Helper");
    expect(results).toHaveLength(2);
    expect(results.map((d) => d.nodeId).sort()).toEqual(["sym-1", "sym-2"]);
  });

  it("lookupFuzzy returns empty array for unknown name", () => {
    const t = createSymbolTable();
    expect(t.lookupFuzzy("Ghost")).toEqual([]);
  });

  it("add with metadata stores parameterCount, returnType, ownerId", () => {
    const t = createSymbolTable();
    t.add("src/a.ts", "doWork", "sym-1", "function", {
      parameterCount: 2,
      returnType: "Promise<void>",
      ownerId: "sym-owner",
    });
    const def = t.lookupExactFull("src/a.ts", "doWork");
    expect(def?.parameterCount).toBe(2);
    expect(def?.returnType).toBe("Promise<void>");
    expect(def?.ownerId).toBe("sym-owner");
  });

  it("add without metadata leaves optional fields undefined", () => {
    const t = createSymbolTable();
    t.add("src/a.ts", "Foo", "sym-1", "class");
    const def = t.lookupExactFull("src/a.ts", "Foo");
    expect(def?.parameterCount).toBeUndefined();
    expect(def?.returnType).toBeUndefined();
    expect(def?.ownerId).toBeUndefined();
  });

  it("lookupExact is file-scoped when same name exists in multiple files", () => {
    const t = createSymbolTable();
    t.add("src/a.ts", "Helper", "sym-1", "class");
    t.add("src/b.ts", "Helper", "sym-2", "class");
    expect(t.lookupExact("src/a.ts", "Helper")).toBe("sym-1");
    expect(t.lookupExact("src/b.ts", "Helper")).toBe("sym-2");
  });

  it("lookupFuzzy returns both when same name exists in multiple files", () => {
    const t = createSymbolTable();
    t.add("src/a.ts", "Helper", "sym-1", "class");
    t.add("src/b.ts", "Helper", "sym-2", "class");
    expect(t.lookupFuzzy("Helper")).toHaveLength(2);
  });

  it("lookupExactFull and matching lookupFuzzy entry are the same object reference", () => {
    const t = createSymbolTable();
    t.add("src/a.ts", "Foo", "sym-1", "class");
    const full = t.lookupExactFull("src/a.ts", "Foo");
    const fuzzy = t.lookupFuzzy("Foo");
    expect(Object.is(full, fuzzy[0])).toBe(true);
  });

  it("clear empties both indexes", () => {
    const t = createSymbolTable();
    t.add("src/a.ts", "Foo", "sym-1", "class");
    t.clear();
    expect(t.lookupExact("src/a.ts", "Foo")).toBeUndefined();
    expect(t.lookupFuzzy("Foo")).toEqual([]);
    expect(t.getStats()).toEqual({ fileCount: 0, globalSymbolCount: 0 });
  });

  it("getStats reflects correct fileCount and globalSymbolCount", () => {
    const t = createSymbolTable();
    t.add("src/a.ts", "Foo", "sym-1", "class");
    t.add("src/a.ts", "Bar", "sym-2", "function");
    t.add("src/b.ts", "Baz", "sym-3", "class");
    expect(t.getStats()).toEqual({ fileCount: 2, globalSymbolCount: 3 });
  });
});

// ─── buildSymbolTable ─────────────────────────────────────────────────────────

describe("buildSymbolTable", () => {
  it("builds table from Symbol[] using Symbol.id as nodeId", () => {
    const sym = {
      id: "sym-1",
      name: "MyService",
      kind: "class" as const,
      visibility: "public" as const,
      modifiers: [],
      location: { filePath: "src/a.ts", startLine: 1, startColumn: 0, endLine: 10, endColumn: 0 },
    };
    const t = buildSymbolTable([sym]);
    expect(t.lookupExact("src/a.ts", "MyService")).toBe("sym-1");
  });

  it("returns empty table for empty array", () => {
    const t = buildSymbolTable([]);
    expect(t.getStats()).toEqual({ fileCount: 0, globalSymbolCount: 0 });
  });
});

// ─── Property: lookupFuzzy nodeIds belong to input symbol id set ──────────────

describe("Property: lookupFuzzy nodeIds are all from the input symbol set", () => {
  it("holds for any Symbol[]", () => {
    fc.assert(
      fc.property(
        fc.array(symbolArbitrary(), { minLength: 0, maxLength: 30 }),
        (symbols) => {
          const table = buildSymbolTable(symbols);
          const knownIds = new Set(symbols.map((s) => s.id));
          for (const sym of symbols) {
            const results = table.lookupFuzzy(sym.name);
            if (results.length === 0) return false;
            for (const def of results) {
              if (!knownIds.has(def.nodeId)) return false;
            }
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
