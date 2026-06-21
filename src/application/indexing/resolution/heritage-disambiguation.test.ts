/**
 * Wave 7 (§3.1) integration tests over `resolveHints` — the heritage
 * interface-vs-class disambiguation flip, gated behind `heritageDisambiguation`.
 *
 * Verifies: flag OFF trusts `hint.kind` (byte-identical); flag ON upgrades an
 * `inherits` hint to an `implements` edge for external C#/Java/Swift interface
 * parents, leaves a TS unresolved `extends` as `inherits`, lets the symbol table
 * override the heuristic both ways, and carries the Go-embed / Ruby-mixin
 * `heritageKind` flavor onto the edge metadata.
 */
import { describe, it, expect } from "vitest";
import type { Language, Symbol, SymbolKind } from "../../../core/domain.js";
import type { RawRelationshipHint } from "../parsing/index.js";
import { resolveHints } from "./index.js";

let counter = 0;
function sym(name: string, kind: SymbolKind, filePath: string): Symbol {
  const id = `${name}@${filePath}#${counter++}`;
  return {
    id,
    logicalKey: id,
    name,
    kind,
    visibility: "public",
    modifiers: [],
    location: { filePath, startLine: 1, startColumn: 0, endLine: 10, endColumn: 0 },
  };
}

function heritageHint(
  child: string,
  parent: string,
  kind: "inherits" | "implements",
  language: Language,
  sourceFile: string,
  heritageKind?: "embed" | "include" | "extend" | "prepend",
): RawRelationshipHint {
  return {
    kind,
    sourceFile,
    targetName: parent,
    childSymbolId: child,
    startLine: 1,
    language,
    ...(heritageKind ? { heritageKind } : {}),
  };
}

/** Find the heritage edge between two NAMED symbols. */
function heritageEdge(
  rels: { source: string; target: string; relType: string; metadata: Record<string, string> }[],
  childId: string,
  parentId: string,
) {
  return rels.find(
    (r) =>
      (r.relType === "inherits" || r.relType === "implements") &&
      r.source === childId &&
      r.target === parentId,
  );
}

describe("resolveHints heritage disambiguation — flag OFF (byte-identical)", () => {
  it("trusts hint.kind: an `inherits` hint for external `IDisposable` stays `inherits`", () => {
    const foo = sym("Foo", "class", "src/a.cs");
    // External IDisposable: present as a no-symbol parent that the hint marks inherits.
    const idis = sym("IDisposable", "class", "src/ext.cs"); // not an interface symbol
    const hints = [heritageHint("Foo", "IDisposable", "inherits", "csharp", "src/a.cs")];
    const { relationships } = resolveHints(hints, [foo, idis]); // flag default OFF
    expect(heritageEdge(relationships, foo.id, idis.id)?.relType).toBe("inherits");
  });
});

