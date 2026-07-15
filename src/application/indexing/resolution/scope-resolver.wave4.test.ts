/**
 * Wave 4 — call-resolution filtering & ambiguity discipline.
 *
 * Covers the shared `filterCallableCandidates` helper (Tasks 2-3) and the
 * refuse-on-ambiguity selector path (`refuseAmbiguous` ON; Tasks 2-5), plus the
 * critical flag-OFF byte-identical parity guarantee (with the flag off,
 * `selectSingle` reproduces the legacy `candidates[0]` / global-fallback choice
 * exactly).
 */
import { describe, it, expect } from "vitest";
import type { Symbol, SymbolKind } from "../../../core/domain.js";
import {
  selectSingle,
  filterCallableCandidates,
  type CallResolutionDeps,
  type CallResolutionInput,
} from "./scope-resolver.js";
import "./resolvers/index.js";
import { createResolutionContext } from "./resolution-context.js";
import { buildSymbolMap } from "./index.js";
import { symbolMetadata } from "./symbol-table.js";
import type { SymbolDefinition } from "./symbol-table.js";

interface SymOpts {
  kind?: SymbolKind;
  parameterCount?: number;
  ownerId?: string;
}

function sym(id: string, name: string, filePath: string, opts: SymOpts = {}): Symbol {
  return {
    id,
    logicalKey: id,
    name,
    kind: opts.kind ?? "function",
    visibility: "public",
    modifiers: [],
    location: { filePath, startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 },
    ...(opts.parameterCount !== undefined ? { parameterCount: opts.parameterCount } : {}),
    ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
  };
}

function depsFor(symbols: Symbol[], refuseAmbiguous: boolean): CallResolutionDeps {
  const ctx = createResolutionContext();
  for (const s of symbols) ctx.symbols.add(s.location.filePath, s.name, s.id, s.kind, symbolMetadata(s));
  const symbolById = new Map(symbols.map((s) => [s.id, s]));
  return { ctx, symbolById, symbolMap: buildSymbolMap(symbols), refuseAmbiguous };
}

function def(nodeId: string, type: string, opts: { parameterCount?: number; ownerId?: string; filePath?: string } = {}): SymbolDefinition {
  return {
    nodeId,
    filePath: opts.filePath ?? "src/x.ts",
    type,
    ...(opts.parameterCount !== undefined ? { parameterCount: opts.parameterCount } : {}),
    ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
  };
}

// ─── Task 2: callable-kind filtering ───────────────────────────────────────────

describe("filterCallableCandidates — kind filter (Task 2)", () => {
  it("keeps functions and methods, drops variable/class/interface for non-constructor calls", () => {
    const cands = [
      def("fn", "function"),
      def("mt", "method"),
      def("var", "variable"),
      def("cls", "class"),
      def("iface", "interface"),
    ];
    const kept = filterCallableCandidates(cands).map((c) => c.nodeId);
    expect(kept.sort()).toEqual(["fn", "mt"]);
  });

  it("narrows constructor-form calls to the class target", () => {
    const cands = [def("ctorFn", "function"), def("UserClass", "class")];
    const kept = filterCallableCandidates(cands, undefined, "constructor").map((c) => c.nodeId);
    expect(kept).toEqual(["UserClass"]);
  });

  it("constructor-form falls back to callable kinds when no class candidate exists", () => {
    const cands = [def("makeUser", "function"), def("aVar", "variable")];
    const kept = filterCallableCandidates(cands, undefined, "constructor").map((c) => c.nodeId);
    expect(kept).toEqual(["makeUser"]);
  });

  it("returns [] when no candidate is callable", () => {
    const cands = [def("var", "variable"), def("iface", "interface")];
    expect(filterCallableCandidates(cands)).toEqual([]);
  });
});

// ─── Task 3: arity filtering + the two escape hatches ──────────────────────────

