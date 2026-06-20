/**
 * E1 step 2 — ScopeResolver registry tests.
 *
 * Asserts the registry returns concrete per-language resolvers for the five
 * supported languages, the parity `DEFAULT_RESOLVER` for everything else, and
 * that the shared `selectSingle` selector reproduces today's exact call-target
 * choice (tiered same-file hit → global name fallback, excluding the caller).
 */
import { describe, it, expect } from "vitest";
import type { Symbol } from "../../../core/domain.js";
import {
  getScopeResolver,
  DEFAULT_RESOLVER,
  selectSingle,
  type CallResolutionDeps,
} from "./scope-resolver.js";
import "./resolvers/index.js";
import { createResolutionContext } from "./resolution-context.js";
import { buildSymbolMap } from "./index.js";

function sym(id: string, name: string, filePath: string): Symbol {
  return {
    id,
    logicalKey: id,
    name,
    kind: "function",
    visibility: "public",
    modifiers: [],
    location: { filePath, startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 },
  };
}

describe("getScopeResolver", () => {
  it("returns concrete resolvers for the five supported languages", () => {
    expect(getScopeResolver("typescript").language).toBe("typescript");
    expect(getScopeResolver("python").language).toBe("python");
    expect(getScopeResolver("java").language).toBe("java");
    expect(getScopeResolver("php").language).toBe("php");
    expect(getScopeResolver("go").language).toBe("go");
  });

  it("falls back to the parity DEFAULT_RESOLVER for unmapped languages", () => {
    const r = getScopeResolver("ruby");
    expect(r).toBe(DEFAULT_RESOLVER);
    expect(r.strategy).toBe("single");
    expect(r.propagatesReturnTypes).toBe(false);
  });

  it("every built-in resolver uses selectSingle as its fallback selector", () => {
    for (const lang of ["typescript", "javascript", "python", "java", "php", "go"] as const) {
      expect(getScopeResolver(lang).selectCallTarget).toBe(selectSingle);
    }
  });
});

describe("selectSingle (parity selector)", () => {
  function depsFor(symbols: Symbol[]): CallResolutionDeps {
    const ctx = createResolutionContext();
    for (const s of symbols) ctx.symbols.add(s.location.filePath, s.name, s.id, s.kind);
    const symbolById = new Map(symbols.map((s) => [s.id, s]));
    return { ctx, symbolById, symbolMap: buildSymbolMap(symbols) };
  }

  it("prefers a same-file symbol over a global match", () => {
    const caller = sym("caller", "handler", "src/a.ts");
    const local = sym("local", "doWork", "src/a.ts");
    const remote = sym("remote", "doWork", "src/b.ts");
    const deps = depsFor([caller, local, remote]);
    const target = selectSingle(
      { calleeName: "doWork", caller, sourceFile: "src/a.ts" },
      deps,
    );
    expect(target?.id).toBe("local");
  });

  it("falls back to the first non-caller global name match", () => {
    const caller = sym("caller", "handler", "src/a.ts");
    const remote = sym("remote", "doWork", "src/b.ts");
    const deps = depsFor([caller, remote]);
    const target = selectSingle(
      { calleeName: "doWork", caller, sourceFile: "src/a.ts" },
      deps,
    );
    expect(target?.id).toBe("remote");
  });

  it("never returns the caller itself (self-call excluded)", () => {
    const caller = sym("rec", "recurse", "src/a.ts");
    const deps = depsFor([caller]);
    const target = selectSingle(
      { calleeName: "recurse", caller, sourceFile: "src/a.ts" },
      deps,
    );
    expect(target).toBeUndefined();
  });
});
