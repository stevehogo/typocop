/**
 * E3 — `member.access` capture: a `recv.prop` property READ emits an `access`
 * hint carrying the property as `targetName`, the receiver as `receiverText`,
 * and the enclosing definition id. Property reads that are CALL callees
 * (`recv.method(...)`) are NOT re-emitted (they are `call` hints), so the
 * E1 receiver capture is reused, not duplicated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "./init.js";
import { extractSymbolsWithQueries } from "./extract-symbols.js";

const FILE = "/repo/src/e3.ts";

describe("extractSymbolsWithQueries — E3 member.access hints", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  function extract(src: string): ReturnType<typeof extractSymbolsWithQueries> {
    return extractSymbolsWithQueries(parser.parse(src), FILE, "typescript", parser);
  }

  it("emits an access hint for a property read", () => {
    const { hints } = extract(
      `function consume() { const result = fetchUser(); return result.data + result.total; }\n`,
    );
    const dataRead = hints.find((h) => h.kind === "access" && h.targetName === "data");
    const totalRead = hints.find((h) => h.kind === "access" && h.targetName === "total");
    expect(dataRead?.receiverText).toBe("result");
    expect(totalRead?.receiverText).toBe("result");
    // Attributed to the enclosing consumer.
    const consume = (extract(
      `function consume() { const result = fetchUser(); return result.data; }\n`,
    )).symbols.find((s) => s.name === "consume");
    expect(dataRead?.enclosingSymbolId).toBeDefined();
    expect(consume).toBeDefined();
  });

  it("does NOT emit an access hint for a method call callee", () => {
    const { hints } = extract(`function run() { user.save(); }\n`);
    const accessHints = hints.filter((h) => h.kind === "access");
    // `user.save()` is a call, not a property read → no `access` hint for `save`.
    expect(accessHints.find((h) => h.targetName === "save")).toBeUndefined();
    // It is still captured as a call hint (E1).
    expect(hints.find((h) => h.kind === "call" && h.targetName === "save")).toBeDefined();
  });

  it("does not emit access hints when there are no member reads (golden-safe)", () => {
    const { hints } = extract(`function add(a: number, b: number) { return a + b; }\n`);
    expect(hints.filter((h) => h.kind === "access")).toHaveLength(0);
  });
});
