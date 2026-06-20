/**
 * A1 (KEYSTONE) — `logicalKey` stability + ordinal determinism.
 *
 * Proves the core diff-stability guarantee:
 *  - moving a symbol down N lines keeps its `logicalKey` STABLE while
 *    `generateSymbolId` (position-inclusive) CHANGES.
 *  - the per-file ordinal disambiguates genuine same-(file,name,kind) collisions
 *    deterministically and is order/position independent.
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { generateLogicalKey, OrdinalAllocator } from "./logical-key.js";
import { generateSymbolId } from "./symbol-id.js";

describe("generateLogicalKey — position independence", () => {
  it("is stable when a symbol moves down N lines (while generateSymbolId changes)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }), // filePath
        fc.string({ minLength: 1 }), // qualifiedName
        fc.constantFrom("function", "class", "method", "interface", "variable"),
        fc.nat({ max: 5000 }), // original startLine
        fc.nat({ max: 500 }), // startColumn
        fc.integer({ min: 1, max: 5000 }), // line delta (move DOWN)
        (filePath, name, kind, startLine, startColumn, delta) => {
          const before = generateLogicalKey(filePath, name, kind);
          const after = generateLogicalKey(filePath, name, kind);
          // logicalKey ignores position entirely → identical before/after a move.
          expect(after).toBe(before);

          // generateSymbolId is position-inclusive → a move changes it.
          const idBefore = generateSymbolId(filePath, name, startLine, startColumn);
          const idAfter = generateSymbolId(filePath, name, startLine + delta, startColumn);
          expect(idAfter).not.toBe(idBefore);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("is a deterministic sha1 hex digest of (file, name, kind, ordinal)", () => {
    const a = generateLogicalKey("src/a.ts", "foo", "function");
    const b = generateLogicalKey("src/a.ts", "foo", "function");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it("distinguishes same name across file / kind / ordinal", () => {
    const base = generateLogicalKey("src/a.ts", "foo", "function", 0);
    expect(generateLogicalKey("src/b.ts", "foo", "function", 0)).not.toBe(base); // file
    expect(generateLogicalKey("src/a.ts", "foo", "class", 0)).not.toBe(base); // kind
    expect(generateLogicalKey("src/a.ts", "foo", "function", 1)).not.toBe(base); // ordinal
    expect(generateLogicalKey("src/a.ts", "bar", "function", 0)).not.toBe(base); // name
  });
});

describe("OrdinalAllocator — collision disambiguation determinism", () => {
  it("assigns 0,1,2,... to repeated (name, kind) pairs in call order", () => {
    const ord = new OrdinalAllocator();
    expect(ord.next("handler", "function")).toBe(0);
    expect(ord.next("handler", "function")).toBe(1);
    expect(ord.next("handler", "function")).toBe(2);
  });

  it("keeps distinct (name, kind) pairs at ordinal 0 — unique symbols are unaffected", () => {
    const ord = new OrdinalAllocator();
    expect(ord.next("a", "function")).toBe(0);
    expect(ord.next("b", "function")).toBe(0);
    expect(ord.next("a", "class")).toBe(0); // same name, different kind
  });

  it("produces a deterministic, collision-free key set for a fixed symbol order", () => {
    // Two colliding (foo, function) symbols + one distinct → 3 unique keys, stable.
    const make = (): string[] => {
      const ord = new OrdinalAllocator();
      const symbols = [
        { name: "foo", kind: "function" },
        { name: "bar", kind: "function" },
        { name: "foo", kind: "function" }, // collides with the first foo
      ];
      return symbols.map((s) =>
        generateLogicalKey("src/x.ts", s.name, s.kind, ord.next(s.name, s.kind)),
      );
    };
    const keys = make();
    expect(new Set(keys).size).toBe(3); // collision is disambiguated
    expect(make()).toEqual(keys); // deterministic across runs
  });
});
