/**
 * Wave 1 — named-binding extraction over the real tree-sitter grammars
 * (TS/JS/Python/Java). Also verifies the bindings ride through
 * `extractSymbolsWithQueries` onto the emitted `import` hints.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "./init.js";
import { extractNamedBindings } from "./named-bindings.js";
import { extractSymbolsWithQueries } from "./extract-symbols.js";
import type { Language } from "../../core/domain.js";

/** Find the first descendant node of one of the given types (BFS). */
function findNode(root: Parser.SyntaxNode, types: Set<string>): Parser.SyntaxNode | null {
  const queue: Parser.SyntaxNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (types.has(node.type)) return node;
    for (const c of node.namedChildren) queue.push(c);
  }
  return null;
}

describe("extractNamedBindings — TypeScript", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  function bindingsOf(src: string) {
    const tree = parser.parse(src);
    const node = findNode(tree.rootNode, new Set(["import_statement", "export_statement"]));
    return node ? extractNamedBindings(node, "typescript") : undefined;
  }

  it("named import with alias", () => {
    expect(bindingsOf(`import { User, Repo as R } from './models';\n`)).toEqual([
      { local: "User", exported: "User" },
      { local: "R", exported: "Repo" },
    ]);
  });

  it("default import → undefined", () => {
    expect(bindingsOf(`import Foo from './foo';\n`)).toBeUndefined();
  });

  it("namespace import → undefined", () => {
    expect(bindingsOf(`import * as ns from './foo';\n`)).toBeUndefined();
  });

  it("re-export with alias: export { Repo as Repository }", () => {
    expect(bindingsOf(`export { Repo as Repository } from './models';\n`)).toEqual([
      { local: "Repository", exported: "Repo" },
    ]);
  });
});

describe("extractNamedBindings — JavaScript", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("javascript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  it("named import", () => {
    const tree = parser.parse(`import { foo as f } from './foo';\n`);
    const node = findNode(tree.rootNode, new Set(["import_statement"]));
    expect(node && extractNamedBindings(node, "javascript")).toEqual([{ local: "f", exported: "foo" }]);
  });
});

describe("extractNamedBindings — Python", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("python"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  function bindingsOf(src: string) {
    const tree = parser.parse(src);
    const node = findNode(tree.rootNode, new Set(["import_from_statement", "import_statement"]));
    return node ? extractNamedBindings(node, "python") : undefined;
  }

  it("from x import Repo as R", () => {
    expect(bindingsOf(`from models import User, Repo as R\n`)).toEqual([
      { local: "User", exported: "User" },
      { local: "R", exported: "Repo" },
    ]);
  });

  it("plain import → undefined", () => {
    expect(bindingsOf(`import os\n`)).toBeUndefined();
  });
});

describe("extractNamedBindings — Java", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("java"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  function bindingsOf(src: string) {
    const tree = parser.parse(src);
    const node = findNode(tree.rootNode, new Set(["import_declaration"]));
    return node ? extractNamedBindings(node, "java") : undefined;
  }

  it("class import → single binding", () => {
    expect(bindingsOf(`import com.example.models.User;\n`)).toEqual([{ local: "User", exported: "User" }]);
  });

  it("wildcard import → undefined", () => {
    expect(bindingsOf(`import com.example.models.*;\n`)).toBeUndefined();
  });
});

describe("extractSymbolsWithQueries — namedBindings on import hints (TS)", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  function extract(src: string, lang: Language = "typescript") {
    return extractSymbolsWithQueries(parser.parse(src), "src/index.ts", lang, parser);
  }

  it("attaches namedBindings to the import hint", () => {
    const { hints } = extract(`import { User as U } from './models';\n`);
    const imp = hints.find((h) => h.kind === "import");
    expect(imp?.namedBindings).toEqual([{ local: "U", exported: "User" }]);
  });

  it("default import carries no namedBindings field", () => {
    const { hints } = extract(`import Foo from './foo';\n`);
    const imp = hints.find((h) => h.kind === "import");
    expect(imp).toBeDefined();
    expect(imp?.namedBindings).toBeUndefined();
  });
});
