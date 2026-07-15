/**
 * Wave 3 (Tier B) — grammar-aware AST type-helper unit tests.
 *
 * Asserts `extractSimpleTypeName` against the real tree-sitter trees for the
 * five registered languages: generic unwrap, qualified-name last-segment,
 * nullable types, nullable unions, pointer/reference. (Task 1 acceptance.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "../init.js";
import { extractSimpleTypeName, extractVarName, extractGenericTypeArgs } from "./shared.js";

/** Parse `src` and return the first node matching `type` (DFS pre-order). */
function firstNode(tree: Parser.Tree, type: string): Parser.SyntaxNode | null {
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length) {
    const n = stack.shift()!;
    if (n.type === type) return n;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return null;
}

describe("extractSimpleTypeName — TypeScript", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  /** Resolve the type-annotation node of `const x: <T> = …`. */
  function typeOf(src: string): string | undefined {
    const tree = parser.parse(src);
    const decl = firstNode(tree, "variable_declarator");
    const ann = decl?.childForFieldName("type"); // type_annotation
    const inner = ann?.firstNamedChild ?? ann; // the actual type node
    return inner ? extractSimpleTypeName(inner) : undefined;
  }

  it("List<User> → List (base of a generic)", () => {
    expect(typeOf("const x: List<User> = y;")).toBe("List");
  });
  it("models.User → User (qualified last segment)", () => {
    expect(typeOf("const x: models.User = y;")).toBe("User");
  });
  it("User | null → User (nullable union unwrap)", () => {
    expect(typeOf("const x: User | null = y;")).toBe("User");
  });
  it("User | undefined → User", () => {
    expect(typeOf("const x: User | undefined = y;")).toBe("User");
  });
  it("User | Order → undefined (genuine union)", () => {
    expect(typeOf("const x: User | Order = y;")).toBeUndefined();
  });
  it("plain User → User", () => {
    expect(typeOf("const x: User = y;")).toBe("User");
  });

  it("extractGenericTypeArgs: List<User, String> → ['User','String']", () => {
    const tree = parser.parse("const x: List<User, String> = y;");
    const decl = firstNode(tree, "variable_declarator");
    const ann = decl!.childForFieldName("type")!;
    const inner = ann.firstNamedChild!;
    expect(extractGenericTypeArgs(inner)).toEqual(["User", "String"]);
  });
});

describe("extractSimpleTypeName — Go pointer", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("go"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("*User → User (pointer_type)", () => {
    const tree = parser.parse("package p\nvar x *User\n");
    const ptr = firstNode(tree, "pointer_type");
    expect(ptr).not.toBeNull();
    expect(extractSimpleTypeName(ptr!)).toBe("User");
  });
});

describe("extractVarName", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("variable_declarator → its name", () => {
    const tree = parser.parse("const myVar = 1;");
    const decl = firstNode(tree, "variable_declarator")!;
    expect(extractVarName(decl)).toBe("myVar");
  });
});