describe("filterCallableCandidates — arity filter (Task 3)", () => {
  it("keeps only the candidate whose parameterCount matches argCount", () => {
    const cands = [def("foo1", "function", { parameterCount: 1 }), def("foo2", "function", { parameterCount: 2 })];
    expect(filterCallableCandidates(cands, 2).map((c) => c.nodeId)).toEqual(["foo2"]);
    expect(filterCallableCandidates(cands, 1).map((c) => c.nodeId)).toEqual(["foo1"]);
  });

  it("escape hatch 1: argCount === undefined skips arity narrowing entirely", () => {
    const cands = [def("foo1", "function", { parameterCount: 1 }), def("foo2", "function", { parameterCount: 2 })];
    expect(filterCallableCandidates(cands, undefined).map((c) => c.nodeId).sort()).toEqual(["foo1", "foo2"]);
  });

  it("escape hatch 2: no candidate carries parameterCount → returned unfiltered", () => {
    const cands = [def("a", "function"), def("b", "function")];
    expect(filterCallableCandidates(cands, 5).map((c) => c.nodeId).sort()).toEqual(["a", "b"]);
  });

  it("escape hatch 3: a candidate with undefined parameterCount always passes (variadic-safe)", () => {
    // `variadic` has no parameterCount → must survive; `two` (count 2) is dropped vs argCount 1.
    const cands = [
      def("variadic", "function"),
      def("one", "function", { parameterCount: 1 }),
      def("two", "function", { parameterCount: 2 }),
    ];
    const kept = filterCallableCandidates(cands, 1).map((c) => c.nodeId).sort();
    expect(kept).toEqual(["one", "variadic"]);
  });
});

// ─── Tasks 2/3/5: refuse-on-ambiguity selection via selectSingle (flag ON) ─────

describe("selectSingle with refuseAmbiguous ON", () => {
  it("emits the single callable survivor (drops a same-name non-callable)", () => {
    const caller = sym("caller", "c", "src/a.ts");
    const fn = sym("fn", "save", "src/b.ts", { kind: "function" });
    const variable = sym("var", "save", "src/c.ts", { kind: "variable" });
    const deps = depsFor([caller, fn, variable], true);
    const target = selectSingle({ calleeName: "save", caller, sourceFile: "src/a.ts", callForm: "free" }, deps);
    expect(target?.id).toBe("fn");
  });

  it("resolves an overload by arity (two same-name functions, different parameterCount)", () => {
    const caller = sym("caller", "c", "src/a.ts");
    const f1 = sym("f1", "foo", "src/b.ts", { kind: "function", parameterCount: 1 });
    const f2 = sym("f2", "foo", "src/c.ts", { kind: "function", parameterCount: 2 });
    const deps = depsFor([caller, f1, f2], true);
    const t1 = selectSingle({ calleeName: "foo", caller, sourceFile: "src/a.ts", argCount: 1, callForm: "free" }, deps);
    const t2 = selectSingle({ calleeName: "foo", caller, sourceFile: "src/a.ts", argCount: 2, callForm: "free" }, deps);
    expect(t1?.id).toBe("f1");
    expect(t2?.id).toBe("f2");
  });

  it("refuses (no edge) when ≥2 callable candidates survive with no disambiguator", () => {
    const caller = sym("caller", "c", "src/a.ts");
    const f1 = sym("f1", "foo", "src/b.ts", { kind: "function" });
    const f2 = sym("f2", "foo", "src/c.ts", { kind: "function" });
    const deps = depsFor([caller, f1, f2], true);
    const target = selectSingle({ calleeName: "foo", caller, sourceFile: "src/a.ts", callForm: "free" }, deps);
    expect(target).toBeUndefined();
  });

  it("refuses (no edge) when the kind filter removes every candidate", () => {
    const caller = sym("caller", "c", "src/a.ts");
    const variable = sym("var", "foo", "src/b.ts", { kind: "variable" });
    const deps = depsFor([caller, variable], true);
    const target = selectSingle({ calleeName: "foo", caller, sourceFile: "src/a.ts", callForm: "free" }, deps);
    expect(target).toBeUndefined();
  });

  it("constructor-form call resolves to the class", () => {
    const caller = sym("caller", "c", "src/a.ts");
    const cls = sym("UserCls", "User", "src/b.ts", { kind: "class" });
    const deps = depsFor([caller, cls], true);
    const target = selectSingle({ calleeName: "User", caller, sourceFile: "src/a.ts", callForm: "constructor" }, deps);
    expect(target?.id).toBe("UserCls");
  });

  // ── Task 4: receiver-type narrowing for member calls ──
  it("narrows a member call to the method owned by the receiver type (ownerId match)", () => {
    const caller = sym("caller", "c", "src/a.ts");
    const userCls = sym("User", "User", "src/user.ts", { kind: "class" });
    const otherCls = sym("Account", "Account", "src/acct.ts", { kind: "class" });
    const userSave = sym("userSave", "save", "src/user.ts", { kind: "method", ownerId: "User" });
    const acctSave = sym("acctSave", "save", "src/acct.ts", { kind: "method", ownerId: "Account" });
    const deps = depsFor([caller, userCls, otherCls, userSave, acctSave], true);
    const target = selectSingle(
      { calleeName: "save", caller, sourceFile: "src/a.ts", callForm: "member", receiverType: "User" },
      deps,
    );
    expect(target?.id).toBe("userSave");
  });

  it("narrows a member call by the receiver type's FILE when only one method lives there", () => {
    const caller = sym("caller", "c", "src/a.ts");
    const userCls = sym("User", "User", "src/user.ts", { kind: "class" });
    const userSave = sym("userSave", "save", "src/user.ts", { kind: "method", ownerId: "User" });
    const acctSave = sym("acctSave", "save", "src/acct.ts", { kind: "method", ownerId: "Account" });
    const deps = depsFor([caller, userCls, userSave, acctSave], true);
    const target = selectSingle(
      { calleeName: "save", caller, sourceFile: "src/a.ts", callForm: "member", receiverType: "User" },
      deps,
    );
    expect(target?.id).toBe("userSave");
  });

  it("receiverType absent → dark no-op (general refuse path still applies)", () => {
    const caller = sym("caller", "c", "src/a.ts");
    const m1 = sym("m1", "save", "src/b.ts", { kind: "method" });
    const m2 = sym("m2", "save", "src/c.ts", { kind: "method" });
    const deps = depsFor([caller, m1, m2], true);
    // No receiverType → no narrowing → 2 survivors → refuse.
    const target = selectSingle({ calleeName: "save", caller, sourceFile: "src/a.ts", callForm: "member" }, deps);
    expect(target).toBeUndefined();
  });
});

