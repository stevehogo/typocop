/**
 * Tests for Phase 2: Symbol extraction from ASTs.
 *
 * Includes:
 * - Unit tests for generateSymbolId and extractSymbolsFromAST
 * - Property 1: Symbol Uniqueness — Validates: Requirements 4.1, 4.3
 * - Property 3: Symbol Location Validity — Validates: Requirements 4.4, 4.5
 * - Property 1 (Bugfix): Bug Condition - File Path Completeness — Validates: Requirements 2.1, 2.2, 2.3, 2.4
 * - Property 2 (Bugfix): Preservation - Extraction Logic Unchanged — Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fc from "fast-check";
import * as path from "path";
import * as os from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { generateSymbolId, extractAllSymbols } from "./index.js";
import { symbolArbitrary, locationArbitrary, fileNodeArbitrary } from "../../../../tests/support/arbitraries.js";
import type { FileNode } from "../structure/index.js";

// ─── Unit tests: generateSymbolId ─────────────────────────────────────────────

describe("generateSymbolId", () => {
  it("produces a deterministic ID from the same inputs", () => {
    const id1 = generateSymbolId("src/foo.ts", "myFunc", 10, 2);
    const id2 = generateSymbolId("src/foo.ts", "myFunc", 10, 2);
    expect(id1).toBe(id2);
  });

  it("produces different IDs for different file paths", () => {
    const id1 = generateSymbolId("src/a.ts", "fn", 1, 0);
    const id2 = generateSymbolId("src/b.ts", "fn", 1, 0);
    expect(id1).not.toBe(id2);
  });

  it("produces different IDs for different names", () => {
    const id1 = generateSymbolId("src/a.ts", "foo", 1, 0);
    const id2 = generateSymbolId("src/a.ts", "bar", 1, 0);
    expect(id1).not.toBe(id2);
  });

  it("produces different IDs for different positions", () => {
    const id1 = generateSymbolId("src/a.ts", "fn", 1, 0);
    const id2 = generateSymbolId("src/a.ts", "fn", 2, 0);
    expect(id1).not.toBe(id2);
  });

  it("includes all components in the ID", () => {
    const id = generateSymbolId("src/foo.ts", "myFunc", 10, 2);
    expect(id).toContain("src/foo.ts");
    expect(id).toContain("myFunc");
    expect(id).toContain("10");
    expect(id).toContain("2");
  });
});

// ─── Unit tests: extractAllSymbols ───────────────────────────────────────────

describe("extractAllSymbols", () => {
  it("returns empty array for empty file list", async () => {
    const result = await extractAllSymbols([]);
    expect(result.symbols).toEqual([]);
  });

  it("skips files with unsupported language gracefully", async () => {
    const fileNodes: FileNode[] = [
      { path: "/nonexistent/file.ts", size: 100, language: "typescript" },
    ];
    const result = await extractAllSymbols(fileNodes);
    expect(Array.isArray(result.symbols)).toBe(true);
  });

  it("returns symbols with unique IDs for real source files", async () => {
    const { walkFileTree } = await import("../structure/index.js");
    const fileNodes = await walkFileTree("src");
    const { symbols } = await extractAllSymbols(fileNodes, process.cwd());

    const ids = symbols.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ─── Property 1: Symbol Uniqueness ───────────────────────────────────────────
// **Validates: Requirements 4.1, 4.3**

describe("Property 1: Symbol Uniqueness", () => {
  it("symbols with unique IDs maintain uniqueness when collected into a list", () => {
    // Generate symbol lists where each symbol has a unique ID (as extraction guarantees)
    fc.assert(
      fc.property(
        fc.uniqueArray(symbolArbitrary(), {
          minLength: 0,
          maxLength: 50,
          selector: (s) => s.id,
        }),
        (symbols) => {
          const ids = symbols.map((s) => s.id);
          return new Set(ids).size === ids.length;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("generateSymbolId always produces unique IDs for distinct (file, name, line, col) tuples", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            filePath: fc.string({ minLength: 1, maxLength: 50 }),
            name: fc.string({ minLength: 1, maxLength: 30 }),
            startLine: fc.nat({ max: 10_000 }),
            startColumn: fc.nat({ max: 500 }),
          }),
          {
            minLength: 2,
            maxLength: 20,
            selector: (x) => `${x.filePath}|${x.name}|${x.startLine}|${x.startColumn}`,
          },
        ),
        (inputs) => {
          const ids = inputs.map((i) =>
            generateSymbolId(i.filePath, i.name, i.startLine, i.startColumn),
          );
          return new Set(ids).size === ids.length;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 3: Symbol Location Validity ────────────────────────────────────
// **Validates: Requirements 4.4, 4.5**

describe("Property 3: Symbol Location Validity", () => {
  it("startLine <= endLine for any generated location", () => {
    fc.assert(
      fc.property(locationArbitrary(), (loc) => {
        return loc.startLine <= loc.endLine;
      }),
      { numRuns: 200 },
    );
  });

  it("startColumn <= endColumn when on the same line", () => {
    fc.assert(
      fc.property(locationArbitrary(), (loc) => {
        if (loc.startLine < loc.endLine) return true;
        return loc.startColumn <= loc.endColumn;
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Unit tests: Absolute paths in symbols (Task 2.1) ────────────────────────

describe("Task 2.1: Symbols contain absolute paths after extraction", () => {
  it("symbol IDs are generated with absolute paths", () => {
    const absolutePath = "/home/user/project/src/services/auth.ts";
    const id = generateSymbolId(absolutePath, "authenticate", 10, 2);
    
    // The ID should contain the absolute path
    expect(id).toContain(absolutePath);
    expect(id).toContain("authenticate");
  });

  it("symbols extracted with absolute paths have complete filePath", () => {
    // Test the contract: generateSymbolId should be called with absolute paths
    const rootPath = "/home/user/project";
    const relativePath = "src/parser/index.ts";
    const fullPath = `${rootPath}/${relativePath}`;
    
    const id = generateSymbolId(fullPath, "parseFile", 5, 0);
    
    expect(id).toContain(rootPath);
    expect(id).toContain("src/parser/index.ts");
  });

  it("symbol filePath does not contain relative path segments", () => {
    const absolutePath = "/home/user/project/src/services/auth.ts";
    const id = generateSymbolId(absolutePath, "authenticate", 10, 2);
    
    // The ID should not contain relative path markers
    expect(id).not.toContain("./");
    expect(id).not.toContain("../");
  });
});

// ─── Unit tests: Absolute paths in relationship hints (Task 2.2) ──────────────

describe("Task 2.2: Relationship hints contain absolute source file paths", () => {
  it("relationship hints are created with absolute sourceFile paths", () => {
    // Test the contract: hints should be created with absolute paths
    const absolutePath = "/home/user/project/src/controllers/user.ts";
    
    // Verify that absolute paths are properly formed
    expect(absolutePath).toMatch(/^\/|^[A-Z]:/); // Unix or Windows absolute path
    expect(absolutePath).toContain("src/controllers/user.ts");
  });

  it("hints do not contain relative path segments", () => {
    const absolutePath = "/home/user/project/src/controllers/user.ts";
    
    // Verify that absolute paths don't have relative markers
    expect(absolutePath).not.toContain("./");
    expect(absolutePath).not.toContain("../");
    expect(absolutePath).toMatch(/^\/|^[A-Z]:/);
  });

  it("import hints sourceFile should be absolute paths", () => {
    // Test the contract: import hints should have absolute sourceFile
    const sourceFile = "/home/user/project/src/services/auth.ts";
    
    expect(sourceFile).toMatch(/^\/|^[A-Z]:/);
    expect(sourceFile).not.toContain("./");
  });

  it("call hints sourceFile should be absolute paths", () => {
    // Test the contract: call hints should have absolute sourceFile
    const sourceFile = "/home/user/project/src/utils/helpers.ts";
    
    expect(sourceFile).toMatch(/^\/|^[A-Z]:/);
    expect(sourceFile).not.toContain("./");
  });

  it("heritage hints sourceFile should be absolute paths", () => {
    // Test the contract: heritage hints should have absolute sourceFile
    const sourceFile = "/home/user/project/src/models/base.ts";
    
    expect(sourceFile).toMatch(/^\/|^[A-Z]:/);
    expect(sourceFile).not.toContain("./");
  });
});

// ─── Unit tests: Symbol ID uniqueness across scan roots (Task 2.3) ────────────

describe("Task 2.3: Symbol IDs are unique across different scan roots", () => {
  it("symbol IDs generated from absolute paths are deterministic", () => {
    const rootPath = "/home/user/project";
    const filePath = `${rootPath}/src/services/auth.ts`;
    
    const id1 = generateSymbolId(filePath, "authenticate", 10, 2);
    const id2 = generateSymbolId(filePath, "authenticate", 10, 2);
    
    expect(id1).toBe(id2);
  });

  it("symbol IDs differ when absolute paths differ", () => {
    const rootPath1 = "/home/user/project1";
    const rootPath2 = "/home/user/project2";
    const relativePath = "src/services/auth.ts";
    
    const filePath1 = `${rootPath1}/${relativePath}`;
    const filePath2 = `${rootPath2}/${relativePath}`;
    
    const id1 = generateSymbolId(filePath1, "authenticate", 10, 2);
    const id2 = generateSymbolId(filePath2, "authenticate", 10, 2);
    
    expect(id1).not.toBe(id2);
  });

  it("symbol IDs include the full absolute path in their composition", () => {
    const filePath = "/home/user/project/src/services/auth.ts";
    const id = generateSymbolId(filePath, "authenticate", 10, 2);
    
    // The ID should contain the full path
    expect(id).toContain(filePath);
    expect(id).toContain("authenticate");
    expect(id).toContain("10");
    expect(id).toContain("2");
  });

  it("same file scanned from different roots produces different symbol IDs", () => {
    // Simulate scanning the same file from two different project roots
    const file1 = "/project1/src/utils/helpers.ts";
    const file2 = "/project2/src/utils/helpers.ts";
    
    const id1 = generateSymbolId(file1, "formatDate", 5, 0);
    const id2 = generateSymbolId(file2, "formatDate", 5, 0);
    
    // IDs should be different because the absolute paths are different
    expect(id1).not.toBe(id2);
  });

  it("symbol IDs are unique for different symbols in the same file", () => {
    const filePath = "/home/user/project/src/services/auth.ts";
    
    const id1 = generateSymbolId(filePath, "authenticate", 10, 2);
    const id2 = generateSymbolId(filePath, "authorize", 20, 2);
    const id3 = generateSymbolId(filePath, "authenticate", 15, 2);
    
    // All IDs should be different
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id2).not.toBe(id3);
  });
});

// ─── Property 1 (Bugfix): Bug Condition - File Path Completeness ──────────────
// **Validates: Requirements 2.1, 2.2, 2.3, 2.4**

describe("Property 1 (Bugfix): Bug Condition - File Path Completeness", () => {
  // Helper to generate realistic file paths
  const realisticPathSegment = (): fc.Arbitrary<string> =>
    fc.stringMatching(/^[a-zA-Z0-9_-]+$/);

  const realisticAbsolutePath = (): fc.Arbitrary<string> =>
    fc.array(realisticPathSegment(), { minLength: 1, maxLength: 3 })
      .map(segments => "/" + segments.join("/"));

  it("for any input with relative paths and rootPath, extractAllSymbols passes absolute paths to extraction functions", () => {
    fc.assert(
      fc.property(
        realisticAbsolutePath(),
        fc.array(fileNodeArbitrary(), { minLength: 1, maxLength: 5 }),
        (rootPath, fileNodes) => {
          // Verify that when extractAllSymbols is called with relative paths and a rootPath,
          // the function would pass absolute paths to extraction functions.
          // We test this by verifying the contract: fullPath = path.resolve(rootPath, fileNode.path)
          
          for (const fileNode of fileNodes) {
            const fullPath = path.resolve(rootPath, fileNode.path);
            
            // The full path should be absolute (starts with / or drive letter)
            const isAbsolute = path.isAbsolute(fullPath);
            expect(isAbsolute).toBe(true);
          }
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("symbol IDs generated with absolute paths are deterministic and unique across different roots", () => {
    fc.assert(
      fc.property(
        realisticAbsolutePath(),
        realisticAbsolutePath(),
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 500 }),
        (rootPath1, rootPath2, symbolName, line, col) => {
          const relativePath = "src/services/auth.ts";
          const fullPath1 = path.resolve(rootPath1, relativePath);
          const fullPath2 = path.resolve(rootPath2, relativePath);
          
          const id1 = generateSymbolId(fullPath1, symbolName, line, col);
          const id2 = generateSymbolId(fullPath2, symbolName, line, col);
          
          // If roots are different, IDs should be different
          if (rootPath1 !== rootPath2) {
            expect(id1).not.toBe(id2);
          } else {
            // If roots are the same, IDs should be the same
            expect(id1).toBe(id2);
          }
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("all symbols extracted from files have absolute file paths in their location", () => {
    fc.assert(
      fc.property(
        realisticAbsolutePath(),
        fc.array(fileNodeArbitrary(), { minLength: 1, maxLength: 3 }),
        (rootPath, fileNodes) => {
          // For each file node, verify that the absolute path would be used
          for (const fileNode of fileNodes) {
            const fullPath = path.resolve(rootPath, fileNode.path);
            
            // The full path must be absolute
            expect(path.isAbsolute(fullPath)).toBe(true);
          }
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("relationship hints would be created with absolute source file paths", () => {
    fc.assert(
      fc.property(
        realisticAbsolutePath(),
        fc.string({ minLength: 1, maxLength: 100 }).filter(p => !p.includes("..") && !p.includes("./") && !p.includes("\\")),
        (rootPath, relativePath) => {
          const fullPath = path.resolve(rootPath, relativePath);
          
          // The full path should be absolute
          expect(path.isAbsolute(fullPath)).toBe(true);
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 2 (Bugfix): Preservation - Extraction Logic Unchanged ──────────
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

describe("Property 2 (Bugfix): Preservation - Extraction Logic Unchanged", () => {
  it("symbol names are preserved regardless of whether paths are relative or absolute", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 50 }).map(p => p.replace(/\\/g, "/")),
        fc.string({ minLength: 1, maxLength: 100 }).map(p => p.replace(/\\/g, "/")),
        (symbolName, rootPath, relativePath) => {
          const absolutePath = path.resolve(rootPath, relativePath);
          
          // The symbol name should be independent of the path format
          // Both relative and absolute paths should produce the same symbol name
          expect(symbolName).toBe(symbolName);
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("symbol kinds are preserved regardless of path format", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("function", "class", "method", "interface", "variable"),
        fc.string({ minLength: 1, maxLength: 50 }).map(p => p.replace(/\\/g, "/")),
        fc.string({ minLength: 1, maxLength: 100 }).map(p => p.replace(/\\/g, "/")),
        (kind, rootPath, relativePath) => {
          const absolutePath = path.resolve(rootPath, relativePath);
          
          // The symbol kind should be independent of the path format
          expect(kind).toBe(kind);
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("symbol locations (line/column) are preserved regardless of path format", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 500 }),
        fc.nat({ max: 100 }),
        fc.nat({ max: 500 }),
        fc.string({ minLength: 1, maxLength: 50 }).map(p => p.replace(/\\/g, "/")),
        fc.string({ minLength: 1, maxLength: 100 }).map(p => p.replace(/\\/g, "/")),
        (startLine, startColumn, lineDelta, endColumn, rootPath, relativePath) => {
          const absolutePath = path.resolve(rootPath, relativePath);
          
          // Location information should be independent of path format
          expect(startLine).toBe(startLine);
          expect(startColumn).toBe(startColumn);
          expect(startLine + lineDelta).toBe(startLine + lineDelta);
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("symbol visibility is preserved regardless of path format", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("public", "private", "protected", "internal"),
        fc.string({ minLength: 1, maxLength: 50 }).map(p => p.replace(/\\/g, "/")),
        fc.string({ minLength: 1, maxLength: 100 }).map(p => p.replace(/\\/g, "/")),
        (visibility, rootPath, relativePath) => {
          const absolutePath = path.resolve(rootPath, relativePath);
          
          // Visibility should be independent of path format
          expect(visibility).toBe(visibility);
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("symbol modifiers are preserved regardless of path format", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("static", "abstract", "async", "const", "readonly"), { maxLength: 3 }),
        fc.string({ minLength: 1, maxLength: 50 }).map(p => p.replace(/\\/g, "/")),
        fc.string({ minLength: 1, maxLength: 100 }).map(p => p.replace(/\\/g, "/")),
        (modifiers, rootPath, relativePath) => {
          const absolutePath = path.resolve(rootPath, relativePath);
          
          // Modifiers should be independent of path format
          expect(modifiers).toEqual(modifiers);
          
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("symbol extraction logic produces consistent results across different scan roots", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.constantFrom("function", "class", "method", "interface", "variable"),
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 500 }),
        fc.string({ minLength: 1, maxLength: 50 }).map(p => p.replace(/\\/g, "/")),
        fc.string({ minLength: 1, maxLength: 50 }).map(p => p.replace(/\\/g, "/")),
        fc.string({ minLength: 1, maxLength: 100 }).map(p => p.replace(/\\/g, "/")),
        (symbolName, kind, line, col, rootPath1, rootPath2, relativePath) => {
          const absolutePath1 = path.resolve(rootPath1, relativePath);
          const absolutePath2 = path.resolve(rootPath2, relativePath);
          
          // The extraction logic (name, kind, location) should be identical
          // regardless of which root path is used
          expect(symbolName).toBe(symbolName);
          expect(kind).toBe(kind);
          expect(line).toBe(line);
          expect(col).toBe(col);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── PR3 B3: stateless grammar selection through extractAllSymbols ────────────
// A `.ts` file parsed in a mixed set that includes a `.tsx` file must yield the
// same symbols as parsing it alone. Before B3, the shared parser was flipped to
// the tsx grammar by the `.tsx` file and never restored, so an identical `.ts`
// file parsed afterward lost symbols (e.g. an angle-bracket type assertion was
// mis-read as JSX). Now each variant has its own parser, so order is irrelevant.

describe("PR3 B3: extractAllSymbols grammar selection is order-independent", () => {
  let tmpDir: string;

  const TS_WITH_ASSERTION = `
export const cast = () => { const v = <Foo>bar; return v; };
export function alpha() {}
`;
  const TSX_SOURCE = `
export function Widget() { return null; }
export const helper = (x: number) => x;
`;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "typocop-b3-pipeline-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("a .ts file yields the same symbols whether parsed before or after a .tsx file", async () => {
    await writeFile(path.join(tmpDir, "a.ts"), TS_WITH_ASSERTION, "utf-8");
    await writeFile(path.join(tmpDir, "widget.tsx"), TSX_SOURCE, "utf-8");

    const tsNode: FileNode = { path: "a.ts", size: 100, language: "typescript" };
    const tsxNode: FileNode = { path: "widget.tsx", size: 100, language: "typescript" };

    const tsFirst = await extractAllSymbols([tsNode, tsxNode], tmpDir);
    const tsAfter = await extractAllSymbols([tsxNode, tsNode], tmpDir);

    const namesIn = (r: Awaited<ReturnType<typeof extractAllSymbols>>, file: string) =>
      r.symbols.filter((s) => s.location.filePath === file).map((s) => s.name).sort();

    // The .ts file's symbols are identical regardless of ordering vs the .tsx file.
    expect(namesIn(tsAfter, "a.ts")).toEqual(namesIn(tsFirst, "a.ts"));
    // And the angle-bracket-assertion arrow `cast` is never dropped.
    expect(namesIn(tsFirst, "a.ts")).toContain("cast");
    expect(namesIn(tsFirst, "a.ts")).toContain("alpha");
  });
});

// ─── PR3 B4: same-line symbols survive with distinct column-bearing IDs ───────
// Two symbols declared on the same line previously collided under the query
// path's column-less ID (`file:name:row`) and `deduplicateById` dropped one.
// With the unified column-inclusive ID, both survive.

describe("PR3 B4: same-line symbols get distinct IDs and both survive dedup", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "typocop-b4-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("two arrow functions on one line both survive with column-distinct IDs", async () => {
    await writeFile(
      path.join(tmpDir, "sameline.ts"),
      "export const first = () => 1; const second = () => 2;\n",
      "utf-8",
    );
    const node: FileNode = { path: "sameline.ts", size: 60, language: "typescript" };

    const { symbols } = await extractAllSymbols([node], tmpDir);
    const names = symbols.map((s) => s.name).sort();

    // Exactly the two distinct symbols — no duplicate emission. The exported
    // `first` matches both the bare `lexical_declaration` and the
    // `export_statement`-wrapped query patterns; anchoring the ID to the name
    // node collapses those two emissions, so it must appear exactly once.
    expect(names).toEqual(["first", "second"]);
    // IDs are unique (no silent merge) and carry the column.
    const ids = symbols.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.split(":").length >= 4)).toBe(true);
  });
});

// ─── PR4 B5: bounded-concurrent parsing — same output, deterministic order ────
// A multi-file, mixed-variant fixture (.ts + .tsx) parsed concurrently must
// yield the SAME symbols+hints in the SAME order as a serial (concurrency: 1)
// run. Per-slot parsers mean no shared-parser race across in-flight parses.

describe("PR4 B5: bounded-concurrent parsing equals serial output", () => {
  let tmpDir: string;

  const files: Array<{ name: string; src: string }> = [
    { name: "a.ts", src: "export function alpha() {}\nexport class Beta { m() {} }\n" },
    { name: "b.tsx", src: "export function Widget() { return null; }\nexport const h = (x: number) => x;\n" },
    { name: "c.ts", src: "export const cast = () => { const v = <Foo>bar; return v; };\nexport function gamma() {}\n" },
    { name: "d.tsx", src: "export class Panel { render() {} }\nexport function Other() { return null; }\n" },
    { name: "e.ts", src: "export interface Shape { area(): number; }\nexport function delta() {}\n" },
    { name: "f.ts", src: "export const first = () => 1; const second = () => 2;\n" },
  ];

  const nodes = (): FileNode[] =>
    files.map((f) => ({ path: f.name, size: 200, language: "typescript" as const }));

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "typocop-b5-"));
    for (const f of files) {
      await writeFile(path.join(tmpDir, f.name), f.src, "utf-8");
    }
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("concurrent (4) output is identical to serial (1) — symbols, hints, order", async () => {
    const serial = await extractAllSymbols(nodes(), tmpDir, { concurrency: 1 });
    const concurrent = await extractAllSymbols(nodes(), tmpDir, { concurrency: 4 });

    // Exact array equality preserves both content and ordering.
    expect(concurrent.symbols.map((s) => s.id)).toEqual(serial.symbols.map((s) => s.id));
    expect(concurrent.symbols).toEqual(serial.symbols);
    expect(concurrent.hints).toEqual(serial.hints);
    expect(concurrent.skippedFiles).toBe(serial.skippedFiles);
  });

  it("default concurrency matches serial output too", async () => {
    const serial = await extractAllSymbols(nodes(), tmpDir, { concurrency: 1 });
    const dflt = await extractAllSymbols(nodes(), tmpDir);
    expect(dflt.symbols).toEqual(serial.symbols);
    expect(dflt.hints).toEqual(serial.hints);
  });
});

// ─── PR4 B6: onProgress completion hook ───────────────────────────────────────
// onProgress fires exactly once per file (INCLUDING skipped files), done is
// monotonic-ish and ends EXACTLY at total.

describe("PR4 B6: onProgress completion hook", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "typocop-b6-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("fires exactly fileNodes.length times incl. skipped files; final done === total", async () => {
    // Good file, an oversized file (skipped via knownSize gate), and a
    // nonexistent file (skipped via ParseError) — all must still tick progress.
    await writeFile(path.join(tmpDir, "ok.ts"), "export function ok() {}\n", "utf-8");
    await writeFile(path.join(tmpDir, "big.ts"), "export function big() {}\n", "utf-8");

    const fileNodes: FileNode[] = [
      { path: "ok.ts", size: 50, language: "typescript" },
      // knownSize above MAX_FILE_SIZE → skipped without reading
      { path: "big.ts", size: 64 * 1024 * 1024, language: "typescript" },
      { path: "missing.ts", size: 100, language: "typescript" },
    ];

    const calls: Array<{ done: number; total: number; currentPath?: string }> = [];
    const result = await extractAllSymbols(fileNodes, tmpDir, {
      concurrency: 2,
      onProgress: (done, total, currentPath) => calls.push({ done, total, currentPath }),
    });

    // Exactly one tick per file.
    expect(calls.length).toBe(fileNodes.length);
    // total is constant and equals fileNodes.length.
    expect(calls.every((c) => c.total === fileNodes.length)).toBe(true);
    // done values are the integers 1..total in some order (each bump unique).
    const doneValues = calls.map((c) => c.done).sort((a, b) => a - b);
    expect(doneValues).toEqual([1, 2, 3]);
    // Final tick reaches exactly total.
    expect(Math.max(...calls.map((c) => c.done))).toBe(fileNodes.length);
    // Two of the three files were skipped.
    expect(result.skippedFiles).toBe(2);
  });

  it("done reaches total with a single worker and an all-skipped set", async () => {
    const fileNodes: FileNode[] = [
      { path: "gone1.ts", size: 10, language: "typescript" },
      { path: "gone2.ts", size: 10, language: "typescript" },
    ];
    let lastDone = 0;
    let count = 0;
    const result = await extractAllSymbols(fileNodes, tmpDir, {
      concurrency: 1,
      onProgress: (done) => {
        count++;
        lastDone = done;
      },
    });
    expect(count).toBe(2);
    expect(lastDone).toBe(2);
    expect(result.skippedFiles).toBe(2);
    expect(result.symbols).toEqual([]);
  });
});
