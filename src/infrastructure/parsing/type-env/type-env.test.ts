/**
 * Wave 3 (Tier B) — `buildTypeEnv` / `TypeEnvironment.lookup` integration tests.
 *
 * Per-language constructor-inference (TS/JS/Python/Go/Java/PHP), doc-comment
 * types (JSDoc/PHPDoc), self/this/super/parent resolution, and scope isolation.
 * Runs against typocop's own pinned grammars. (§7 fixtures, Task 3/4 acceptance.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import type { Language } from "../../../core/domain.js";
import { initParser } from "../init.js";
import { buildTypeEnv } from "./type-env.js";

/** Find the FIRST member/property access node so we can hand `lookup` a call node. */
function findCallNode(
  root: Parser.SyntaxNode,
  memberTypes: string[],
): Parser.SyntaxNode | null {
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.shift()!;
    if (memberTypes.includes(n.type)) return n;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return null;
}

/** Resolve a receiver's type at the first member-access of `src`. */
function lookupAt(
  parser: Parser,
  language: Language,
  src: string,
  receiver: string,
  memberTypes: string[],
): string | undefined {
  const tree = parser.parse(src);
  const env = buildTypeEnv(tree, language);
  const member = findCallNode(tree.rootNode, memberTypes);
  if (!member) throw new Error("no member-access node found");
  return env.lookup(receiver, member);
}

describe("buildTypeEnv — TypeScript constructor inference", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("const u = new User(); u.save() → u : User", () => {
    const src = "class User { save(){} }\nfunction run(){ const u = new User(); u.save(); }";
    expect(lookupAt(parser, "typescript", src, "u", ["member_expression"])).toBe("User");
  });

  it("const x: Foo = bar; → x : Foo (annotation)", () => {
    const src = "function run(){ const x: Foo = bar; x.m(); }";
    expect(lookupAt(parser, "typescript", src, "x", ["member_expression"])).toBe("Foo");
  });

  it("new User() as unknown as T → still binds User (cast unwrap)", () => {
    const src = "function run(){ const u = new User() as unknown as T; u.save(); }";
    expect(lookupAt(parser, "typescript", src, "u", ["member_expression"])).toBe("User");
  });
});

describe("buildTypeEnv — TypeScript self/this and super/parent", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("this → enclosing class", () => {
    const src = "class Repo { find(){ this.load(); } load(){} }";
    expect(lookupAt(parser, "typescript", src, "this", ["member_expression"])).toBe("Repo");
  });

  it("super → superclass via extractParentClassFromNode", () => {
    const src = "class Base { m(){} }\nclass Derived extends Base { run(){ super.m(); } }";
    // The first member_expression is super.m inside Derived.run.
    expect(lookupAt(parser, "typescript", src, "super", ["member_expression"])).toBe("Base");
  });
});

describe("buildTypeEnv — scope isolation", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("two functions each declaring `u` of different types don't leak", () => {
    const src =
      "class A { m(){} }\nclass B { m(){} }\n" +
      "function f(){ const u = new A(); u.m(); }\n" +
      "function g(){ const u = new B(); u.m(); }\n";
    const tree = parser.parse(src);
    const env = buildTypeEnv(tree, "typescript");
    // Collect both member_expression nodes (u.m in f, then u.m in g).
    const members: Parser.SyntaxNode[] = [];
    const stack = [tree.rootNode];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === "member_expression") members.push(n);
      for (let i = n.childCount - 1; i >= 0; i--) {
        const c = n.child(i);
        if (c) stack.push(c);
      }
    }
    // Sort by source position to get f's call first, then g's.
    members.sort((a, b) => a.startIndex - b.startIndex);
    expect(env.lookup("u", members[0])).toBe("A");
    expect(env.lookup("u", members[1])).toBe("B");
  });
});

describe("buildTypeEnv — JavaScript JSDoc @param", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("javascript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("/** @param {User} u */ binds the param type", () => {
    const src = "/** @param {User} u */\nfunction run(u){ u.save(); }";
    expect(lookupAt(parser, "javascript", src, "u", ["member_expression"])).toBe("User");
  });
});

describe("buildTypeEnv — Python class-verified constructor inference", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("python"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("u = User(); u.save() → u : User (User is a local class)", () => {
    const src = "class User:\n    def save(self): pass\n\ndef run():\n    u = User()\n    u.save()\n";
    expect(lookupAt(parser, "python", src, "u", ["attribute"])).toBe("User");
  });

  it("v = make_thing() does NOT bind (callee not a known class)", () => {
    const src = "def run():\n    v = make_thing()\n    v.go()\n";
    expect(lookupAt(parser, "python", src, "v", ["attribute"])).toBeUndefined();
  });
});

describe("buildTypeEnv — Go composite literal & NewX constructor binding", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("go"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("u := &User{}; u.Save() → u : User", () => {
    const src = "package p\ntype User struct{}\nfunc (u *User) Save(){}\nfunc run(){ u := &User{}; u.Save() }\n";
    expect(lookupAt(parser, "go", src, "u", ["selector_expression"])).toBe("User");
  });

  it("u := NewUser() lands in constructorBindings (unverified)", () => {
    const src = "package p\nfunc run(){ u := NewUser(); u.Save() }\n";
    const tree = parser.parse(src);
    const env = buildTypeEnv(tree, "go");
    const b = env.constructorBindings.find((x) => x.varName === "u");
    expect(b?.calleeName).toBe("NewUser");
  });
});

describe("buildTypeEnv — Java", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("java"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("var u = new User(); u.save() → u : User", () => {
    const src = "class C { void run(){ var u = new User(); u.save(); } }";
    expect(lookupAt(parser, "java", src, "u", ["method_invocation"])).toBe("User");
  });

  it("User u = ...; u.save() → u : User (typed declaration)", () => {
    const src = "class C { void run(){ User u = factory(); u.save(); } }";
    expect(lookupAt(parser, "java", src, "u", ["method_invocation"])).toBe("User");
  });
});

describe("buildTypeEnv — PHP", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("php"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("$u = new User(); $u->save() → $u : User", () => {
    const src = "<?php\nfunction run(){ $u = new User(); $u->save(); }\n";
    expect(lookupAt(parser, "php", src, "$u", ["member_call_expression", "member_access_expression"])).toBe("User");
  });

  it("PHPDoc @param User $u binds the param type", () => {
    const src = "<?php\n/** @param User $u */\nfunction run($u){ $u->save(); }\n";
    expect(lookupAt(parser, "php", src, "$u", ["member_call_expression", "member_access_expression"])).toBe("User");
  });
});

describe("buildTypeEnv — unregistered language no-ops", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("ruby"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("ruby (unregistered) returns an empty env, never throws", () => {
    const src = "class User\n  def save; end\nend\n";
    const tree = parser.parse(src);
    const env = buildTypeEnv(tree, "ruby");
    expect(env.env.size).toBe(0);
    expect(env.constructorBindings).toEqual([]);
  });
});
