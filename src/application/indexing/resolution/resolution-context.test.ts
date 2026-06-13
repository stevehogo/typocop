import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  createResolutionContext,
  TIER_CONFIDENCE,
} from "./resolution-context.js";
import { symbolArbitrary } from "../../../types/arbitraries.js";

// ─── Example tests ────────────────────────────────────────────────────────────

describe("TIER_CONFIDENCE values", () => {
  it("RC-E1: matches spec — 0.95 / 0.90 / 0.50", () => {
    expect(TIER_CONFIDENCE["same-file"]).toBe(0.95);
    expect(TIER_CONFIDENCE["import-scoped"]).toBe(0.90);
    expect(TIER_CONFIDENCE["global"]).toBe(0.50);
  });
});

describe("Tier 1: same-file resolution", () => {
  it("returns same-file tier when symbol is defined in fromFile", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/a.ts", "Foo", "sym-1", "class");
    const result = ctx.resolve("Foo", "src/a.ts");
    expect(result?.tier).toBe("same-file");
    expect(result?.candidates[0].nodeId).toBe("sym-1");
  });

  it("returns exactly one candidate at Tier 1", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/a.ts", "Foo", "sym-1", "class");
    ctx.symbols.add("src/b.ts", "Foo", "sym-2", "class");
    const result = ctx.resolve("Foo", "src/a.ts");
    expect(result?.tier).toBe("same-file");
    expect(result?.candidates).toHaveLength(1);
  });
});

describe("Tier 2a-named: named binding chain", () => {
  it("RC-E2: resolves aliased import chain A→B→C", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/c.ts", "User", "sym-user", "class");
    ctx.namedImportMap.set("src/a.ts", new Map([["User", { sourcePath: "src/b.ts", exportedName: "User" }]]));
    ctx.namedImportMap.set("src/b.ts", new Map([["User", { sourcePath: "src/c.ts", exportedName: "User" }]]));

    const result = ctx.resolve("User", "src/a.ts");
    expect(result?.tier).toBe("import-scoped");
    expect(result?.candidates[0].nodeId).toBe("sym-user");
  });

  it("RC-E3: circular chain returns null (falls through to global)", () => {
    const ctx = createResolutionContext();
    ctx.namedImportMap.set("src/a.ts", new Map([["Foo", { sourcePath: "src/b.ts", exportedName: "Foo" }]]));
    ctx.namedImportMap.set("src/b.ts", new Map([["Foo", { sourcePath: "src/a.ts", exportedName: "Foo" }]]));

    const result = ctx.resolve("Foo", "src/a.ts");
    expect(result).toBeNull(); // no symbol defined anywhere
  });

  it("RC-E4: chain depth > 5 returns null", () => {
    const ctx = createResolutionContext();
    const files = ["a", "b", "c", "d", "e", "f", "g"].map((x) => `src/${x}.ts`);
    files.slice(0, -1).forEach((f, i) => {
      ctx.namedImportMap.set(f, new Map([["X", { sourcePath: files[i + 1], exportedName: "X" }]]));
    });

    const result = ctx.resolve("X", files[0]);
    expect(result).toBeNull();
  });
});

describe("Tier 2a: import-scoped resolution", () => {
  it("returns import-scoped tier when symbol is in an imported file", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/b.ts", "Logger", "sym-log", "class");
    ctx.importMap.set("src/a.ts", new Set(["src/b.ts"]));

    const result = ctx.resolve("Logger", "src/a.ts");
    expect(result?.tier).toBe("import-scoped");
    expect(result?.candidates[0].nodeId).toBe("sym-log");
  });

  it("RC-E7: Tier 2b package-scoped resolution", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/auth/service.ts", "AuthService", "sym-auth", "class");
    ctx.packageMap.set("src/app.ts", new Set(["auth"]));

    const result = ctx.resolve("AuthService", "src/app.ts");
    expect(result?.tier).toBe("import-scoped");
    expect(result?.candidates[0].nodeId).toBe("sym-auth");
  });
});

describe("Tier 3: global fallback", () => {
  it("returns global tier when no maps are populated", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/b.ts", "Helper", "sym-h", "function");

    const result = ctx.resolve("Helper", "src/a.ts");
    expect(result?.tier).toBe("global");
  });

  it("returns null when symbol does not exist anywhere", () => {
    const ctx = createResolutionContext();
    expect(ctx.resolve("Ghost", "src/a.ts")).toBeNull();
  });
});

describe("Cache lifecycle", () => {
  it("RC-E5: cache hit returns identical result to uncached", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/b.ts", "Svc", "sym-1", "class");

    const uncached = ctx.resolve("Svc", "src/a.ts");
    ctx.enableCache("src/a.ts");
    const first = ctx.resolve("Svc", "src/a.ts");  // miss → stored
    const second = ctx.resolve("Svc", "src/a.ts"); // hit

    expect(first).toEqual(uncached);
    expect(second).toEqual(uncached);
  });

  it("RC-E6: cacheHits + cacheMisses = total calls when cache active", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/b.ts", "X", "sym-x", "function");
    ctx.enableCache("src/a.ts");

    ctx.resolve("X", "src/a.ts"); // miss
    ctx.resolve("X", "src/a.ts"); // hit
    ctx.resolve("X", "src/a.ts"); // hit

    const stats = ctx.getStats();
    expect(stats.cacheHits + stats.cacheMisses).toBe(3);
    expect(stats.cacheHits).toBe(2);
    expect(stats.cacheMisses).toBe(1);
  });

  it("RC-E6: enableCache switches file and invalidates previous cache", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/b.ts", "X", "sym-x", "function");
    ctx.enableCache("src/a.ts");
    ctx.resolve("X", "src/a.ts"); // miss for a.ts

    ctx.enableCache("src/c.ts"); // switch — clears cache
    ctx.resolve("X", "src/c.ts"); // miss for c.ts (not a hit)

    const stats = ctx.getStats();
    expect(stats.cacheMisses).toBe(2);
    expect(stats.cacheHits).toBe(0);
  });
});

