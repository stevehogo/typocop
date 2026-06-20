/**
 * A1 (KEYSTONE) — end-to-end logicalKey stability through the real extractor.
 *
 * Parses TypeScript source, then the SAME source with a symbol pushed down N
 * lines, and asserts the extracted symbol's `logicalKey` is byte-identical while
 * its position-inclusive `id` changes. This is the property that makes diff-based
 * re-indexing (A4) not dangle every inbound edge.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "./init.js";
import { extractSymbolsWithQueries } from "./extract-symbols.js";

const FILE = "/repo/src/example.ts";

describe("extractSymbolsWithQueries — logicalKey stability under line moves", () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = await initParser("typescript");
  });

  afterAll(() => {
    parser = undefined as unknown as Parser;
  });

  function extract(src: string): ReturnType<typeof extractSymbolsWithQueries> {
    return extractSymbolsWithQueries(parser.parse(src), FILE, "typescript", parser);
  }

  it("keeps logicalKey stable but changes id when a function moves down", () => {
    const original = `function alpha() { return 1; }\n`;
    const moved = `\n\n\n\nfunction alpha() { return 1; }\n`;

    const a = extract(original).symbols.find((s) => s.name === "alpha");
    const b = extract(moved).symbols.find((s) => s.name === "alpha");

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Position-independent identity survives the move…
    expect(b!.logicalKey).toBe(a!.logicalKey);
    // …while the position-inclusive intra-run id does not.
    expect(b!.id).not.toBe(a!.id);
    // The moved symbol's recorded location really did change.
    expect(b!.location.startLine).toBeGreaterThan(a!.location.startLine);
  });

  it("gives two same-(name,kind) symbols distinct, deterministic logicalKeys", () => {
    // Two arrow functions assigned to the SAME const name in one file collide on
    // (file, name, kind); the per-file ordinal must keep their keys distinct.
    const src = `const f = () => 1;\nconst f2 = () => 2;\nconst f = () => 3;\n`;
    const first = extract(src);
    const fooKeys = first.symbols.filter((s) => s.name === "f").map((s) => s.logicalKey);
    // Each distinct emission gets a unique key.
    expect(new Set(fooKeys).size).toBe(fooKeys.length);
    // Re-parsing the identical source yields the identical key set (determinism).
    const second = extract(src);
    expect(second.symbols.filter((s) => s.name === "f").map((s) => s.logicalKey)).toEqual(fooKeys);
  });

  it("produces byte-identical output across repeated parses of the same source", () => {
    const src = `class A {}\nfunction b() {}\nconst c = 1;\n`;
    expect(JSON.stringify(extract(src))).toBe(JSON.stringify(extract(src)));
  });
});
