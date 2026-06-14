/**
 * PR2 regression tests for the Phase 2 parse hot path:
 *
 * - B1: the common (query) path parses each file exactly once and never
 *   materializes the eager `ASTNode` tree.
 * - B2: tree-sitter queries are compiled once per (language, grammar variant),
 *   not once per file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { initParser } from "./init.js";
import {
  parseSourceFile,
  initParserForVariant,
  grammarVariantForFile,
} from "./parse-file.js";
import * as astNode from "./ast-node.js";
import {
  extractSymbolsWithQueries,
  getQueryCompileCount,
  resetQueryCache,
} from "./extract-symbols.js";

const TS_SOURCE = `
export function alpha(): number { return 1; }
export class Beta { gamma(): void {} }
`;

const TSX_SOURCE = `
export function Widget() { return null; }
export class Panel { render() {} }
`;

describe("PR2 B1: single parse, no eager AST on the common path", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetQueryCache();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "typocop-parse-once-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("parses each file exactly once and never builds the eager ASTNode on the success path", async () => {
    const file = path.join(tmpDir, "alpha.ts");
    await writeFile(file, TS_SOURCE, "utf-8");

    const parser = await initParser("typescript");
    const parseSpy = vi.spyOn(parser, "parse");
    const fromSyntaxNodeSpy = vi.spyOn(astNode, "fromSyntaxNode");

    const parsed = await parseSourceFile(file, "typescript", parser);
    const result = extractSymbolsWithQueries(parsed.tree, file, "typescript", parser);

    // Exactly one parse for the file; the query path reuses parsed.tree.
    expect(parseSpy).toHaveBeenCalledTimes(1);
    // Common (query) path yields symbols, so the eager AST is never built.
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(fromSyntaxNodeSpy).not.toHaveBeenCalled();

    // Sanity-check that the spy is wired to the same binding the code uses:
    // a direct call must register, proving the negative assertion above is real.
    astNode.fromSyntaxNode(parsed.tree.rootNode);
    expect(fromSyntaxNodeSpy).toHaveBeenCalledTimes(1);
  });
});

// B5: when Phase 1's FileNode.size is threaded through as knownSize,
// parseSourceFile must NOT re-stat the file, and must gate on the passed size.
// (ESM namespace exports can't be spied directly, so this is asserted
// BEHAVIORALLY: the size gate is driven by knownSize, not on-disk size.)
describe("PR4 B5: parseSourceFile honors knownSize and skips the redundant fs.stat", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetQueryCache();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "typocop-knownsize-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("parses successfully when knownSize is provided (no stat needed)", async () => {
    const file = path.join(tmpDir, "alpha.ts");
    await writeFile(file, TS_SOURCE, "utf-8");
    const parser = await initParser("typescript");

    const parsed = await parseSourceFile(file, "typescript", parser, Buffer.byteLength(TS_SOURCE));
    expect(parsed.tree.rootNode).toBeDefined();
  });

  it("gates on knownSize, not on-disk size: a tiny file with an oversized knownSize is rejected", async () => {
    const file = path.join(tmpDir, "small.ts");
    await writeFile(file, TS_SOURCE, "utf-8"); // tiny on disk

    const parser = await initParser("typescript");

    // A knownSize above MAX_FILE_SIZE is rejected even though the on-disk file
    // is tiny — proof that the gate trusts knownSize and never re-stats.
    await expect(
      parseSourceFile(file, "typescript", parser, 64 * 1024 * 1024),
    ).rejects.toThrow(/MAX_FILE_SIZE/);
  });

  it("does not re-stat: a missing file with a small knownSize fails on READ, not STAT", async () => {
    // The file does not exist. If parseSourceFile still stat'd, the error would
    // come from the stat path ("Cannot stat file"). With a knownSize provided,
    // stat is skipped, so the failure surfaces from readFile instead.
    const missing = path.join(tmpDir, "does-not-exist.ts");
    const parser = await initParser("typescript");

    await expect(
      parseSourceFile(missing, "typescript", parser, 100),
    ).rejects.toThrow(/Cannot read file/);
  });

  it("uses the stat path when knownSize is omitted (missing file fails on STAT)", async () => {
    const missing = path.join(tmpDir, "also-missing.ts");
    const parser = await initParser("typescript");

    await expect(
      parseSourceFile(missing, "typescript", parser),
    ).rejects.toThrow(/Cannot stat file/);
  });
});

describe("PR2 B2: queries compiled once per (language, grammar variant)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetQueryCache();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "typocop-query-cache-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("compiles the query once across many files of the same language", async () => {
    const parser = await initParser("typescript");

    for (let i = 0; i < 5; i++) {
      const file = path.join(tmpDir, `file${i}.ts`);
      await writeFile(file, TS_SOURCE, "utf-8");
      const parsed = await parseSourceFile(file, "typescript", parser);
      const result = extractSymbolsWithQueries(parsed.tree, file, "typescript", parser);
      expect(result.symbols.length).toBeGreaterThan(0);
    }

    // One compilation total for the ts variant, reused for the other 4 files.
    expect(getQueryCompileCount()).toBe(1);
  });

  // B2/B3 cache-key guard: queries are keyed by the grammar a tree was actually
  // parsed with. With B3's per-variant parsers, the ts and tsx grammars are
  // distinct `Language` objects, so they get distinct cache entries — exactly
  // two compilations total across both variants, each reused.
  it("compiles one query per grammar variant across per-variant parsers", async () => {
    const tsParser = await initParserForVariant(
      "typescript",
      grammarVariantForFile("typescript", "x.ts"),
    );
    const tsxParser = await initParserForVariant(
      "typescript",
      grammarVariantForFile("typescript", "x.tsx"),
    );

    const tsFile = path.join(tmpDir, "first.ts");
    const tsxFile = path.join(tmpDir, "widget.tsx");
    await writeFile(tsFile, TS_SOURCE, "utf-8");
    await writeFile(tsxFile, TSX_SOURCE, "utf-8");

    const parsedTs = await parseSourceFile(tsFile, "typescript", tsParser);
    extractSymbolsWithQueries(parsedTs.tree, tsFile, "typescript", tsParser);
    const parsedTsx = await parseSourceFile(tsxFile, "typescript", tsxParser);
    extractSymbolsWithQueries(parsedTsx.tree, tsxFile, "typescript", tsxParser);

    // Two distinct grammars (ts + tsx) → exactly two compilations, each cached.
    expect(getQueryCompileCount()).toBe(2);
  });
});

// B3 regression: with per-variant parsers, a `.ts` file parsed AFTER a `.tsx`
// file produces IDENTICAL symbols to parsing it first. Previously a single
// shared parser was flipped to the tsx grammar by the `.tsx` file and never
// restored, so the subsequent `.ts` file was mis-parsed (e.g. `<Foo>bar` type
// assertions read as JSX), dropping symbols order-dependently.
describe("PR3 B3: stateless grammar selection — order-independent symbols", () => {
  let tmpDir: string;

  // `<Foo>bar` is a valid TS angle-bracket type assertion, but the tsx grammar
  // reads `<Foo>...` as JSX — so this file is the canary for grammar bleed.
  const TS_WITH_ASSERTION = `
export const cast = () => { const v = <Foo>bar; return v; };
export function alpha() {}
`;

  beforeEach(async () => {
    resetQueryCache();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "typocop-b3-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function parseTsWith(parser: Parameters<typeof parseSourceFile>[2], file: string) {
    const parsed = await parseSourceFile(file, "typescript", parser);
    return extractSymbolsWithQueries(parsed.tree, file, "typescript", parser)
      .symbols.map((s) => s.name)
      .sort();
  }

  it("a .ts file parsed after a .tsx file matches parsing it first", async () => {
    const tsFile = path.join(tmpDir, "a.ts");
    const tsxFile = path.join(tmpDir, "widget.tsx");
    await writeFile(tsFile, TS_WITH_ASSERTION, "utf-8");
    await writeFile(tsxFile, TSX_SOURCE, "utf-8");

    // Each variant gets its OWN parser, configured once.
    const tsParser = await initParserForVariant(
      "typescript",
      grammarVariantForFile("typescript", tsFile),
    );
    const tsxParser = await initParserForVariant(
      "typescript",
      grammarVariantForFile("typescript", tsxFile),
    );

    // Order A: .ts first.
    const tsFirst = await parseTsWith(tsParser, tsFile);
    await parseSourceFile(tsxFile, "typescript", tsxParser);

    // Order B: .ts again AFTER the .tsx file, on the (separate) ts parser.
    const tsAfter = await parseTsWith(tsParser, tsFile);

    expect(tsAfter).toEqual(tsFirst);
    // The angle-bracket assertion arrow `cast` survives in both orders.
    expect(tsFirst).toContain("cast");
    expect(tsFirst).toContain("alpha");
  });
});
