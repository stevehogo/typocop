/**
 * E2 — computeComplexity over fixtures with known cyclomatic values, across the
 * five fully-supported languages (TS/JS/Python/Java/Go) plus a graceful
 * cyclomatic-only check for an unsupported-spec language.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "./init.js";
import { computeComplexity, hasFullComplexitySupport } from "./complexity.js";
import type { Language } from "../../core/domain.js";

/** Find the first node of any of the given types (BFS) under root. */
function findFirst(root: Parser.SyntaxNode, types: ReadonlySet<string>): Parser.SyntaxNode | null {
  const queue: Parser.SyntaxNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (types.has(node.type)) return node;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) queue.push(c);
    }
  }
  return null;
}

const FN_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "function_item",
  "method_declaration",
  "method_definition",
]);

async function complexityOf(language: Language, src: string) {
  const parser = await initParser(language);
  const tree = parser.parse(src);
  const fn = findFirst(tree.rootNode, FN_TYPES);
  expect(fn, `no function node found for ${language}`).not.toBeNull();
  return computeComplexity(fn!, language);
}

describe("computeComplexity — TypeScript", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  function metrics(src: string) {
    const tree = parser.parse(src);
    const fn = findFirst(tree.rootNode, FN_TYPES)!;
    return computeComplexity(fn, "typescript");
  }

  it("a straight-line function has cyclomatic 1", () => {
    expect(metrics(`function f(a: number) { return a + 1; }`).cyclomatic).toBe(1);
  });

  it("3 ifs + 1 for => cyclomatic 5", () => {
    const src = `function f(x: number) {
      if (x > 0) {}
      if (x > 1) {}
      if (x > 2) {}
      for (let i = 0; i < x; i++) {}
    }`;
    expect(metrics(src).cyclomatic).toBe(5);
  });

  it("counts && and || short-circuits as decisions", () => {
    // base 1 + 1 if + 1 (&&) + 1 (||) = 4
    const src = `function f(a: boolean, b: boolean, c: boolean) {
      if (a && b || c) { return 1; }
      return 0;
    }`;
    expect(metrics(src).cyclomatic).toBe(4);
  });

  it("counts ternary, catch and case clauses", () => {
    // base 1 + ternary 1 + try/catch 1 + 2 case clauses = 5
    const src = `function f(x: number) {
      const y = x > 0 ? 1 : 2;
      try { g(); } catch (e) {}
      switch (x) { case 1: break; case 2: break; }
      return y;
    }`;
    expect(metrics(src).cyclomatic).toBe(5);
  });

  it("nesting raises cognitive above flat cyclomatic and tracks loop depth", () => {
    const flat = metrics(`function f(x: number) { if (x>0){} if (x>1){} }`);
    expect(flat.cognitive).toBe(2);   // two flat ifs, depth 0 each => 1 + 1
    expect(flat.maxLoopDepth).toBe(0);

    const nested = metrics(`function f(x: number) {
      for (let i=0;i<x;i++) {
        for (let j=0;j<x;j++) {
          if (i===j) {}
        }
      }
    }`);
    // outer for(depth0)=1, inner for(depth1)=2, if(depth2)=3 => 6
    expect(nested.cognitive).toBe(6);
    expect(nested.maxLoopDepth).toBe(2);
  });
});

describe("computeComplexity — per-language fixtures (3 ifs + 1 loop => 5)", () => {
  it("JavaScript", async () => {
    const src = `function f(x) { if(x>0){} if(x>1){} if(x>2){} for(var i=0;i<x;i++){} }`;
    expect((await complexityOf("javascript", src)).cyclomatic).toBe(5);
  });

  it("Python", async () => {
    const src = [
      "def f(x):",
      "    if x > 0:",
      "        pass",
      "    if x > 1:",
      "        pass",
      "    if x > 2:",
      "        pass",
      "    for i in range(x):",
      "        pass",
      "",
    ].join("\n");
    const m = await complexityOf("python", src);
    expect(m.cyclomatic).toBe(5);
    expect(m.maxLoopDepth).toBe(1);
  });

  it("Java", async () => {
    const src = `class C {
      void f(int x) {
        if (x > 0) {}
        if (x > 1) {}
        if (x > 2) {}
        for (int i = 0; i < x; i++) {}
      }
    }`;
    expect((await complexityOf("java", src)).cyclomatic).toBe(5);
  });

  it("Go", async () => {
    const src = [
      "package p",
      "func f(x int) {",
      "    if x > 0 {}",
      "    if x > 1 {}",
      "    if x > 2 {}",
      "    for i := 0; i < x; i++ {}",
      "}",
      "",
    ].join("\n");
    expect((await complexityOf("go", src)).cyclomatic).toBe(5);
  });
});

describe("computeComplexity — graceful degradation", () => {
  it("reports full support only for the five shipped languages", () => {
    for (const lang of ["typescript", "javascript", "python", "java", "go"] as Language[]) {
      expect(hasFullComplexitySupport(lang)).toBe(true);
    }
    for (const lang of ["rust", "ruby", "c", "cpp", "csharp", "swift", "php"] as Language[]) {
      expect(hasFullComplexitySupport(lang)).toBe(false);
    }
  });

  it("still counts branch constructs for an unsupported-spec language (Rust)", async () => {
    // Rust uses the FALLBACK spec: if_statement + for_statement are near-universal.
    const src = `fn f(x: i32) {
      if x > 0 {}
      if x > 1 {}
      for _i in 0..x {}
    }`;
    const m = await complexityOf("rust", src);
    // base 1 + 2 ifs + 1 for = 4 (cyclomatic-only fidelity)
    expect(m.cyclomatic).toBe(4);
  });
});
