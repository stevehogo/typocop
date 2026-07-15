/**
 * E1 step 3 — MRO / C3 linearization tests.
 *
 * Covers the required cases from the plan: C3-diamond, Java interface-default
 * ambiguity, Rust qualified (trait) MRO, plus an order-independence property
 * (the emitted edge SET is independent of symbol/heritage input ordering).
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { Relationship, Symbol, SymbolKind, Modifier } from "../../../core/domain.js";
import type { Language } from "../../../core/domain.js";
import { c3Linearize, parameterTypesMatch, computeMRO } from "./mro.js";

/** Build a `languageOf` accessor that returns the same language for every class. */
function langAll(language: Language): (id: string) => Language {
  return () => language;
}

// ─── helpers ───────────────────────────────────────────────────────────────

let counter = 0;
function sym(
  name: string,
  kind: SymbolKind,
  opts: { id?: string; ownerId?: string; parameterCount?: number; modifiers?: Modifier[] } = {},
): Symbol {
  const id = opts.id ?? `${name}-${counter++}`;
  return {
    id,
    logicalKey: id,
    name,
    kind,
    visibility: "public",
    modifiers: opts.modifiers ?? [],
    location: { filePath: "src/x.ts", startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 },
    ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
    ...(opts.parameterCount !== undefined ? { parameterCount: opts.parameterCount } : {}),
  };
}

function heritage(source: string, target: string, relType: "inherits" | "implements"): Relationship {
  return { id: `${relType}:${source}->${target}`, source, target, relType, metadata: {} };
}

// ─── c3Linearize ─────────────────────────────────────────────────────────────

describe("c3Linearize", () => {
  it("linearises a simple single-inheritance chain", () => {
    const parents = new Map<string, string[]>([
      ["C", ["B"]],
      ["B", ["A"]],
    ]);
    expect(c3Linearize("C", parents, new Map())).toEqual(["B", "A"]);
  });

  it("linearises the classic diamond A<-B, A<-C, B&C<-D as [B,C,A]", () => {
    const parents = new Map<string, string[]>([
      ["D", ["B", "C"]],
      ["B", ["A"]],
      ["C", ["A"]],
    ]);
    expect(c3Linearize("D", parents, new Map())).toEqual(["B", "C", "A"]);
  });

  it("returns null for a cyclic hierarchy", () => {
    const parents = new Map<string, string[]>([
      ["A", ["B"]],
      ["B", ["A"]],
    ]);
    expect(c3Linearize("A", parents, new Map())).toBeNull();
  });
});

// ─── parameterTypesMatch ───────────────────────────────────────────────────

describe("parameterTypesMatch", () => {
  it("confident on equal arity", () => {
    expect(parameterTypesMatch([], [], 2, 2)).toEqual({ match: true, confident: true });
  });
  it("no match on differing arity", () => {
    expect(parameterTypesMatch([], [], 2, 3)).toEqual({ match: false, confident: false });
  });
  it("lenient when both counts unknown", () => {
    expect(parameterTypesMatch([], [], undefined, undefined)).toEqual({ match: true, confident: false });
  });
});

// ─── computeMRO — overrides ─────────────────────────────────────────────────