describe("clear()", () => {
  it("RC-E5: resets all state to zero", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/a.ts", "Foo", "sym-1", "class");
    ctx.importMap.set("src/b.ts", new Set(["src/a.ts"]));
    ctx.enableCache("src/a.ts");
    ctx.resolve("Foo", "src/a.ts");

    ctx.clear();

    expect(ctx.resolve("Foo", "src/a.ts")).toBeNull();
    expect(ctx.getStats()).toEqual({ fileCount: 0, globalSymbolCount: 0, cacheHits: 0, cacheMisses: 0 });
    expect(ctx.importMap.size).toBe(0);
  });
});

// ─── Property tests ───────────────────────────────────────────────────────────

describe("Property RC-1: non-null result always has non-empty candidates", () => {
  it("holds for any symbol set", () => {
    fc.assert(
      fc.property(
        fc.array(symbolArbitrary(), { minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1 }),
        (symbols, fromFile) => {
          const ctx = createResolutionContext();
          for (const s of symbols) {
            ctx.symbols.add(s.location.filePath, s.name, s.id, s.kind);
          }
          const result = ctx.resolve(symbols[0].name, fromFile);
          if (result === null) return true;
          return result.candidates.length > 0;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("Property RC-2: Tier 1 returns exactly one candidate from same file", () => {
  it("holds for any symbol", () => {
    fc.assert(
      fc.property(symbolArbitrary(), (sym) => {
        const ctx = createResolutionContext();
        ctx.symbols.add(sym.location.filePath, sym.name, sym.id, sym.kind);
        const result = ctx.resolve(sym.name, sym.location.filePath);
        return result?.tier === "same-file" && result.candidates.length === 1;
      }),
      { numRuns: 100 }
    );
  });
});

describe("Property RC-3: Tier 2a candidates are all in importMap[fromFile]", () => {
  it("holds for any symbol set with import map", () => {
    fc.assert(
      fc.property(
        fc.array(symbolArbitrary(), { minLength: 1, maxLength: 10 }),
        (symbols) => {
          const ctx = createResolutionContext();
          const fromFile = "src/consumer.ts";
          const importedFiles = new Set(symbols.map((s) => s.location.filePath));
          ctx.importMap.set(fromFile, importedFiles);
          for (const s of symbols) {
            ctx.symbols.add(s.location.filePath, s.name, s.id, s.kind);
          }
          const result = ctx.resolve(symbols[0].name, fromFile);
          if (!result || result.tier !== "import-scoped") return true;
          return result.candidates.every((c) => importedFiles.has(c.filePath));
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("Property RC-4: Tier 3 returns all lookupFuzzy candidates when no maps populated", () => {
  it("holds for any symbol set", () => {
    fc.assert(
      fc.property(
        fc.array(symbolArbitrary(), { minLength: 1, maxLength: 10 }),
        (symbols) => {
          const ctx = createResolutionContext();
          const fromFile = "src/other.ts"; // not in any symbol's filePath
          for (const s of symbols) {
            ctx.symbols.add(s.location.filePath, s.name, s.id, s.kind);
          }
          const name = symbols[0].name;
          const fuzzy = ctx.symbols.lookupFuzzy(name);
          const result = ctx.resolve(name, fromFile);
          if (!result || result.tier !== "global") return true;
          return result.candidates.length === fuzzy.length;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("Property RC-5: cache hit returns identical result to uncached", () => {
  it("holds for any symbol and file", () => {
    fc.assert(
      fc.property(symbolArbitrary(), (sym) => {
        const ctx = createResolutionContext();
        ctx.symbols.add(sym.location.filePath, sym.name, sym.id, sym.kind);
        const fromFile = "src/consumer.ts";

        const uncached = ctx.resolve(sym.name, fromFile);
        ctx.enableCache(fromFile);
        ctx.resolve(sym.name, fromFile); // populate cache
        const cached = ctx.resolve(sym.name, fromFile); // hit

        return JSON.stringify(uncached) === JSON.stringify(cached);
      }),
      { numRuns: 100 }
    );
  });
});

describe("Property RC-7: resolve() never mutates the symbol table", () => {
  it("holds for any symbol set", () => {
    fc.assert(
      fc.property(
        fc.array(symbolArbitrary(), { minLength: 0, maxLength: 10 }),
        (symbols) => {
          const ctx = createResolutionContext();
          for (const s of symbols) {
            ctx.symbols.add(s.location.filePath, s.name, s.id, s.kind);
          }
          const before = ctx.getStats();
          for (const s of symbols) {
            ctx.resolve(s.name, s.location.filePath);
          }
          const after = ctx.getStats();
          return before.fileCount === after.fileCount && before.globalSymbolCount === after.globalSymbolCount;
        }
      ),
      { numRuns: 100 }
    );
  });
});
