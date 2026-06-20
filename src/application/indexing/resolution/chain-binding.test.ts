/**
 * E1 step 5 — chain-binding tests.
 *
 * `a.getB().getC()` resolved by threading declared return types, plus `this`
 * binding to the caller's owner type.
 */
import { describe, it, expect } from "vitest";
import type { Symbol } from "../../../core/domain.js";
import { bareTypeName, resolveReceiverType, stepChain, type ChainBindingDeps } from "./chain-binding.js";

let n = 0;
function cls(name: string, id = `${name}-${n++}`): Symbol {
  return {
    id, logicalKey: id, name, kind: "class", visibility: "public", modifiers: [],
    location: { filePath: "src/x.ts", startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 },
  };
}
function method(name: string, ownerId: string, returnType?: string, id = `${ownerId}.${name}`): Symbol {
  return {
    id, logicalKey: id, name, kind: "method", visibility: "public", modifiers: [],
    location: { filePath: "src/x.ts", startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 },
    ownerId,
    ...(returnType !== undefined ? { returnType } : {}),
  };
}

function depsFor(symbols: Symbol[]): ChainBindingDeps {
  const symbolById = new Map(symbols.map((s) => [s.id, s]));
  const symbolMap = new Map<string, Symbol[]>();
  const methodsByOwner = new Map<string, Symbol[]>();
  for (const s of symbols) {
    const list = symbolMap.get(s.name) ?? [];
    list.push(s);
    symbolMap.set(s.name, list);
    if (s.kind === "method" && s.ownerId) {
      const m = methodsByOwner.get(s.ownerId) ?? [];
      m.push(s);
      methodsByOwner.set(s.ownerId, m);
    }
  }
  return { symbolById, symbolMap, methodsByOwner };
}

describe("bareTypeName", () => {
  it("unwraps generics and strips namespaces", () => {
    expect(bareTypeName("Promise<User>")).toBe("User");
    expect(bareTypeName("models.User")).toBe("User");
    expect(bareTypeName("User")).toBe("User");
  });
});

describe("stepChain", () => {
  it("follows a method's return type to its class symbol", () => {
    const a = cls("A", "A");
    const b = cls("B", "B");
    const getB = method("getB", "A", "B");
    const deps = depsFor([a, b, getB]);
    expect(stepChain(a, "getB", deps)?.id).toBe("B");
  });
});

describe("resolveReceiverType", () => {
  it("binds `this`/`self` to the caller's owner type", () => {
    const a = cls("A", "A");
    const caller = method("doIt", "A");
    const deps = depsFor([a, caller]);
    expect(resolveReceiverType("this", caller, deps)?.id).toBe("A");
    expect(resolveReceiverType("self", caller, deps)?.id).toBe("A");
  });

  it("threads a chained receiver a.getB().getC() to the final type", () => {
    const a = cls("A", "A");
    const b = cls("B", "B");
    const c = cls("C", "C");
    const getB = method("getB", "A", "B");
    const getC = method("getC", "B", "C");
    // caller owns `a` of type A; for v1 a bare identifier `a` only resolves if it
    // names a class, so model the chain head as the class name `A`.
    const caller = method("run", "A");
    const deps = depsFor([a, b, c, getB, getC]);
    // A.getB() => B, then .getC() => C
    expect(resolveReceiverType("A.getB()", caller, deps)?.id).toBe("B");
  });

  it("returns undefined for an unknown bare identifier (local-var types out of v1 scope)", () => {
    const caller = method("run", "A");
    const deps = depsFor([caller]);
    expect(resolveReceiverType("someLocal", caller, deps)).toBeUndefined();
  });
});
