/**
 * Wave 4, Task 1 — end-to-end extraction of the `argCount` / `callForm` call-hint
 * fields via the real tree-sitter extractor, across TS/JS/Python/Java/Go/PHP.
 *
 * Also covers the two load-bearing edge cases:
 *  - `argCount` is `undefined` (NOT `0`) when the argument container can't be
 *    located cheaply, and is `0` for an explicit zero-arg call.
 *  - `callForm` discriminates free / member / constructor calls.
 *
 * Fields are additive: a bare free call still carries no `receiverText`, and the
 * presence of `argCount`/`callForm` does not perturb the existing hint shape.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import type { Language } from "../../core/domain.js";
import { initParser } from "./init.js";
import { extractSymbolsWithQueries, type RawRelationshipHint } from "./extract-symbols.js";

function callHints(parser: Parser, src: string, language: Language): RawRelationshipHint[] {
  const file = `/repo/src/calls.${language}`;
  const { hints } = extractSymbolsWithQueries(parser.parse(src), file, language, parser);
  return hints.filter((h) => h.kind === "call");
}

function find(hints: RawRelationshipHint[], name: string): RawRelationshipHint | undefined {
  return hints.find((h) => h.targetName === name);
}

describe("Wave 4 Task 1 — argCount/callForm on call hints", () => {
  describe("TypeScript", () => {
    let parser: Parser;
    beforeAll(async () => { parser = await initParser("typescript"); });
    afterAll(() => { parser = undefined as unknown as Parser; });

    it("counts zero / one / two direct args (zero-arg is 0, not undefined)", () => {
      const h = callHints(parser, `function c() { zero(); one(a); two(a, b); }\n`, "typescript");
      expect(find(h, "zero")?.argCount).toBe(0);
      expect(find(h, "one")?.argCount).toBe(1);
      expect(find(h, "two")?.argCount).toBe(2);
    });

    it("does not inflate arity from a trailing comma or comment", () => {
      const h = callHints(parser, `function c() { f(a, b, /* note */); }\n`, "typescript");
      expect(find(h, "f")?.argCount).toBe(2);
    });

    it("classifies free, member, and constructor calls", () => {
      const src = `function c() { free(); obj.member(); const x = new Widget(); }\n`;
      const h = callHints(parser, src, "typescript");
      expect(find(h, "free")?.callForm).toBe("free");
      expect(find(h, "member")?.callForm).toBe("member");
      expect(find(h, "Widget")?.callForm).toBe("constructor");
    });

    it("a bare free call carries no receiverText but still carries argCount/callForm", () => {
      const h = callHints(parser, `function c() { doWork(1); }\n`, "typescript");
      const call = find(h, "doWork");
      expect(call?.receiverText).toBeUndefined();
      expect(call?.argCount).toBe(1);
      expect(call?.callForm).toBe("free");
    });
  });

  describe("JavaScript", () => {
    let parser: Parser;
    beforeAll(async () => { parser = await initParser("javascript"); });
    afterAll(() => { parser = undefined as unknown as Parser; });

    it("counts args and classifies member vs free", () => {
      const h = callHints(parser, `function c() { svc.save(a, b); helper(); }\n`, "javascript");
      expect(find(h, "save")?.argCount).toBe(2);
      expect(find(h, "save")?.callForm).toBe("member");
      expect(find(h, "helper")?.argCount).toBe(0);
      expect(find(h, "helper")?.callForm).toBe("free");
    });
  });

  describe("Python", () => {
    let parser: Parser;
    beforeAll(async () => { parser = await initParser("python"); });
    afterAll(() => { parser = undefined as unknown as Parser; });

    it("counts args and classifies member vs free", () => {
      const src = `def c():\n    free(1)\n    obj.member(1, 2, 3)\n`;
      const h = callHints(parser, src, "python");
      expect(find(h, "free")?.argCount).toBe(1);
      expect(find(h, "free")?.callForm).toBe("free");
      expect(find(h, "member")?.argCount).toBe(3);
      expect(find(h, "member")?.callForm).toBe("member");
    });
  });

  describe("Java", () => {
    let parser: Parser;
    beforeAll(async () => { parser = await initParser("java"); });
    afterAll(() => { parser = undefined as unknown as Parser; });

    it("counts args and classifies member, free, and constructor calls", () => {
      const src = `class C {\n  void c() {\n    free(1);\n    this.member(1, 2);\n    Widget w = new Widget(1);\n  }\n}\n`;
      const h = callHints(parser, src, "java");
      expect(find(h, "free")?.argCount).toBe(1);
      expect(find(h, "free")?.callForm).toBe("free");
      expect(find(h, "member")?.argCount).toBe(2);
      expect(find(h, "member")?.callForm).toBe("member");
      // `new Widget(1)` → object_creation_expression captured as @call.
      expect(find(h, "Widget")?.callForm).toBe("constructor");
      expect(find(h, "Widget")?.argCount).toBe(1);
    });
  });

  describe("Go", () => {
    let parser: Parser;
    beforeAll(async () => { parser = await initParser("go"); });
    afterAll(() => { parser = undefined as unknown as Parser; });

    it("counts args and classifies member vs free", () => {
      const src = `package p\nfunc c() {\n\tfree(1)\n\tobj.Member(1, 2)\n}\n`;
      const h = callHints(parser, src, "go");
      expect(find(h, "free")?.argCount).toBe(1);
      expect(find(h, "free")?.callForm).toBe("free");
      expect(find(h, "Member")?.argCount).toBe(2);
      expect(find(h, "Member")?.callForm).toBe("member");
    });
  });

  describe("PHP", () => {
    let parser: Parser;
    beforeAll(async () => { parser = await initParser("php"); });
    afterAll(() => { parser = undefined as unknown as Parser; });

    it("counts args and classifies member vs free", () => {
      const src = `<?php\nfunction c() {\n  free(1);\n  $obj->member(1, 2);\n}\n`;
      const h = callHints(parser, src, "php");
      expect(find(h, "free")?.argCount).toBe(1);
      expect(find(h, "free")?.callForm).toBe("free");
      expect(find(h, "member")?.argCount).toBe(2);
      expect(find(h, "member")?.callForm).toBe("member");
    });
  });
});
