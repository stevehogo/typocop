import { describe, it, expect } from "vitest";
import { walkBindingChain, isFileInPackageDir } from "./named-binding.js";
import { createSymbolTable } from "./symbol-table.js";
import type { NamedImportMap } from "./named-binding.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMap(entries: [string, [string, { sourcePath: string; exportedName: string }][]][]): NamedImportMap {
  return new Map(
    entries.map(([file, bindings]) => [file, new Map(bindings)])
  );
}

// ─── walkBindingChain ─────────────────────────────────────────────────────────

describe("walkBindingChain", () => {
  it("resolves a 2-hop chain (A→B→C)", () => {
    // A imports { User } from B; B re-exports { User } from C; C defines User
    const table = createSymbolTable();
    table.add("src/c.ts", "User", "sym-user", "class");

    const namedImportMap = makeMap([
      ["src/a.ts", [["User", { sourcePath: "src/b.ts", exportedName: "User" }]]],
      ["src/b.ts", [["User", { sourcePath: "src/c.ts", exportedName: "User" }]]],
    ]);

    const allDefs = table.lookupFuzzy("User");
    const result = walkBindingChain("User", "src/a.ts", table, namedImportMap, allDefs);

    expect(result).not.toBeNull();
    expect(result![0].nodeId).toBe("sym-user");
  });

  it("returns null on circular reference (A→B→A)", () => {
    const table = createSymbolTable();
    const namedImportMap = makeMap([
      ["src/a.ts", [["Foo", { sourcePath: "src/b.ts", exportedName: "Foo" }]]],
      ["src/b.ts", [["Foo", { sourcePath: "src/a.ts", exportedName: "Foo" }]]],
    ]);

    const result = walkBindingChain("Foo", "src/a.ts", table, namedImportMap, []);
    expect(result).toBeNull();
  });

  it("returns null when chain depth exceeds 5", () => {
    const table = createSymbolTable();
    // Build a chain: a→b→c→d→e→f (6 hops, exceeds max depth of 5)
    const files = ["a", "b", "c", "d", "e", "f"].map((x) => `src/${x}.ts`);
    const entries: [string, [string, { sourcePath: string; exportedName: string }][]][] =
      files.slice(0, -1).map((f, i) => [f, [["X", { sourcePath: files[i + 1], exportedName: "X" }]]]);
    const namedImportMap = makeMap(entries);

    const result = walkBindingChain("X", files[0], table, namedImportMap, []);
    expect(result).toBeNull();
  });

  it("returns null when binding is missing at any hop", () => {
    const table = createSymbolTable();
    // A→B but B has no binding for "Foo"
    const namedImportMap = makeMap([
      ["src/a.ts", [["Foo", { sourcePath: "src/b.ts", exportedName: "Foo" }]]],
      // src/b.ts has no entry
    ]);

    const result = walkBindingChain("Foo", "src/a.ts", table, namedImportMap, []);
    expect(result).toBeNull();
  });
});

// ─── isFileInPackageDir ───────────────────────────────────────────────────────

describe("isFileInPackageDir", () => {
  it("matches mid-path pattern", () => {
    expect(isFileInPackageDir("src/auth/service.ts", "auth")).toBe(true);
  });

  it("matches suffix pattern", () => {
    expect(isFileInPackageDir("src/auth", "auth")).toBe(true);
  });

  it("does not match partial segment names", () => {
    expect(isFileInPackageDir("src/authentication/service.ts", "auth")).toBe(false);
  });

  it("returns false for unrelated path", () => {
    expect(isFileInPackageDir("src/user/service.ts", "auth")).toBe(false);
  });
});
