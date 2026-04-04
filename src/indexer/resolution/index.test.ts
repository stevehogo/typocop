/**
 * Tests for Phase 3: Reference resolution.
 *
 * Includes:
 * - Unit tests for all resolution functions (AAA pattern)
 * - Property 2: Relationship Validity — all resolved relationships reference
 *   existing symbols (Validates: Requirements 5.5, 5.7)
 *
 * Requirements: 3.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { SymbolKind } from "../../types/index.js";
import {
  buildSymbolMap,
  findImports,
  resolveImport,
  resolveImports,
  findCalls,
  resolveCall,
  resolveCalls,
  findClasses,
  findInterfaces,
  resolveInheritance,
  resolveImplementations,
  resolveReferences,
} from "./index.js";
import { symbolArbitrary } from "../../types/arbitraries.js";
import type { Symbol } from "../../types/index.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeSymbol(overrides: Partial<Symbol> & Pick<Symbol, "id" | "name" | "kind">): Symbol {
  return {
    visibility: "public",
    modifiers: [],
    location: {
      filePath: "src/test.ts",
      startLine: 1,
      startColumn: 0,
      endLine: 5,
      endColumn: 0,
    },
    ...overrides,
  };
}

// ─── buildSymbolMap ───────────────────────────────────────────────────────────

describe("buildSymbolMap", () => {
  it("returns empty map for empty symbol list", () => {
    // Arrange
    const symbols: Symbol[] = [];
    // Act
    const map = buildSymbolMap(symbols);
    // Assert
    expect(map.size).toBe(0);
  });

  it("indexes symbols by name for O(1) lookup", () => {
    // Arrange
    const sym = makeSymbol({ id: "a", name: "MyClass", kind: "class" });
    // Act
    const map = buildSymbolMap([sym]);
    // Assert
    expect(map.get("MyClass")).toEqual([sym]);
  });

  it("groups multiple symbols under the same name", () => {
    // Arrange
    const sym1 = makeSymbol({ id: "a1", name: "foo", kind: "function" });
    const sym2 = makeSymbol({ id: "a2", name: "foo", kind: "function" });
    // Act
    const map = buildSymbolMap([sym1, sym2]);
    // Assert
    expect(map.get("foo")).toHaveLength(2);
  });

  it("does not mix symbols with different names", () => {
    // Arrange
    const sym1 = makeSymbol({ id: "x", name: "alpha", kind: "function" });
    const sym2 = makeSymbol({ id: "y", name: "beta", kind: "function" });
    // Act
    const map = buildSymbolMap([sym1, sym2]);
    // Assert
    expect(map.get("alpha")).toHaveLength(1);
    expect(map.get("beta")).toHaveLength(1);
  });
});

// ─── findImports ──────────────────────────────────────────────────────────────

describe("findImports", () => {
  it("returns only symbols with kind 'import'", () => {
    // Arrange
    const imp = makeSymbol({ id: "i1", name: "lodash", kind: "import" });
    const fn = makeSymbol({ id: "f1", name: "myFn", kind: "function" });
    // Act
    const result = findImports([imp, fn]);
    // Assert
    expect(result).toEqual([imp]);
  });

  it("returns empty array when no imports exist", () => {
    // Arrange
    const fn = makeSymbol({ id: "f1", name: "myFn", kind: "function" });
    // Act
    const result = findImports([fn]);
    // Assert
    expect(result).toHaveLength(0);
  });
});

// ─── resolveImport ────────────────────────────────────────────────────────────

describe("resolveImport", () => {
  it("returns target symbol when exact name matches", () => {
    // Arrange
    const target = makeSymbol({ id: "t1", name: "MyService", kind: "class" });
    const importSym = makeSymbol({ id: "i1", name: "MyService", kind: "import" });
    const map = buildSymbolMap([target]);
    // Act
    const result = resolveImport(importSym, map);
    // Assert
    expect(result).toEqual(target);
  });

  it("returns undefined when import cannot be resolved", () => {
    // Arrange
    const importSym = makeSymbol({ id: "i1", name: "NonExistent", kind: "import" });
    const map = new Map();
    // Act
    const result = resolveImport(importSym, map);
    // Assert
    expect(result).toBeUndefined();
  });

  it("resolves by last path segment of import name", () => {
    // Arrange
    const target = makeSymbol({ id: "t1", name: "foo", kind: "function" });
    const importSym = makeSymbol({ id: "i1", name: "./utils/foo", kind: "import" });
    const map = buildSymbolMap([target]);
    // Act
    const result = resolveImport(importSym, map);
    // Assert
    expect(result).toEqual(target);
  });

  it("marks relationship as unresolved in metadata via resolveImports", () => {
    // Arrange
    const importSym = makeSymbol({ id: "i1", name: "MissingModule", kind: "import" });
    const map = new Map<string, Symbol[]>();
    // Act
    const rels = resolveImports([importSym], map);
    // Assert
    expect(rels).toHaveLength(1);
    expect(rels[0].metadata["unresolved"]).toBe("true");
  });
});

// ─── resolveImports ───────────────────────────────────────────────────────────

describe("resolveImports", () => {
  it("creates Imports relationship for resolved import", () => {
    // Arrange
    const target = makeSymbol({ id: "t1", name: "Logger", kind: "class" });
    const importSym = makeSymbol({ id: "i1", name: "Logger", kind: "import" });
    const map = buildSymbolMap([target]);
    // Act
    const rels = resolveImports([importSym], map);
    // Assert
    expect(rels).toHaveLength(1);
    expect(rels[0].relType).toBe("imports");
    expect(rels[0].source).toBe("i1");
    expect(rels[0].target).toBe("t1");
    expect(rels[0].metadata["unresolved"]).toBeUndefined();
  });

  it("creates Imports relationship with unresolved flag for missing targets", () => {
    // Arrange
    const importSym = makeSymbol({ id: "i1", name: "GhostModule", kind: "import" });
    const map = new Map<string, Symbol[]>();
    // Act
    const rels = resolveImports([importSym], map);
    // Assert
    expect(rels[0].metadata["unresolved"]).toBe("true");
    expect(rels[0].relType).toBe("imports");
  });

  it("returns empty array when no import symbols exist", () => {
    // Arrange
    const fn = makeSymbol({ id: "f1", name: "fn", kind: "function" });
    const map = buildSymbolMap([fn]);
    // Act
    const rels = resolveImports([fn], map);
    // Assert
    expect(rels).toHaveLength(0);
  });
});

// ─── findCalls ────────────────────────────────────────────────────────────────

describe("findCalls", () => {
  it("returns function and method symbols as call candidates", () => {
    // Arrange
    const fn = makeSymbol({ id: "f1", name: "doWork", kind: "function" });
    const method = makeSymbol({ id: "m1", name: "execute", kind: "method" });
    const cls = makeSymbol({ id: "c1", name: "MyClass", kind: "class" });
    // Act
    const result = findCalls([fn, method, cls]);
    // Assert
    expect(result).toContain(fn);
    expect(result).toContain(method);
    expect(result).not.toContain(cls);
  });
});

// ─── resolveCall ──────────────────────────────────────────────────────────────

describe("resolveCall", () => {
  it("resolves call target from signature annotation", () => {
    // Arrange
    const caller = makeSymbol({
      id: "f1",
      name: "handler",
      kind: "function",
      signature: "calls: logger",
    });
    const target = makeSymbol({ id: "t1", name: "logger", kind: "function" });
    const map = buildSymbolMap([caller, target]);
    // Act
    const result = resolveCall(caller, map);
    // Assert
    expect(result).toEqual(target);
  });

  it("returns undefined when signature has no call annotation", () => {
    // Arrange
    const caller = makeSymbol({ id: "f1", name: "handler", kind: "function", signature: "(): void" });
    const map = new Map<string, Symbol[]>();
    // Act
    const result = resolveCall(caller, map);
    // Assert
    expect(result).toBeUndefined();
  });

  it("does not resolve self-reference", () => {
    // Arrange
    const fn = makeSymbol({ id: "f1", name: "recurse", kind: "function", signature: "calls: recurse" });
    const map = buildSymbolMap([fn]);
    // Act
    const result = resolveCall(fn, map);
    // Assert
    expect(result).toBeUndefined();
  });
});

// ─── resolveCalls ─────────────────────────────────────────────────────────────

describe("resolveCalls", () => {
  it("creates Calls relationship for resolvable call", () => {
    // Arrange
    const caller = makeSymbol({
      id: "f1",
      name: "handler",
      kind: "function",
      signature: "calls: logger",
    });
    const callee = makeSymbol({ id: "t1", name: "logger", kind: "function" });
    const map = buildSymbolMap([caller, callee]);
    // Act
    const rels = resolveCalls([caller, callee], map);
    // Assert
    expect(rels).toHaveLength(1);
    expect(rels[0].relType).toBe("calls");
    expect(rels[0].source).toBe("f1");
    expect(rels[0].target).toBe("t1");
  });

  it("deduplicates calls to the same target", () => {
    // Arrange — two identical callers targeting the same callee
    const caller1 = makeSymbol({ id: "f1", name: "a", kind: "function", signature: "calls: target" });
    const caller2 = makeSymbol({ id: "f2", name: "b", kind: "function", signature: "calls: target" });
    const callee = makeSymbol({ id: "t1", name: "target", kind: "function" });
    const map = buildSymbolMap([caller1, caller2, callee]);
    // Act — only caller1 and caller2 are distinct, but both call same target
    const rels = resolveCalls([caller1, caller2, callee], map);
    // Assert — two distinct relationships (different sources)
    const ids = rels.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── findClasses / findInterfaces ─────────────────────────────────────────────

describe("findClasses", () => {
  it("returns only class-kind symbols", () => {
    // Arrange
    const cls = makeSymbol({ id: "c1", name: "Foo", kind: "class" });
    const iface = makeSymbol({ id: "i1", name: "IFoo", kind: "interface" });
    // Act + Assert
    expect(findClasses([cls, iface])).toEqual([cls]);
  });
});

describe("findInterfaces", () => {
  it("returns only interface-kind symbols", () => {
    // Arrange
    const cls = makeSymbol({ id: "c1", name: "Foo", kind: "class" });
    const iface = makeSymbol({ id: "i1", name: "IFoo", kind: "interface" });
    // Act + Assert
    expect(findInterfaces([cls, iface])).toEqual([iface]);
  });
});

// ─── resolveInheritance ───────────────────────────────────────────────────────

describe("resolveInheritance", () => {
  it("creates Inherits relationship for 'extends Parent' signature", () => {
    // Arrange
    const parent = makeSymbol({ id: "p1", name: "BaseService", kind: "class" });
    const child = makeSymbol({
      id: "c1",
      name: "UserService",
      kind: "class",
      signature: "class UserService extends BaseService",
    });
    const map = buildSymbolMap([parent, child]);
    // Act
    const rels = resolveInheritance([parent, child], map);
    // Assert
    expect(rels).toHaveLength(1);
    expect(rels[0].relType).toBe("inherits");
    expect(rels[0].source).toBe("c1");
    expect(rels[0].target).toBe("p1");
  });

  it("returns empty array when no class extends another", () => {
    // Arrange
    const cls = makeSymbol({ id: "c1", name: "Standalone", kind: "class", signature: "class Standalone" });
    const map = buildSymbolMap([cls]);
    // Act
    const rels = resolveInheritance([cls], map);
    // Assert
    expect(rels).toHaveLength(0);
  });

  it("skips inheritance when parent is not in symbol map", () => {
    // Arrange
    const child = makeSymbol({
      id: "c1",
      name: "Orphan",
      kind: "class",
      signature: "class Orphan extends NonExistent",
    });
    const map = buildSymbolMap([child]);
    // Act
    const rels = resolveInheritance([child], map);
    // Assert
    expect(rels).toHaveLength(0);
  });
});

// ─── resolveImplementations ───────────────────────────────────────────────────

describe("resolveImplementations", () => {
  it("creates Implements relationship for 'implements IFoo' signature", () => {
    // Arrange
    const iface = makeSymbol({ id: "i1", name: "IRepository", kind: "interface" });
    const cls = makeSymbol({
      id: "c1",
      name: "UserRepository",
      kind: "class",
      signature: "class UserRepository implements IRepository",
    });
    const map = buildSymbolMap([iface, cls]);
    // Act
    const rels = resolveImplementations([iface, cls], map);
    // Assert
    expect(rels).toHaveLength(1);
    expect(rels[0].relType).toBe("implements");
    expect(rels[0].source).toBe("c1");
    expect(rels[0].target).toBe("i1");
  });

  it("creates multiple Implements relationships for comma-separated interfaces", () => {
    // Arrange
    const iface1 = makeSymbol({ id: "i1", name: "ISerializable", kind: "interface" });
    const iface2 = makeSymbol({ id: "i2", name: "IComparable", kind: "interface" });
    const cls = makeSymbol({
      id: "c1",
      name: "Entity",
      kind: "class",
      signature: "class Entity implements ISerializable, IComparable",
    });
    const map = buildSymbolMap([iface1, iface2, cls]);
    // Act
    const rels = resolveImplementations([iface1, iface2, cls], map);
    // Assert
    expect(rels).toHaveLength(2);
    expect(rels.map((r) => r.target)).toContain("i1");
    expect(rels.map((r) => r.target)).toContain("i2");
  });

  it("returns empty array when interface is not in symbol map", () => {
    // Arrange
    const cls = makeSymbol({
      id: "c1",
      name: "Service",
      kind: "class",
      signature: "class Service implements IGhost",
    });
    const map = buildSymbolMap([cls]);
    // Act
    const rels = resolveImplementations([cls], map);
    // Assert
    expect(rels).toHaveLength(0);
  });
});

// ─── resolveReferences (pipeline entry point) ─────────────────────────────────

describe("resolveReferences", () => {
  it("combines all relationship types from a mixed symbol set", () => {
    // Arrange
    const base = makeSymbol({ id: "b1", name: "Base", kind: "class" });
    const iface = makeSymbol({ id: "i1", name: "IBase", kind: "interface" });
    const child = makeSymbol({
      id: "c1",
      name: "Child",
      kind: "class",
      signature: "class Child extends Base implements IBase",
    });
    const imp = makeSymbol({ id: "im1", name: "Base", kind: "import" });
    // Act
    const rels = resolveReferences([base, iface, child, imp]);
    // Assert — should have: 1 inherits + 1 implements + 1 imports
    const types = rels.map((r) => r.relType);
    expect(types).toContain("inherits");
    expect(types).toContain("implements");
    expect(types).toContain("imports");
  });

  it("returns empty array for empty symbol list", () => {
    // Arrange + Act + Assert
    expect(resolveReferences([])).toHaveLength(0);
  });
});

// ─── Property 2: Relationship Validity ───────────────────────────────────────
// **Validates: Requirements 5.5, 5.7**
// All RESOLVED relationships must reference existing symbol IDs.
// Unresolved imports are the only permitted exception (Req 5.6).

describe("Property 2: Relationship Validity", () => {
  it(
    "all resolved relationships reference symbol IDs that exist in the symbol set",
    () => {
      const RESOLVABLE_KINDS: SymbolKind[] = ["function", "method", "class", "interface", "import"];
      fc.assert(
        fc.property(
          // Generate a list of unique symbols with kinds our resolver handles
          fc.uniqueArray(
            symbolArbitrary().chain((s) =>
              fc.constantFrom(...RESOLVABLE_KINDS).map((kind) => ({ ...s, kind }))
            ),
            { minLength: 0, maxLength: 20, selector: (s) => s.id },
          ),
          (symbols) => {
            const knownIds = new Set(symbols.map((s) => s.id));
            const relationships = resolveReferences(symbols);

            for (const rel of relationships) {
              // Source must ALWAYS be a known symbol (Req 5.5)
              if (!knownIds.has(rel.source)) return false;

              // Target must be known UNLESS the relationship is unresolved (Req 5.6)
              const isUnresolved = rel.metadata["unresolved"] === "true";
              if (!isUnresolved && !knownIds.has(rel.target)) return false;
            }

            return true;
          },
        ),
        { numRuns: 200 },
      );
    },
  );

  it("relationship IDs are unique within a resolved set", () => {
    const RESOLVABLE_KINDS: SymbolKind[] = ["function", "class", "interface", "import"];
    fc.assert(
      fc.property(
        fc.uniqueArray(
          symbolArbitrary().chain((s) =>
            fc.constantFrom(...RESOLVABLE_KINDS).map((kind) => ({ ...s, kind }))
          ),
          { minLength: 0, maxLength: 20, selector: (s) => s.id },
        ),
        (symbols) => {
          const relationships = resolveReferences(symbols);
          const ids = relationships.map((r) => r.id);
          return new Set(ids).size === ids.length;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Same-file tier resolution (via resolveReferences) ───────────────────────

describe("resolveImport: same-file tier resolution", () => {
  it("prefers same-file symbol over global match when names collide", () => {
    // Arrange — two symbols with same name in different files
    const sameFileTarget = makeSymbol({
      id: "local",
      name: "Helper",
      kind: "class",
      location: { filePath: "src/test.ts", startLine: 10, startColumn: 0, endLine: 15, endColumn: 0 },
    });
    const globalTarget = makeSymbol({
      id: "global",
      name: "Helper",
      kind: "class",
      location: { filePath: "src/other.ts", startLine: 1, startColumn: 0, endLine: 5, endColumn: 0 },
    });
    const importSym = makeSymbol({
      id: "i1",
      name: "Helper",
      kind: "import",
      location: { filePath: "src/test.ts", startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
    });
    // Act — resolveReferences uses SymbolTable internally for same-file tier
    const rels = resolveReferences([sameFileTarget, globalTarget, importSym]);
    const importRel = rels.find((r) => r.source === "i1");
    // Assert — should resolve to the same-file symbol
    expect(importRel?.target).toBe("local");
    expect(importRel?.metadata["unresolved"]).toBeUndefined();
  });
});