describe("computeMRO: overrides (single inheritance)", () => {
  it("emits an `overrides` edge for a subclass method that re-declares a base method", () => {
    const base = sym("Base", "class", { id: "Base" });
    const child = sym("Child", "class", { id: "Child" });
    const baseFoo = sym("foo", "method", { id: "Base.foo", ownerId: "Base", parameterCount: 1 });
    const childFoo = sym("foo", "method", { id: "Child.foo", ownerId: "Child", parameterCount: 1 });
    const { relationships } = computeMRO(
      [base, child, baseFoo, childFoo],
      [heritage("Child", "Base", "inherits")],
    );
    const overrides = relationships.filter((r) => r.relType === "overrides");
    expect(overrides).toHaveLength(1);
    expect(overrides[0].source).toBe("Child.foo");
    expect(overrides[0].target).toBe("Base.foo");
  });

  it("does NOT emit `inherits`/`implements` edges (additive only)", () => {
    const base = sym("Base", "class", { id: "Base" });
    const child = sym("Child", "class", { id: "Child" });
    const childFoo = sym("foo", "method", { id: "Child.foo", ownerId: "Child" });
    const baseFoo = sym("foo", "method", { id: "Base.foo", ownerId: "Base" });
    const { relationships } = computeMRO(
      [base, child, baseFoo, childFoo],
      [heritage("Child", "Base", "inherits")],
    );
    expect(relationships.every((r) => r.relType === "overrides" || r.relType === "methodImplements")).toBe(true);
  });

  it("emits nothing when no method carries an ownerId (synthetic fixtures stay byte-identical)", () => {
    const base = sym("Base", "class", { id: "Base" });
    const child = sym("Child", "class", { id: "Child" });
    const { relationships } = computeMRO([base, child], [heritage("Child", "Base", "inherits")]);
    expect(relationships).toHaveLength(0);
  });
});

// ─── computeMRO — C3 diamond overrides ───────────────────────────────────────

describe("computeMRO: C3 diamond", () => {
  it("a diamond subclass method overrides the FIRST C3 ancestor declaring it", () => {
    // A<-B, A<-C, B&C<-D. Both B and A declare foo; C3 order is [B,C,A] so D.foo
    // overrides B.foo (the first ancestor in linearised order with the method).
    const a = sym("A", "class", { id: "A" });
    const b = sym("B", "class", { id: "B" });
    const c = sym("C", "class", { id: "C" });
    const d = sym("D", "class", { id: "D" });
    const aFoo = sym("foo", "method", { id: "A.foo", ownerId: "A", parameterCount: 0 });
    const bFoo = sym("foo", "method", { id: "B.foo", ownerId: "B", parameterCount: 0 });
    const dFoo = sym("foo", "method", { id: "D.foo", ownerId: "D", parameterCount: 0 });
    const { relationships } = computeMRO(
      [a, b, c, d, aFoo, bFoo, dFoo],
      [
        heritage("D", "B", "inherits"),
        heritage("D", "C", "inherits"),
        heritage("B", "A", "inherits"),
        heritage("C", "A", "inherits"),
      ],
    );
    const overrides = relationships.filter((r) => r.relType === "overrides" && r.source === "D.foo");
    expect(overrides).toHaveLength(1);
    expect(overrides[0].target).toBe("B.foo"); // B precedes A in C3 order
  });
});

// ─── computeMRO — Java interface default-method ambiguity ─────────────────────

describe("computeMRO: Java interface default ambiguity", () => {
  it("a concrete method implementing two interfaces emits methodImplements to BOTH", () => {
    // interface I1 { run(); }  interface I2 { run(); }  class C implements I1, I2 { run() {} }
    const i1 = sym("I1", "interface", { id: "I1" });
    const i2 = sym("I2", "interface", { id: "I2" });
    const c = sym("C", "class", { id: "C" });
    const i1Run = sym("run", "method", { id: "I1.run", ownerId: "I1", parameterCount: 0 });
    const i2Run = sym("run", "method", { id: "I2.run", ownerId: "I2", parameterCount: 0 });
    const cRun = sym("run", "method", { id: "C.run", ownerId: "C", parameterCount: 0 });
    const { relationships } = computeMRO(
      [i1, i2, c, i1Run, i2Run, cRun],
      [heritage("C", "I1", "implements"), heritage("C", "I2", "implements")],
    );
    const impls = relationships.filter((r) => r.relType === "methodImplements" && r.source === "C.run");
    expect(impls.map((r) => r.target).sort()).toEqual(["I1.run", "I2.run"]);
    // None of them should be `overrides` — interfaces are contracts, not supers.
    expect(relationships.some((r) => r.relType === "overrides")).toBe(false);
  });
});

// ─── computeMRO — Rust qualified (trait) MRO ──────────────────────────────────

