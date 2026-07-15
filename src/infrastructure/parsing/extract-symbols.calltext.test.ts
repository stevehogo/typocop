/**
 * Asserts the call-hint `callText` field carries the raw source of the `@call`
 * node (used by the self-recursion report's "Buggy call" column). Mirrors the
 * parse harness in the sibling `extract-symbols.e1.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "./init.js";
import { extractSymbolsWithQueries } from "./extract-symbols.js";

const FILE = "/repo/src/calltext.ts";

describe("call hint callText", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("captures the raw source of a member call", () => {
    const { hints } = extractSymbolsWithQueries(
      parser.parse(`class C { m(){ this.m(1); } }\n`), FILE, "typescript", parser,
    );
    const call = hints.find((h) => h.kind === "call" && h.targetName === "m");
    expect(call?.callText).toBe("this.m(1)");
  });
});
