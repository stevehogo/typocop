/**
 * Wave 3 (Tier B) Task 2/7 — chain-binding return-type unwrap, flag-gated.
 *
 * Asserts `bareTypeName(returnType, useReturnTypeUnwrap)`:
 *  - flag OFF (default) is BYTE-IDENTICAL to the pre-Wave-3 regex behaviour
 *    (cannot tell wrapper from container; never refuses primitives).
 *  - flag ON unwraps wrapper generics, refuses genuine unions/primitives/bare
 *    wrappers, and (via stepChain) threads `getB(): Promise<B>` → B where before
 *    it produced "Promise". (§7 down-payment regression.)
 */
import { describe, expect, it } from "vitest";
import type { Symbol } from "../../../core/domain.js";
import { bareTypeName, stepChain, type ChainBindingDeps } from "./chain-binding.js";

describe("bareTypeName — flag OFF is byte-identical to pre-Wave-3", () => {
  it.each([
    ["Promise<User>", "User"], // single generic unwrap, leading id
    ["User", "User"],
    ["models.User", "User"], // takes last dotted segment
    ["List<User>", "User"], // OLD behaviour cannot tell container from wrapper
    ["Promise", "Promise"], // OLD keeps a bare wrapper as-is
    ["number", "number"], // OLD does not refuse primitives
  ])("%s → %s", (input, expected) => {
    expect(bareTypeName(input)).toBe(expected);
    expect(bareTypeName(input, false)).toBe(expected);
  });
});

describe("bareTypeName — flag ON uses the ported extractReturnTypeName", () => {
  it.each([
    ["Promise<User>", "User"],
    ["Option<User>", "User"],
    ["Result<User, Error>", "User"],
    ["*User", "User"],
    ["&User", "User"],
    ["User | null", "User"],
    ["List<User>", "List"], // container → base (NOT the element)
  ])("%s → %s", (input, expected) => {
    expect(bareTypeName(input, true)).toBe(expected);
  });

  it.each([
    ["Promise"], // bare wrapper
    ["User | Order"], // genuine union
    ["number"], // primitive
  ])("%s → undefined (refusal)", (input) => {
    expect(bareTypeName(input, true)).toBeUndefined();
  });
});

describe("stepChain — wrapper vs container threading differs by flag", () => {
  // B is a class. `getB(): Promise<B>` — a WRAPPER, so both flags thread to B.
  // `items(): List<B>` — a CONTAINER: the OLD regex wrongly unwraps to the
  // element B, while the NEW logic returns "List" (no class List → undefined).
  const classA: Symbol = mk("A", "class", "id:A");
  const classB: Symbol = mk("B", "class", "id:B");
  const getB: Symbol = { ...mk("getB", "method", "id:getB"), ownerId: "id:A", returnType: "Promise<B>" };
  const items: Symbol = { ...mk("items", "method", "id:items"), ownerId: "id:A", returnType: "List<B>" };

  const deps: ChainBindingDeps = {
    symbolById: new Map([["id:A", classA], ["id:B", classB]]),
    symbolMap: new Map([["A", [classA]], ["B", [classB]]]),
    methodsByOwner: new Map([["id:A", [getB, items]]]),
  };

  it("Promise<B> (wrapper) threads to class B under BOTH flags", () => {
    expect(stepChain(classA, "getB", deps, false)).toBe(classB);
    expect(stepChain(classA, "getB", deps, true)).toBe(classB);
  });

  it("List<B> (container): OFF wrongly unwraps element→B; ON refuses (List has no class)", () => {
    // OLD regex unwraps the single generic to the element B (wrong precision).
    expect(stepChain(classA, "items", deps, false)).toBe(classB);
    // NEW: container base is "List", which names no class → undefined (correct).
    expect(stepChain(classA, "items", deps, true)).toBeUndefined();
  });
});

function mk(name: string, kind: Symbol["kind"], id: string): Symbol {
  return {
    id, logicalKey: id, name, kind,
    location: { filePath: "/f.ts", startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
    visibility: "public", modifiers: [],
  };
}