// ─── Task 5 / §10: flag-OFF byte-identical parity ──────────────────────────────

describe("selectSingle with refuseAmbiguous OFF — byte-identical legacy behaviour", () => {
  it("still takes the first global name match even across ambiguous callables", () => {
    const caller = sym("caller", "handler", "src/a.ts");
    const f1 = sym("f1", "foo", "src/b.ts", { kind: "function" });
    const f2 = sym("f2", "foo", "src/c.ts", { kind: "function" });
    const deps = depsFor([caller, f1, f2], false);
    const target = selectSingle({ calleeName: "foo", caller, sourceFile: "src/a.ts" }, deps);
    // Legacy: first non-caller global match (NOT a refusal).
    expect(target?.id).toBe("f1");
  });

  it("still resolves to a same-name NON-callable (no kind filtering when off)", () => {
    const caller = sym("caller", "handler", "src/a.ts");
    const variable = sym("var", "foo", "src/b.ts", { kind: "variable" });
    const deps = depsFor([caller, variable], false);
    const target = selectSingle({ calleeName: "foo", caller, sourceFile: "src/a.ts", callForm: "free" }, deps);
    expect(target?.id).toBe("var");
  });

  it("prefers a same-file symbol over a global match (parity)", () => {
    const caller = sym("caller", "handler", "src/a.ts");
    const local = sym("local", "doWork", "src/a.ts");
    const remote = sym("remote", "doWork", "src/b.ts");
    const deps = depsFor([caller, local, remote], false);
    const target = selectSingle({ calleeName: "doWork", caller, sourceFile: "src/a.ts" }, deps);
    expect(target?.id).toBe("local");
  });

  it("ignores argCount/callForm entirely when off (no arity narrowing)", () => {
    const caller = sym("caller", "handler", "src/a.ts");
    const f1 = sym("f1", "foo", "src/b.ts", { kind: "function", parameterCount: 1 });
    const f2 = sym("f2", "foo", "src/c.ts", { kind: "function", parameterCount: 2 });
    const deps = depsFor([caller, f1, f2], false);
    // argCount=2 would pick f2 under the filtered path; off → legacy first-match f1.
    const target = selectSingle({ calleeName: "foo", caller, sourceFile: "src/a.ts", argCount: 2, callForm: "free" }, deps);
    expect(target?.id).toBe("f1");
  });
});
