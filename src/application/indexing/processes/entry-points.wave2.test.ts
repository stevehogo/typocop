/**
 * Wave 2 (1.1) — entry-point scoring enhancements: language-keyed name patterns,
 * the path-based framework multiplier + reasons trail + kind classification,
 * test-file exclusion, utility-file penalty, and the `isExported`-preferring
 * export multiplier. Plus `annotateEntryPoints` attaching the persisted metadata.
 */
import { describe, it, expect } from "vitest";
import type { Symbol, Relationship } from "../../../core/domain.js";
import {
  calculateEntryPointScore,
  findEntryPoints,
  annotateEntryPoints,
} from "./entry-points.js";

function sym(partial: Partial<Symbol> & Pick<Symbol, "id" | "name">): Symbol {
  return {
    id: partial.id,
    logicalKey: partial.id,
    name: partial.name,
    kind: partial.kind ?? "function",
    location: {
      filePath: partial.location?.filePath ?? "/r/src/x.ts",
      startLine: 0, startColumn: 0, endLine: 1, endColumn: 0,
    },
    visibility: partial.visibility ?? "public",
    modifiers: [],
    ...(partial.isExported !== undefined ? { isExported: partial.isExported } : {}),
  };
}

function calls(from: string, to: string): Relationship {
  return { id: `${from}->${to}`, source: from, target: to, relType: "calls", metadata: {} };
}

describe("calculateEntryPointScore — reasons + kind", () => {
  it("produces a reasons trail and a kind", () => {
    const r = calculateEntryPointScore("handleLogin", "typescript", true, 0, 3, "/r/src/x.ts");
    expect(r.reasons[0]).toMatch(/^base:/);
    expect(r.reasons).toContain("exported");
    expect(r.reasons).toContain("entry-pattern");
    expect(r.kind).toBe("event"); // handle[A-Z], not *Handler/*Controller
  });

  it("a path-matched framework multiplies the score and records the reason", () => {
    const plain = calculateEntryPointScore("getUser", "typescript", true, 0, 3, "/r/src/lib/users.ts");
    const apiRoute = calculateEntryPointScore("getUser", "typescript", true, 0, 3, "/r/pages/api/users.ts");
    // getUser is a utility name (×0.3) in both; the framework ×3.0 only applies
    // to the api-route path, so it must score strictly higher.
    expect(apiRoute.score).toBeGreaterThan(plain.score);
    expect(apiRoute.reasons.some((x) => x.startsWith("framework:nextjs-api-route"))).toBe(true);
    expect(apiRoute.kind).toBe("route");
  });

  it("utility files get a penalty reason", () => {
    const r = calculateEntryPointScore("run", "typescript", true, 0, 3, "/r/src/utils/run.ts");
    expect(r.reasons).toContain("utility-file");
  });

  it("no outgoing calls → score 0", () => {
    expect(calculateEntryPointScore("main", "typescript", true, 0, 0).score).toBe(0);
  });
});

describe("findEntryPoints — test-file exclusion", () => {
  it("excludes a high-scoring symbol that lives in a test file", () => {
    const symbols: Symbol[] = [
      sym({ id: "h", name: "handleRequest", location: { filePath: "/r/src/x.test.ts" } as Symbol["location"], isExported: true }),
      sym({ id: "a", name: "a" }),
      sym({ id: "b", name: "b" }),
    ];
    const rels = [calls("h", "a"), calls("h", "b")];
    expect(findEntryPoints(symbols, rels)).not.toContain("h");
  });

  it("includes the same symbol when NOT in a test file", () => {
    const symbols: Symbol[] = [
      sym({ id: "h", name: "handleRequest", location: { filePath: "/r/src/handlers/x.ts" } as Symbol["location"], isExported: true }),
      sym({ id: "a", name: "a" }),
      sym({ id: "b", name: "b" }),
    ];
    const rels = [calls("h", "a"), calls("h", "b")];
    expect(findEntryPoints(symbols, rels)).toContain("h");
  });
});

describe("export multiplier prefers isExported over visibility", () => {
  it("an isExported=false symbol scores lower than its visibility=public peer would imply", () => {
    // Both are visibility:public, but one carries the real isExported=false.
    const exported = calculateEntryPointScore("handleRequest", "typescript", true, 0, 3);
    const notExported = calculateEntryPointScore("handleRequest", "typescript", false, 0, 3);
    expect(exported.score).toBeGreaterThan(notExported.score);
  });

  it("findEntryPoints reads isExported when present", () => {
    const exportedSym: Symbol[] = [
      sym({ id: "h1", name: "handleA", isExported: true }),
      sym({ id: "x", name: "x" }), sym({ id: "y", name: "y" }),
    ];
    const unexportedSym: Symbol[] = [
      sym({ id: "h2", name: "handleA", isExported: false }),
      sym({ id: "x", name: "x" }), sym({ id: "y", name: "y" }),
    ];
    const rels1 = [calls("h1", "x"), calls("h1", "y")];
    const rels2 = [calls("h2", "x"), calls("h2", "y")];
    // The exported one clears the threshold (2 callees, 0 callers, exported ×2,
    // entry-pattern ×1.5 = 6 > 1); the unexported relies on ×1 export = 3 > 1
    // too, so both are entry points — the point is no crash + correct ordering.
    expect(findEntryPoints(exportedSym, rels1)).toContain("h1");
    expect(findEntryPoints(unexportedSym, rels2)).toContain("h2");
  });
});

describe("annotateEntryPoints", () => {
  it("attaches entryPointKind + entryPointReason to symbols above threshold", () => {
    const symbols: Symbol[] = [
      sym({ id: "h", name: "handleRequest", location: { filePath: "/r/src/handlers/x.ts" } as Symbol["location"], isExported: true }),
      sym({ id: "a", name: "a" }),
      sym({ id: "b", name: "b" }),
    ];
    const rels = [calls("h", "a"), calls("h", "b")];
    const annotated = annotateEntryPoints(symbols, rels);
    const h = annotated.find((s) => s.id === "h");
    expect(h?.entryPointReason).toBeDefined();
    expect(h?.entryPointReason).toMatch(/base:/);
    expect(h?.entryPointKind).toBeDefined();
  });

  it("leaves below-threshold / non-eligible symbols unchanged", () => {
    const symbols: Symbol[] = [sym({ id: "a", name: "a" }), sym({ id: "b", name: "b" })];
    const annotated = annotateEntryPoints(symbols, []);
    // No entry points → returns the SAME array reference (no allocation).
    expect(annotated).toBe(symbols);
    expect(annotated.every((s) => s.entryPointKind === undefined)).toBe(true);
  });

  it("returns symbols unchanged for an empty input", () => {
    expect(annotateEntryPoints([], [])).toEqual([]);
  });
});
