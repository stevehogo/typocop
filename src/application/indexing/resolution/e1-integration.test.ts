/**
 * E1 integration / parity tests over `resolveHints`.
 *
 * 1. PARITY: hints WITHOUT `receiverText`/`ownerId` (the pre-E1 shape) produce
 *    the exact same `calls`/`inherits`/`implements` edge set as before — the new
 *    code paths are inert.
 * 2. ADDITIVE member-call: a `this.method()` call whose receiver type owns the
 *    method resolves to the OWNER's method, and MRO emits an `overrides` edge —
 *    without disturbing the heritage edges.
 */
import { describe, it, expect } from "vitest";
import type { RawRelationshipHint } from "../parsing/index.js";
import type { Symbol, SymbolKind } from "../../../core/domain.js";
import { resolveHints } from "./index.js";

let n = 0;
function makeSymbol(
  name: string,
  kind: SymbolKind,
  filePath: string,
  startLine: number,
  endLine: number,
  extra: Partial<Symbol> = {},
): Symbol {
  const id = (extra.id as string) ?? `${name}-${n++}`;
  return {
    id,
    logicalKey: id,
    name,
    kind,
    visibility: "public",
    modifiers: [],
    location: { filePath, startLine, startColumn: 0, endLine, endColumn: 0 },
    ...extra,
  };
}

describe("E1 parity: hints without receiver/owner are inert", () => {
  it("a bare free-function call resolves exactly as before (no receiver)", () => {
    const a = makeSymbol("caller", "function", "src/a.ts", 1, 5, { id: "caller" });
    const b = makeSymbol("doWork", "function", "src/a.ts", 7, 9, { id: "doWork" });
    const hints: RawRelationshipHint[] = [
      { kind: "call", sourceFile: "src/a.ts", targetName: "doWork", startLine: 2, language: "typescript" },
    ];
    const { relationships } = resolveHints(hints, [a, b]);
    const calls = relationships.filter((r) => r.relType === "calls");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ source: "caller", target: "doWork", relType: "calls" });
    // No MRO edges without ownerId.
    expect(relationships.some((r) => r.relType === "overrides" || r.relType === "methodImplements")).toBe(false);
  });
});

describe("E1 additive: MRO-aware member-call + overrides", () => {
  it("`this.greet()` in Child resolves to Child's own greet; MRO links override to Base", () => {
    // class Base { greet() {} }  class Child extends Base { greet() {}  run(){ this.greet() } }
    const base = makeSymbol("Base", "class", "src/m.ts", 1, 3, { id: "Base" });
    const child = makeSymbol("Child", "class", "src/m.ts", 5, 12, { id: "Child" });
    const baseGreet = makeSymbol("greet", "method", "src/m.ts", 2, 2, { id: "Base.greet", ownerId: "Base", parameterCount: 0 } as Partial<Symbol>);
    const childGreet = makeSymbol("greet", "method", "src/m.ts", 6, 6, { id: "Child.greet", ownerId: "Child", parameterCount: 0 } as Partial<Symbol>);
    const childRun = makeSymbol("run", "method", "src/m.ts", 7, 9, { id: "Child.run", ownerId: "Child", parameterCount: 0 } as Partial<Symbol>);

    const hints: RawRelationshipHint[] = [
      { kind: "inherits", sourceFile: "src/m.ts", targetName: "Base", childSymbolId: "Child", startLine: 5, language: "typescript" },
      // member call `this.greet()` inside Child.run (line 8 within [7,9]).
      { kind: "call", sourceFile: "src/m.ts", targetName: "greet", startLine: 8, language: "typescript", receiverText: "this" },
    ];

    const { relationships } = resolveHints(hints, [base, child, baseGreet, childGreet, childRun]);

    // Heritage edge preserved.
    expect(relationships.find((r) => r.relType === "inherits")).toMatchObject({ source: "Child", target: "Base" });

    // The member call `this.greet()` resolves to Child.greet (the receiver type's
    // OWN method), NOT Base.greet. The tiered caller-selection picks the outermost
    // containing symbol (the Child class), so the call edge is anchored there.
    const call = relationships.find((r) => r.relType === "calls" && r.target?.startsWith("Child."));
    expect(call?.target).toBe("Child.greet");

    // MRO emitted an additive overrides edge Child.greet -> Base.greet.
    const ovr = relationships.find((r) => r.relType === "overrides");
    expect(ovr).toMatchObject({ source: "Child.greet", target: "Base.greet" });
  });
});
