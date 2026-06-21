/**
 * Wave 7 (§3.1, Task 4) — Phase-2 Go struct-embedding + Ruby mixin heritage.
 *
 * Gated behind `TYPOCOP_HERITAGE_DISAMBIGUATION` (read in-worker). Verifies:
 *  - flag OFF: byte-identical to today (Go named fields still emit, Ruby mixins
 *    are NOT emitted as heritage);
 *  - flag ON: Go anonymous embedding → `inherits` (+ `heritageKind:"embed"`),
 *    Go NAMED fields are skipped, Ruby include/extend/prepend → `implements`
 *    (+ the verb as `heritageKind`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "./init.js";
import { extractSymbolsWithQueries } from "./extract-symbols.js";
import { HERITAGE_DISAMBIGUATION_ENV } from "../../platform/utils/limits.js";

function heritageHints(result: { hints: { kind: string; targetName: string; childSymbolId?: string; heritageKind?: string }[] }) {
  return result.hints.filter((h) => h.kind === "inherits" || h.kind === "implements");
}

describe("Go struct embedding heritage (Wave 7 flag)", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("go"); });
  afterAll(() => { parser = undefined as unknown as Parser; });
  afterEach(() => { delete process.env[HERITAGE_DISAMBIGUATION_ENV]; });

  const src = `package main
type Animal struct { Name string }
type Dog struct {
	Animal
	name string
}
`;

  it("flag OFF: byte-identical to today — named fields still emit spurious inherits", () => {
    delete process.env[HERITAGE_DISAMBIGUATION_ENV];
    const tree = parser.parse(src);
    const { hints } = extractSymbolsWithQueries(tree, "/repo/main.go", "go", parser);
    const heritage = hints.filter((h) => h.kind === "inherits");
    // Today's behaviour: BOTH the embed (Dog->Animal) AND the named field
    // (Dog->string, Animal->string) emit as `inherits`. No `heritageKind`.
    const targets = heritage.map((h) => h.targetName).sort();
    expect(targets).toContain("Animal");
    expect(targets).toContain("string");
    expect(heritage.every((h) => h.heritageKind === undefined)).toBe(true);
  });

  it("flag ON: anonymous embedding → inherits + heritageKind embed; NAMED field skipped", () => {
    process.env[HERITAGE_DISAMBIGUATION_ENV] = "1";
    const tree = parser.parse(src);
    const { hints } = extractSymbolsWithQueries(tree, "/repo/main.go", "go", parser);
    const heritage = hints.filter((h) => h.kind === "inherits");
    // Only the anonymous embed survives; `name string` (named) is skipped.
    expect(heritage).toHaveLength(1);
    expect(heritage[0].targetName).toBe("Animal");
    expect(heritage[0].childSymbolId).toBe("Dog");
    expect(heritage[0].heritageKind).toBe("embed");
  });
});

describe("Ruby include/extend/prepend mixin heritage (Wave 7 flag)", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("ruby"); });
  afterAll(() => { parser = undefined as unknown as Parser; });
  afterEach(() => { delete process.env[HERITAGE_DISAMBIGUATION_ENV]; });

  const src = `class C < Base
  include Comparable
  extend Forwardable
  prepend Logging
end
module M
  include Enumerable
end
`;

  it("flag OFF: mixins are NOT emitted as heritage (byte-identical)", () => {
    delete process.env[HERITAGE_DISAMBIGUATION_ENV];
    const tree = parser.parse(src);
    const { hints } = extractSymbolsWithQueries(tree, "/repo/c.rb", "ruby", parser);
    const heritage = heritageHints({ hints });
    // Only the class superclass `C < Base` is heritage; no mixin heritage edges.
    const mixinTargets = heritage.filter((h) =>
      ["Comparable", "Forwardable", "Logging", "Enumerable"].includes(h.targetName),
    );
    expect(mixinTargets).toHaveLength(0);
  });

  it("flag ON: include/extend/prepend → implements with the verb as heritageKind", () => {
    process.env[HERITAGE_DISAMBIGUATION_ENV] = "1";
    const tree = parser.parse(src);
    const { hints } = extractSymbolsWithQueries(tree, "/repo/c.rb", "ruby", parser);
    const impls = hints.filter((h) => h.kind === "implements");
    const byTarget = new Map(impls.map((h) => [h.targetName, h]));

    const comparable = byTarget.get("Comparable");
    expect(comparable?.childSymbolId).toBe("C");
    expect(comparable?.heritageKind).toBe("include");

    expect(byTarget.get("Forwardable")?.heritageKind).toBe("extend");
    expect(byTarget.get("Forwardable")?.childSymbolId).toBe("C");

    expect(byTarget.get("Logging")?.heritageKind).toBe("prepend");

    // Module-level include resolves to the enclosing module M.
    const enumerable = byTarget.get("Enumerable");
    expect(enumerable?.childSymbolId).toBe("M");
    expect(enumerable?.heritageKind).toBe("include");
  });
});
