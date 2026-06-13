import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { fromSyntaxNode } from "./ast-node.js";
import { initParser } from "./init.js";
import { extractSymbolsWithQueries } from "./extract-symbols.js";
import { isExternalPackage } from "../indexer/resolution/external-packages.js";

describe("extractSymbolsWithQueries (ruby imports)", () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = await initParser("ruby");
  });

  afterAll(() => {
    parser = undefined as unknown as Parser;
  });

  it("captures require 'gem' with ruby language metadata", () => {
    const tree = parser.parse("require 'gem'\n");
    const ast = fromSyntaxNode(tree.rootNode);

    const result = extractSymbolsWithQueries(ast, "/repo/lib/example.rb", "ruby", parser);

    expect(result.hints).toContainEqual(expect.objectContaining({
      kind: "import",
      sourceFile: "/repo/lib/example.rb",
      targetName: "gem",
      language: "ruby",
    }));
  });

  it("captures require_relative and leaves it internal", () => {
    const tree = parser.parse("require_relative './helper'\n");
    const ast = fromSyntaxNode(tree.rootNode);

    const result = extractSymbolsWithQueries(ast, "/repo/lib/example.rb", "ruby", parser);

    const importHint = result.hints.find((hint) => hint.kind === "import");

    expect(importHint).toEqual(expect.objectContaining({
      kind: "import",
      targetName: "./helper",
      language: "ruby",
    }));
    expect(isExternalPackage(importHint?.targetName ?? "", "ruby")).toBe(false);
  });
});
