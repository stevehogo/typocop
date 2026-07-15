/**
 * Wave 7 (§3.1, Task 1) — `resolveHeritageRelType` unit tests.
 *
 * The keystone rule, tested in isolation: symbol-table-FIRST (authoritative),
 * then the language-gated heuristic for unresolved/external parents.
 */
import { describe, it, expect } from "vitest";
import type { Language, Symbol, SymbolKind } from "../../../core/domain.js";
import { resolveHeritageRelType } from "./heritage-type.js";

function sym(name: string, kind: SymbolKind, filePath = "src/a.ts"): Symbol {
  return {
    id: `${name}@${filePath}`,
    logicalKey: `${name}@${filePath}`,
    name,
    kind,
    visibility: "public",
    modifiers: [],
    location: { filePath, startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 },
  };
}

function mapOf(...symbols: Symbol[]): Map<string, Symbol[]> {
  const m = new Map<string, Symbol[]>();
  for (const s of symbols) {
    const list = m.get(s.name) ?? [];
    list.push(s);
    m.set(s.name, list);
  }
  return m;
}

describe("resolveHeritageRelType — Tier 1 (symbol table is authoritative)", () => {
  it("parent resolves to an `interface` Symbol → implements (any language)", () => {
    const map = mapOf(sym("Drawable", "interface"));
    expect(resolveHeritageRelType("Drawable", "src/a.ts", "typescript", map)).toBe("implements");
  });

  it("parent resolves to a `class` Symbol → inherits (overrides the C#/Java heuristic both ways)", () => {
    // `IThing` LOOKS like a C# interface by name, but the symbol table proves it
    // is a class — the table wins.
    const map = mapOf(sym("IThing", "class"));
    expect(resolveHeritageRelType("IThing", "src/a.ts", "csharp", map)).toBe("inherits");
  });

  it("an in-repo class parent in Swift → inherits (table overrides the protocol default)", () => {
    const map = mapOf(sym("NSObject", "class"));
    expect(resolveHeritageRelType("NSObject", "src/a.swift", "swift", map)).toBe("inherits");
  });

  it("prefers the same-file candidate when the name is ambiguous", () => {
    const ifaceElsewhere = sym("Foo", "interface", "src/other.ts");
    const classHere = sym("Foo", "class", "src/a.ts");
    const map = mapOf(ifaceElsewhere, classHere);
    // same-file candidate (a class) wins → inherits
    expect(resolveHeritageRelType("Foo", "src/a.ts", "typescript", map)).toBe("inherits");
  });
});

describe("resolveHeritageRelType — Tier 2 (unresolved / external heuristic)", () => {
  const empty = new Map<string, Symbol[]>();

  it("C# external `IDisposable` (^I[A-Z]) → implements", () => {
    expect(resolveHeritageRelType("IDisposable", "src/a.cs", "csharp", empty)).toBe("implements");
  });

  it("Java external `Comparable` (no ^I) → inherits (others-extends default)", () => {
    // Java only flips on the `^I[A-Z]` convention; a bare `Comparable` is NOT
    // matched, so it defaults to inherits.
    expect(resolveHeritageRelType("Comparable", "src/A.java", "java", empty)).toBe("inherits");
  });

  it("Java external `IComparable` (^I[A-Z]) → implements", () => {
    expect(resolveHeritageRelType("IComparable", "src/A.java", "java", empty)).toBe("implements");
  });

  it("C# `Integer` (second char lowercase) does NOT match ^I[A-Z] → inherits", () => {
    expect(resolveHeritageRelType("Integer", "src/a.cs", "csharp", empty)).toBe("inherits");
  });

  it("Swift unresolved protocol → implements (protocol-conformance default, no name check)", () => {
    expect(resolveHeritageRelType("SomeProtocol", "src/a.swift", "swift", empty)).toBe("implements");
  });

  it("TS `class A extends B` (B unresolved) → stays inherits (no ^I heuristic outside C#/Java)", () => {
    expect(resolveHeritageRelType("B", "src/a.ts", "typescript", empty)).toBe("inherits");
  });

  it("TS `IFoo` (unresolved) → inherits (the ^I heuristic is C#/Java-only)", () => {
    expect(resolveHeritageRelType("IFoo", "src/a.ts", "typescript", empty)).toBe("inherits");
  });

  it.each<Language>(["go", "python", "rust", "cpp", "php", "ruby", "c"])(
    "%s unresolved parent → inherits (others-extends default)",
    (lang) => {
      expect(resolveHeritageRelType("Base", "src/a", lang, empty)).toBe("inherits");
    },
  );
});
