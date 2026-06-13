import { describe, expect, it } from "vitest";
import type { Symbol } from "../../../core/domain.js";
import { resolveHints } from "./index.js";

function makeSymbol(id: string, filePath: string): Symbol {
  return {
    id,
    name: id,
    kind: "function",
    location: {
      filePath,
      startLine: 1,
      startColumn: 0,
      endLine: 10,
      endColumn: 0,
    },
    visibility: "public",
    modifiers: [],
  };
}

describe("resolveHints external dependency integration", () => {
  it("creates npm dependency nodes for TypeScript bare imports", () => {
    const sourceFile = "/repo/src/example.ts";
    const result = resolveHints([{
      kind: "import",
      sourceFile,
      targetName: "@scope/pkg/subpath",
      startLine: 1,
      language: "typescript",
    }], [makeSymbol("sym-1", sourceFile)]);

    expect([...result.extNodes.values()]).toEqual([
      expect.objectContaining({ id: "ext:@scope/pkg", ecosystem: "npm" }),
    ]);
    expect(result.relationships).toContainEqual(expect.objectContaining({
      relType: "dependsOn",
      target: "ext:@scope/pkg",
    }));
  });

  it("creates composer dependency nodes for PHP namespace imports", () => {
    const sourceFile = "/repo/src/example.php";
    const result = resolveHints([{
      kind: "import",
      sourceFile,
      targetName: "Vendor\\Package\\Service",
      startLine: 1,
      language: "php",
    }], [makeSymbol("sym-1", sourceFile)]);

    expect([...result.extNodes.values()][0]).toEqual(expect.objectContaining({
      id: "ext:Vendor",
      ecosystem: "composer",
    }));
  });

  it("keeps internal relative imports on imports edges", () => {
    const sourceFile = "/repo/src/example.ts";
    const target: Symbol = {
      ...makeSymbol("helper-id", sourceFile),
      name: "helper",
    };
    const result = resolveHints([{
      kind: "import",
      sourceFile,
      targetName: "./helper",
      startLine: 1,
      language: "typescript",
    }], [makeSymbol("sym-1", sourceFile), target]);

    expect(result.relationships.some((relationship) => relationship.relType === "imports")).toBe(true);
    expect(result.relationships.some((relationship) => relationship.relType === "dependsOn")).toBe(false);
  });
});
