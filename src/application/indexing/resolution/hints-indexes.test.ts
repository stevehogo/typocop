/**
 * PR10 regression tests for `resolveHints`.
 *
 * Cover:
 * - the nodeId resolution fix: the ctx same-file precise tier must win over a
 *   same-named symbol in another file (previously dead — name fallback picked
 *   whichever symbol was inserted first into symbolMap).
 * - DEPENDS_ON external-dependency fan-out reporting (count only; behavior of
 *   which edges are created is unchanged).
 */
import { describe, expect, it } from "vitest";
import type { Symbol } from "../../../core/domain.js";
import { resolveHints } from "./index.js";

function makeSymbol(overrides: Partial<Symbol> & Pick<Symbol, "id" | "name">): Symbol {
  return {
    logicalKey: overrides.id,
    kind: "function",
    visibility: "public",
    modifiers: [],
    location: {
      filePath: "a.ts",
      startLine: 1,
      startColumn: 0,
      endLine: 10,
      endColumn: 0,
    },
    ...overrides,
  };
}

describe("resolveHints — nodeId same-file precise resolution (PR10 fix)", () => {
  it("prefers the same-file symbol over a same-named symbol in another file, even when the other file's symbol was inserted first", () => {
    // Arrange — GLOBAL symbol (other file) deliberately inserted BEFORE the
    // same-file one. The old name-fallback path picked symbolMap.get("Widget")[0]
    // = first insertion = the WRONG (other-file) symbol. The ctx same-file tier
    // returns the same-file symbol; resolving its nodeId via symbolById now wins.
    const otherFile = makeSymbol({
      id: "z:Widget:5",
      name: "Widget",
      kind: "class",
      location: { filePath: "z.ts", startLine: 5, startColumn: 0, endLine: 9, endColumn: 0 },
    });
    const sameFile = makeSymbol({
      id: "a:Widget:50",
      name: "Widget",
      kind: "class",
      location: { filePath: "a.ts", startLine: 50, startColumn: 0, endLine: 60, endColumn: 0 },
    });

    // Act — import "./Widget" from a.ts
    const result = resolveHints(
      [{ kind: "import", sourceFile: "a.ts", targetName: "./Widget", startLine: 1, language: "typescript" }],
      [otherFile, sameFile],
    );

    // Assert — resolves to the SAME-FILE symbol, not the first-inserted global.
    const importRel = result.relationships.find((r) => r.relType === "imports");
    expect(importRel).toBeDefined();
    expect(importRel?.target).toBe("a:Widget:50");
    expect(importRel?.metadata["unresolved"]).toBeUndefined();
  });

  it("still resolves a cross-file import when there is no same-file symbol", () => {
    // Arrange — only an other-file symbol exists; ctx falls through to name fallback.
    const otherFile = makeSymbol({
      id: "b:Helper:5",
      name: "Helper",
      kind: "class",
      location: { filePath: "b.ts", startLine: 5, startColumn: 0, endLine: 9, endColumn: 0 },
    });
    const importingSym = makeSymbol({ id: "a:fn:1", name: "fn", location: { filePath: "a.ts", startLine: 1, startColumn: 0, endLine: 3, endColumn: 0 } });

    // Act
    const result = resolveHints(
      [{ kind: "import", sourceFile: "a.ts", targetName: "./Helper", startLine: 1, language: "typescript" }],
      [otherFile, importingSym],
    );

    // Assert
    const importRel = result.relationships.find((r) => r.relType === "imports");
    expect(importRel?.target).toBe("b:Helper:5");
  });
});

describe("resolveHints — DEPENDS_ON fan-out reporting (PR10)", () => {
  it("reports the total dependsOn edge count and the max per-import fan-out", () => {
    // Arrange — file with 4 symbols and 2 external imports → 4 × 2 = 8 edges.
    const file = "/repo/src/c.ts";
    const symbols = [0, 1, 2, 3].map((i) =>
      makeSymbol({ id: `c:s${i}`, name: `s${i}`, location: { filePath: file, startLine: i + 1, startColumn: 0, endLine: i + 1, endColumn: 0 } }),
    );

    // Act
    const result = resolveHints(
      [
        { kind: "import", sourceFile: file, targetName: "lodash", startLine: 1, language: "typescript" },
        { kind: "import", sourceFile: file, targetName: "@scope/pkg", startLine: 2, language: "typescript" },
      ],
      symbols,
    );

    // Assert — behavior unchanged (8 dependsOn edges) and stat surfaces it.
    const dependsOn = result.relationships.filter((r) => r.relType === "dependsOn");
    expect(dependsOn).toHaveLength(8);
    expect(result.dependsOnStats?.edgeCount).toBe(8);
    expect(result.dependsOnStats?.maxFanOutPerImport).toBe(4);
  });

  it("reports zero fan-out when there are no external imports", () => {
    // Arrange
    const sym = makeSymbol({ id: "a:fn", name: "fn" });

    // Act
    const result = resolveHints(
      [{ kind: "import", sourceFile: "a.ts", targetName: "./local", startLine: 1, language: "typescript" }],
      [sym],
    );

    // Assert
    expect(result.dependsOnStats?.edgeCount).toBe(0);
    expect(result.dependsOnStats?.maxFanOutPerImport).toBe(0);
  });
});

describe("resolveHints — same-file call caller selection preserved (PR10)", () => {
  it("selects the first symbol whose range contains the call line and resolves the target", () => {
    // Arrange — caller fn spans lines 1-10, callee target is same-file.
    const caller = makeSymbol({ id: "a:caller:1", name: "caller", location: { filePath: "a.ts", startLine: 1, startColumn: 0, endLine: 10, endColumn: 0 } });
    const callee = makeSymbol({ id: "a:doThing:20", name: "doThing", location: { filePath: "a.ts", startLine: 20, startColumn: 0, endLine: 25, endColumn: 0 } });

    // Act — call hint on line 5 (inside caller's range)
    const result = resolveHints(
      [{ kind: "call", sourceFile: "a.ts", targetName: "doThing", startLine: 5, language: "typescript" }],
      [caller, callee],
    );

    // Assert
    const callRel = result.relationships.find((r) => r.relType === "calls");
    expect(callRel?.source).toBe("a:caller:1");
    expect(callRel?.target).toBe("a:doThing:20");
  });
});