describe("computeMRO: Rust qualified trait MRO", () => {
  it("a struct method satisfying a trait method emits methodImplements (trait = interface)", () => {
    // trait Greet { fn hello(); }  struct S; impl Greet for S { fn hello() {} }
    // Heritage hints model the impl as an `implements` edge S -> Greet; the trait
    // symbol is kind `interface` in typocop's model.
    const greet = sym("Greet", "interface", { id: "Greet" });
    const s = sym("S", "class", { id: "S" });
    const greetHello = sym("hello", "method", { id: "Greet.hello", ownerId: "Greet", parameterCount: 0 });
    const sHello = sym("hello", "method", { id: "S.hello", ownerId: "S", parameterCount: 0 });
    const { relationships } = computeMRO(
      [greet, s, greetHello, sHello],
      [heritage("S", "Greet", "implements")],
    );
    const impls = relationships.filter((r) => r.relType === "methodImplements");
    expect(impls).toHaveLength(1);
    expect(impls[0].source).toBe("S.hello");
    expect(impls[0].target).toBe("Greet.hello");
  });
});

// ─── Wave 7 (§3.1, Task 2) per-language collision rules (flag ON) ─────────────

describe("computeMRO: Wave 7 per-language rules (flag ON)", () => {
  it("C++ leftmost-base diamond: D.foo overrides B.foo (first declared base) when flag on", () => {
    // A<-B, A<-C, B&C<-D. Both B and A declare foo. Linear order [B,C,A] → B wins.
    const a = sym("A", "class", { id: "A" });
    const b = sym("B", "class", { id: "B" });
    const c = sym("C", "class", { id: "C" });
    const d = sym("D", "class", { id: "D" });
    const aFoo = sym("foo", "method", { id: "A.foo", ownerId: "A", parameterCount: 0 });
    const bFoo = sym("foo", "method", { id: "B.foo", ownerId: "B", parameterCount: 0 });
    const dFoo = sym("foo", "method", { id: "D.foo", ownerId: "D", parameterCount: 0 });
    const { relationships, entries } = computeMRO(
      [a, b, c, d, aFoo, bFoo, dFoo],
      [
        heritage("D", "B", "inherits"),
        heritage("D", "C", "inherits"),
        heritage("B", "A", "inherits"),
        heritage("C", "A", "inherits"),
      ],
      langAll("cpp"),
      true,
    );
    const overrides = relationships.filter((r) => r.relType === "overrides" && r.source === "D.foo");
    expect(overrides).toHaveLength(1);
    expect(overrides[0].target).toBe("B.foo");
    const dEntry = entries.find((e) => e.classId === "D");
    expect(dEntry?.language).toBe("cpp");
    const fooAmb = dEntry?.ambiguities.find((amb) => amb.methodName === "foo");
    expect(fooAmb?.reason).toContain("C++ leftmost base");
    expect(fooAmb?.resolvedTo).toBe("B.foo");
    expect(fooAmb?.definedIn.map((dd) => dd.classId).sort()).toEqual(["A", "B"]);
  });

  it("C#/Java class-beats-interface: class method wins, no ambiguity-null", () => {
    // class C extends Base implements I; Base.run() and I.run() both exist.
    const base = sym("Base", "class", { id: "Base" });
    const i = sym("I", "interface", { id: "I" });
    const c = sym("C", "class", { id: "C" });
    const baseRun = sym("run", "method", { id: "Base.run", ownerId: "Base", parameterCount: 0 });
    const iRun = sym("run", "method", { id: "I.run", ownerId: "I", parameterCount: 0 });
    const cRun = sym("run", "method", { id: "C.run", ownerId: "C", parameterCount: 0 });
    const { relationships, entries } = computeMRO(
      [base, i, c, baseRun, iRun, cRun],
      [heritage("C", "Base", "inherits"), heritage("C", "I", "implements")],
      langAll("csharp"),
      true,
    );
    // The class-beats-interface RULE resolves the collision to the concrete Base
    // (recorded in the diagnostics). The emission loop walks the linearised
    // ancestor chain [Base, I]: Base is concrete → emit `overrides` to Base and
    // stop (single dispatch), exactly as today's loop. The diagnostic confirms
    // the per-language winner is the class method, not the interface default.
    const overrides = relationships.filter((r) => r.relType === "overrides" && r.source === "C.run");
    expect(overrides.map((r) => r.target)).toEqual(["Base.run"]);
    const cEntry = entries.find((e) => e.classId === "C");
    const runAmb = cEntry?.ambiguities.find((amb) => amb.methodName === "run");
    expect(runAmb?.reason).toContain("class method wins");
    expect(runAmb?.resolvedTo).toBe("Base.run");
  });

  it("C#/Java two-interfaces-only: ambiguity recorded (resolvedTo null), NO overrides, methodImplements to BOTH", () => {
    const i1 = sym("I1", "interface", { id: "I1" });
    const i2 = sym("I2", "interface", { id: "I2" });
    const c = sym("C", "class", { id: "C" });
    const i1Run = sym("run", "method", { id: "I1.run", ownerId: "I1", parameterCount: 0 });
    const i2Run = sym("run", "method", { id: "I2.run", ownerId: "I2", parameterCount: 0 });
    const cRun = sym("run", "method", { id: "C.run", ownerId: "C", parameterCount: 0 });
    const { relationships, entries, ambiguityCount } = computeMRO(
      [i1, i2, c, i1Run, i2Run, cRun],
      [heritage("C", "I1", "implements"), heritage("C", "I2", "implements")],
      langAll("java"),
      true,
    );
    expect(relationships.some((r) => r.relType === "overrides")).toBe(false);
    const impls = relationships.filter((r) => r.relType === "methodImplements" && r.source === "C.run");
    expect(impls.map((r) => r.target).sort()).toEqual(["I1.run", "I2.run"]);
    const cEntry = entries.find((e) => e.classId === "C");
    const runAmb = cEntry?.ambiguities.find((amb) => amb.methodName === "run");
    expect(runAmb?.resolvedTo).toBeNull();
    expect(runAmb?.reason).toContain("multiple interfaces");
    expect(ambiguityCount).toBe(1);
  });

  it("Rust trait diamond: no overrides, reason = requires qualified syntax", () => {
    // Two traits define hello(); struct S impls both. Traits are interfaces, so
    // the satisfaction is methodImplements — but a *collision* across the two
    // traits records the Rust qualified-syntax reason and emits NO overrides.
    const t1 = sym("T1", "interface", { id: "T1" });
    const t2 = sym("T2", "interface", { id: "T2" });
    const s = sym("S", "class", { id: "S" });
    const t1Hello = sym("hello", "method", { id: "T1.hello", ownerId: "T1", parameterCount: 0 });
    const t2Hello = sym("hello", "method", { id: "T2.hello", ownerId: "T2", parameterCount: 0 });
    const sHello = sym("hello", "method", { id: "S.hello", ownerId: "S", parameterCount: 0 });
    const { relationships, entries } = computeMRO(
      [t1, t2, s, t1Hello, t2Hello, sHello],
      [heritage("S", "T1", "implements"), heritage("S", "T2", "implements")],
      langAll("rust"),
      true,
    );
    expect(relationships.some((r) => r.relType === "overrides")).toBe(false);
    const sEntry = entries.find((e) => e.classId === "S");
    const helloAmb = sEntry?.ambiguities.find((amb) => amb.methodName === "hello");
    expect(helloAmb?.resolvedTo).toBeNull();
    expect(helloAmb?.reason).toContain("Rust requires qualified syntax");
  });

  it("Python C3 order is byte-identical whether the flag is on or off (TRIPWIRE)", () => {
    const a = sym("A", "class", { id: "A" });
    const b = sym("B", "class", { id: "B" });
    const c = sym("C", "class", { id: "C" });
    const d = sym("D", "class", { id: "D" });
    const aFoo = sym("foo", "method", { id: "A.foo", ownerId: "A", parameterCount: 0 });
    const bFoo = sym("foo", "method", { id: "B.foo", ownerId: "B", parameterCount: 0 });
    const dFoo = sym("foo", "method", { id: "D.foo", ownerId: "D", parameterCount: 0 });
    const symbols = [a, b, c, d, aFoo, bFoo, dFoo];
    const edges = [
      heritage("D", "B", "inherits"),
      heritage("D", "C", "inherits"),
      heritage("B", "A", "inherits"),
      heritage("C", "A", "inherits"),
    ];
    const off = new Set(computeMRO(symbols, edges).relationships.map((r) => r.id));
    const on = new Set(
      computeMRO(symbols, edges, langAll("python"), true).relationships.map((r) => r.id),
    );
    expect([...on].sort()).toEqual([...off].sort());
    // D.foo still overrides B.foo (C3 order [B,C,A]) under both.
    expect(on.has("overrides:D.foo->B.foo")).toBe(true);
  });

  it("entries include the full linearised `mro` NAMES for a class with parents", () => {
    const a = sym("Animal", "class", { id: "A" });
    const d = sym("Dog", "class", { id: "D" });
    const aSpeak = sym("speak", "method", { id: "A.speak", ownerId: "A", parameterCount: 0 });
    const dSpeak = sym("speak", "method", { id: "D.speak", ownerId: "D", parameterCount: 0 });
    const { entries } = computeMRO(
      [a, d, aSpeak, dSpeak],
      [heritage("D", "A", "inherits")],
      langAll("python"),
      true,
    );
    const dEntry = entries.find((e) => e.classId === "D");
    expect(dEntry?.className).toBe("Dog");
    expect(dEntry?.mro).toEqual(["Animal"]); // linearized ancestor NAMES
  });

  it("diagnostics do NOT change the emitted edge set (entries are additive)", () => {
    const base = sym("Base", "class", { id: "Base" });
    const child = sym("Child", "class", { id: "Child" });
    const baseFoo = sym("foo", "method", { id: "Base.foo", ownerId: "Base", parameterCount: 1 });
    const childFoo = sym("foo", "method", { id: "Child.foo", ownerId: "Child", parameterCount: 1 });
    const symbols = [base, child, baseFoo, childFoo];
    const edges = [heritage("Child", "Base", "inherits")];
    const withDiag = computeMRO(symbols, edges, langAll("typescript"), true);
    const baseline = computeMRO(symbols, edges);
    expect(withDiag.relationships.map((r) => r.id).sort()).toEqual(
      baseline.relationships.map((r) => r.id).sort(),
    );
    // The default-language (TS) collision still resolves to first-definition.
  });
});