describe("resolveHints heritage disambiguation — flag ON", () => {
  const ON = true;
  // resolveHints positional args: (hints, symbols, languageConfigs, allFiles,
  // typeEnvResolution, callRefuseAmbiguous, heritageDisambiguation)
  function run(hints: RawRelationshipHint[], symbols: Symbol[]) {
    return resolveHints(hints, symbols, undefined, undefined, false, false, ON);
  }

  it("C# external `IDisposable` inherits-hint → implements edge (^I[A-Z])", () => {
    const foo = sym("Foo", "class", "src/a.cs");
    // No `interface` symbol for IDisposable; provide a non-interface placeholder
    // so the edge has a concrete target but the table does NOT prove it a class.
    const idis = sym("IDisposable", "variable", "src/ext.cs");
    const { relationships } = run([heritageHint("Foo", "IDisposable", "inherits", "csharp", "src/a.cs")], [foo, idis]);
    expect(heritageEdge(relationships, foo.id, idis.id)?.relType).toBe("implements");
  });

  it("Java unresolved `Comparable` stays `inherits` (no ^I); `IComparable` → `implements`", () => {
    const bar = sym("Bar", "class", "src/A.java");
    const cmp = sym("Comparable", "variable", "src/ext.java");
    const icmp = sym("IComparable", "variable", "src/ext.java");
    const r1 = run([heritageHint("Bar", "Comparable", "inherits", "java", "src/A.java")], [bar, cmp]);
    expect(heritageEdge(r1.relationships, bar.id, cmp.id)?.relType).toBe("inherits");
    const bar2 = sym("Bar2", "class", "src/B.java");
    const r2 = run([heritageHint("Bar2", "IComparable", "inherits", "java", "src/B.java")], [bar2, icmp]);
    expect(heritageEdge(r2.relationships, bar2.id, icmp.id)?.relType).toBe("implements");
  });

  it("Swift unresolved protocol inherits-hint → implements (protocol default)", () => {
    const v = sym("V", "class", "src/a.swift");
    const proto = sym("SomeProtocol", "variable", "src/ext.swift");
    const { relationships } = run([heritageHint("V", "SomeProtocol", "inherits", "swift", "src/a.swift")], [v, proto]);
    expect(heritageEdge(relationships, v.id, proto.id)?.relType).toBe("implements");
  });

  it("TS `class A extends B` (B unresolved) stays `inherits`", () => {
    const a = sym("A", "class", "src/a.ts");
    const b = sym("B", "variable", "src/ext.ts");
    const { relationships } = run([heritageHint("A", "B", "inherits", "typescript", "src/a.ts")], [a, b]);
    expect(heritageEdge(relationships, a.id, b.id)?.relType).toBe("inherits");
  });

  it("symbol table overrides the heuristic: in-repo `interface` parent → implements (even with an `inherits` hint)", () => {
    const c = sym("C", "class", "src/a.ts");
    const iface = sym("Drawable", "interface", "src/a.ts");
    const { relationships } = run([heritageHint("C", "Drawable", "inherits", "typescript", "src/a.ts")], [c, iface]);
    expect(heritageEdge(relationships, c.id, iface.id)?.relType).toBe("implements");
  });

  it("symbol table overrides the heuristic: in-repo `class` named like an interface → inherits (even with an `implements` hint)", () => {
    const c = sym("C", "class", "src/a.cs");
    const klass = sym("IThing", "class", "src/a.cs"); // real class despite the name
    const { relationships } = run([heritageHint("C", "IThing", "implements", "csharp", "src/a.cs")], [c, klass]);
    expect(heritageEdge(relationships, c.id, klass.id)?.relType).toBe("inherits");
  });

  it("Go embedding hint carries `metadata.heritage = 'embed'` and stays `inherits`", () => {
    const dog = sym("Dog", "class", "src/a.go");
    const animal = sym("Animal", "class", "src/a.go");
    const { relationships } = run(
      [heritageHint("Dog", "Animal", "inherits", "go", "src/a.go", "embed")],
      [dog, animal],
    );
    const edge = heritageEdge(relationships, dog.id, animal.id);
    expect(edge?.relType).toBe("inherits");
    expect(edge?.metadata.heritage).toBe("embed");
  });

  it("Ruby `include` mixin hint → implements edge with `metadata.heritage = 'include'`", () => {
    const c = sym("C", "class", "src/a.rb");
    const mod = sym("Comparable", "class", "src/a.rb");
    const { relationships } = run(
      [heritageHint("C", "Comparable", "implements", "ruby", "src/a.rb", "include")],
      [c, mod],
    );
    const edge = heritageEdge(relationships, c.id, mod.id);
    expect(edge?.relType).toBe("implements");
    expect(edge?.metadata.heritage).toBe("include");
  });

  it("Ruby `extend` mixin records the `extend` flavor distinct from `include`", () => {
    const c = sym("C", "class", "src/a.rb");
    const mod = sym("Forwardable", "class", "src/a.rb");
    const { relationships } = run(
      [heritageHint("C", "Forwardable", "implements", "ruby", "src/a.rb", "extend")],
      [c, mod],
    );
    expect(heritageEdge(relationships, c.id, mod.id)?.metadata.heritage).toBe("extend");
  });
});
