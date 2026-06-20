/**
 * E1 — end-to-end extraction of the new callable metadata + call-hint fields via
 * the real tree-sitter extractor.
 *
 * Asserts (additively): functions/methods carry `parameterCount` / `returnType`;
 * methods carry an `ownerId` pointing at their class; member-call hints carry a
 * `receiverText`; non-callable symbols carry none of these (Symbol shape stays
 * pre-E1-identical where no info exists).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "./init.js";
import { extractSymbolsWithQueries } from "./extract-symbols.js";

const FILE = "/repo/src/e1.ts";

describe("extractSymbolsWithQueries — E1 callable metadata + call hints (TypeScript)", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  function extract(src: string): ReturnType<typeof extractSymbolsWithQueries> {
    return extractSymbolsWithQueries(parser.parse(src), FILE, "typescript", parser);
  }

  it("captures parameterCount and returnType for a free function", () => {
    const { symbols } = extract(`function add(a: number, b: number): number { return a + b; }\n`);
    const add = symbols.find((s) => s.name === "add");
    expect(add?.parameterCount).toBe(2);
    expect(add?.returnType).toBe("number");
  });

  it("links a method to its owning class via ownerId", () => {
    const src = `class Repo {\n  find(id: string): User { return new User(); }\n}\n`;
    const { symbols } = extract(src);
    const repo = symbols.find((s) => s.name === "Repo" && s.kind === "class");
    const find = symbols.find((s) => s.name === "find" && s.kind === "method");
    expect(repo).toBeDefined();
    expect(find?.ownerId).toBe(repo!.id);
    expect(find?.parameterCount).toBe(1);
    expect(find?.returnType).toBe("User");
  });

  it("emits receiverText on a member-call hint", () => {
    const src = `class S {\n  run() { this.helper(); user.save(); }\n}\n`;
    const { hints } = extract(src);
    const helperCall = hints.find((h) => h.kind === "call" && h.targetName === "helper");
    const saveCall = hints.find((h) => h.kind === "call" && h.targetName === "save");
    expect(helperCall?.receiverText).toBe("this");
    expect(saveCall?.receiverText).toBe("user");
  });

  it("leaves non-callable symbols (a class) without callable metadata", () => {
    const { symbols } = extract(`class Plain {}\n`);
    const plain = symbols.find((s) => s.name === "Plain");
    expect(plain?.parameterCount).toBeUndefined();
    expect(plain?.returnType).toBeUndefined();
    // top-level class has no enclosing owner
    expect(plain?.ownerId).toBeUndefined();
  });

  it("a bare free-function call carries no receiverText", () => {
    const { hints } = extract(`function caller() { doWork(); }\n`);
    const call = hints.find((h) => h.kind === "call" && h.targetName === "doWork");
    expect(call).toBeDefined();
    expect(call?.receiverText).toBeUndefined();
  });
});
