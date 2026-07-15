/**
 * Wave 2 (1.2) — `extractMethodSignature`: variadic detection +
 * broad return-type extraction, exercised against the real tree-sitter grammars.
 *
 * Variadic forms across languages yield `parameterCount: undefined`;
 * non-variadic counterparts yield the exact count. Return types cover Go
 * multi-return (first type), C# `returns`, C/C++ `type` (`void` → undefined),
 * Rust value node, and the generic TS/Python annotation fallback. Includes a PHP
 * `property_promotion_parameter` / `simple_parameter` counting regression guard.
 */
import { describe, it, expect } from "vitest";
import type Parser from "tree-sitter";
import { initParser } from "./init.js";
import { extractMethodSignature } from "./signature.js";
import type { Language } from "../../core/domain.js";

/** Parse `src` and return the first def node of one of `defTypes`. */
async function firstDef(
  lang: Language,
  src: string,
  defTypes: string[],
): Promise<Parser.SyntaxNode | undefined> {
  const parser = await initParser(lang);
  const tree = parser.parse(src);
  let found: Parser.SyntaxNode | undefined;
  const walk = (n: Parser.SyntaxNode): void => {
    if (!found && defTypes.includes(n.type)) found = n;
    for (let i = 0; i < n.childCount && !found; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(tree.rootNode);
  return found;
}

/** Parse `src` and return ALL def nodes of one of `defTypes`, in order. */
async function allDefs(
  lang: Language,
  src: string,
  defTypes: string[],
): Promise<Parser.SyntaxNode[]> {
  const parser = await initParser(lang);
  const tree = parser.parse(src);
  const out: Parser.SyntaxNode[] = [];
  const walk = (n: Parser.SyntaxNode): void => {
    if (defTypes.includes(n.type)) out.push(n);
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(tree.rootNode);
  return out;
}

describe("extractMethodSignature — variadic detection", () => {
  it("TypeScript rest parameter → undefined count", async () => {
    const d = await firstDef("typescript", `function f(a: number, ...rest: number[]): void {}\n`, ["function_declaration"]);
    expect(extractMethodSignature(d).parameterCount).toBeUndefined();
  });

  it("TypeScript non-variadic → exact count", async () => {
    const d = await firstDef("typescript", `function f(a: number, b: string): number { return 0; }\n`, ["function_declaration"]);
    expect(extractMethodSignature(d).parameterCount).toBe(2);
  });

  it("Python *args/**kwargs → undefined count", async () => {
    const d = await firstDef("python", `def f(a, *args, **kwargs):\n    pass\n`, ["function_definition"]);
    expect(extractMethodSignature(d).parameterCount).toBeUndefined();
  });

  it("Go variadic → undefined count", async () => {
    const d = await firstDef("go", `func f(a string, b ...int) {}\n`, ["function_declaration"]);
    expect(extractMethodSignature(d).parameterCount).toBeUndefined();
  });

  it("Java varargs (Object...) → undefined count", async () => {
    const d = await firstDef("java", `class C { void m(String... args) {} }\n`, ["method_declaration"]);
    expect(extractMethodSignature(d).parameterCount).toBeUndefined();
  });

  it("C bare ... variadic → undefined count", async () => {
    const d = await firstDef("c", `int f(int a, ...) { return 0; }\n`, ["function_definition"]);
    expect(extractMethodSignature(d).parameterCount).toBeUndefined();
  });

  it("plain function → exact count of 2", async () => {
    const d = await firstDef("c", `int h(int a, int b) { return a; }\n`, ["function_definition"]);
    expect(extractMethodSignature(d).parameterCount).toBe(2);
  });
});

describe("extractMethodSignature — return types", () => {
  it("Go multi-return extracts the FIRST type only", async () => {
    const d = await firstDef("go", `func f() (*User, error) { return nil, nil }\n`, ["function_declaration"]);
    expect(extractMethodSignature(d).returnType).toBe("*User");
  });

  it("C# returns field", async () => {
    const d = await firstDef("csharp", `class C { public System.Threading.Tasks.Task<int> M() { return null; } }\n`, ["method_declaration"]);
    expect(extractMethodSignature(d).returnType).toBe("System.Threading.Tasks.Task<int>");
  });

  it("C# void → no return type", async () => {
    const d = await firstDef("csharp", `class C { public void N() {} }\n`, ["method_declaration"]);
    expect(extractMethodSignature(d).returnType).toBeUndefined();
  });

  it("C/C++ type field (void → undefined)", async () => {
    const ret = await firstDef("c", `int g(int a) { return a; }\n`, ["function_definition"]);
    expect(extractMethodSignature(ret).returnType).toBe("int");
    const voidFn = await firstDef("c", `void v(int a) {}\n`, ["function_definition"]);
    expect(extractMethodSignature(voidFn).returnType).toBeUndefined();
  });

  it("Rust value-node return type", async () => {
    const d = await firstDef("rust", `pub fn f(a: i32) -> i32 { a }\n`, ["function_item"]);
    expect(extractMethodSignature(d).returnType).toBe("i32");
  });

  it("TypeScript annotation fallback", async () => {
    const d = await firstDef("typescript", `function f(): number { return 1; }\n`, ["function_declaration"]);
    expect(extractMethodSignature(d).returnType).toBe("number");
  });

  it("Python annotation fallback", async () => {
    const d = await firstDef("python", `def g(a, b) -> int:\n    return 1\n`, ["function_definition"]);
    const sig = extractMethodSignature(d);
    expect(sig.parameterCount).toBe(2);
    expect(sig.returnType).toBe("int");
  });
});

describe("extractMethodSignature — PHP parameter counting (regression guard)", () => {
  it("counts property_promotion_parameter + simple_parameter", async () => {
    // A constructor mixing a promoted property and a plain typed param must
    // count BOTH (2), not regress to 0/1.
    const ctors = await allDefs(
      "php",
      `<?php class C { public function __construct(public int $x, string $y) {} }\n`,
      ["method_declaration"],
    );
    expect(ctors.length).toBeGreaterThan(0);
    expect(extractMethodSignature(ctors[0]).parameterCount).toBe(2);
  });

  it("PHP variadic ...$rest → undefined count", async () => {
    const methods = await allDefs(
      "php",
      `<?php class C { public function m(int $a, ...$rest) {} }\n`,
      ["method_declaration"],
    );
    expect(extractMethodSignature(methods[0]).parameterCount).toBeUndefined();
  });
});

describe("extractMethodSignature — edge cases", () => {
  it("a non-callable (class) node carries no parameterCount", async () => {
    const d = await firstDef("typescript", `class Plain {}\n`, ["class_declaration"]);
    const sig = extractMethodSignature(d);
    expect(sig.parameterCount).toBeUndefined();
    expect(sig.returnType).toBeUndefined();
  });

  it("null/undefined node returns undefined fields", () => {
    expect(extractMethodSignature(null)).toEqual({ parameterCount: undefined, returnType: undefined });
  });
});