// ─── Order-independence property ──────────────────────────────────────────────

describe("Property: MRO edge set is independent of input ordering", () => {
  it("permuting symbols and heritage yields the same overrides/methodImplements edge id set", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 0, maxLength: 6 }),
        () => {
          // Fixed scenario: diamond + two methods.
          const symbols: Symbol[] = [
            sym("A", "class", { id: "A" }),
            sym("B", "class", { id: "B" }),
            sym("C", "class", { id: "C" }),
            sym("D", "class", { id: "D" }),
            sym("foo", "method", { id: "A.foo", ownerId: "A", parameterCount: 0 }),
            sym("foo", "method", { id: "B.foo", ownerId: "B", parameterCount: 0 }),
            sym("foo", "method", { id: "D.foo", ownerId: "D", parameterCount: 0 }),
          ];
          const edges: Relationship[] = [
            heritage("D", "B", "inherits"),
            heritage("D", "C", "inherits"),
            heritage("B", "A", "inherits"),
            heritage("C", "A", "inherits"),
          ];
          const baseline = new Set(
            computeMRO(symbols, edges).relationships.map((r) => r.id),
          );
          // Shuffle both inputs deterministically (reverse + rotate).
          const sh = (arr: readonly unknown[], k: number): unknown[] =>
            [...arr.slice(k), ...arr.slice(0, k)].reverse();
          const permuted = new Set(
            computeMRO(
              sh(symbols, 3) as Symbol[],
              sh(edges, 2) as Relationship[],
            ).relationships.map((r) => r.id),
          );
          return baseline.size === permuted.size && [...baseline].every((id) => permuted.has(id));
        },
      ),
      { numRuns: 30 },
    );
  });
});
