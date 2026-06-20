/**
 * D4 — token-budgeted context slicing tests.
 *
 * Pure unit tests over {@link sliceContext}/{@link estimateTokens} with small
 * synthetic Symbol fixtures (no graph/DB needed — the BFS operates on the
 * already-retrieved target + depth-1 caller/callee partition).
 */
import { describe, it, expect } from "vitest";
import type { Symbol } from "../../core/domain.js";
import {
  sliceContext,
  estimateTokens,
  type RelatedSymbol,
} from "./context-slice.js";

function makeSymbol(id: string, overrides: Partial<Symbol> = {}): Symbol {
  return {
    id,
    logicalKey: id,
    name: id,
    kind: "function",
    location: {
      filePath: `/repo/${id}.ts`,
      startLine: 1,
      startColumn: 0,
      endLine: 1,
      endColumn: 0,
    },
    visibility: "public",
    modifiers: [],
    ...overrides,
  };
}

const target = makeSymbol("target");
const caller1 = makeSymbol("caller1");
const caller2 = makeSymbol("caller2");
const callee1 = makeSymbol("callee1");
const callee2 = makeSymbol("callee2");

const related: RelatedSymbol[] = [
  { symbol: caller1, relation: "caller" },
  { symbol: caller2, relation: "caller" },
  { symbol: callee1, relation: "callee" },
  { symbol: callee2, relation: "callee" },
];

describe("estimateTokens", () => {
  it("uses a chars/4 heuristic and is always at least 1", () => {
    const s = makeSymbol("x", {
      name: "abcd", // 4 chars
      signature: "",
      location: { filePath: "", startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
    });
    // chars = name(4) + sig(0) + path(0) + 1 line * 40 = 44 → ceil(44/4) = 11
    expect(estimateTokens(s)).toBe(11);
  });

  it("scales with the symbol's line span", () => {
    const oneLine = makeSymbol("a", {
      name: "",
      location: { filePath: "", startLine: 10, startColumn: 0, endLine: 10, endColumn: 0 },
    });
    const tenLines = makeSymbol("a", {
      name: "",
      location: { filePath: "", startLine: 10, startColumn: 0, endLine: 19, endColumn: 0 },
    });
    expect(estimateTokens(tenLines)).toBeGreaterThan(estimateTokens(oneLine));
  });
});

describe("sliceContext", () => {
  it("budget 0 means unlimited → includes everything, complete", () => {
    const slice = sliceContext(target, related, { tokenBudget: 0 });
    expect(slice.symbols.map((n) => n.symbol.id)).toEqual([
      "target",
      "caller1",
      "caller2",
      "callee1",
      "callee2",
    ]);
    expect(slice.truncationReason).toBe("complete");
    expect(slice.tokenBudget).toBe(0);
  });

  it("a budget that fits everything reports complete", () => {
    const slice = sliceContext(target, related, { tokenBudget: 100000 });
    expect(slice.symbols).toHaveLength(5);
    expect(slice.truncationReason).toBe("complete");
    expect(slice.estimatedTokens).toBe(
      slice.symbols.reduce((sum, n) => sum + n.estimatedTokens, 0),
    );
  });

  it("a tight budget truncates and reports token_budget", () => {
    const each = estimateTokens(target);
    // Budget that fits only the target (depth 0); everything else is dropped.
    const slice = sliceContext(target, related, { tokenBudget: each });
    expect(slice.symbols.map((n) => n.symbol.id)).toEqual(["target"]);
    expect(slice.truncationReason).toBe("token_budget");
    expect(slice.estimatedTokens).toBeLessThanOrEqual(each);
  });

  it("deterministic BFS order: target → callers → callees", () => {
    const slice = sliceContext(target, related, { tokenBudget: 0 });
    expect(slice.symbols.map((n) => n.symbol.id)).toEqual([
      "target",
      "caller1",
      "caller2",
      "callee1",
      "callee2",
    ]);
    expect(slice.symbols.map((n) => n.depth)).toEqual([0, 1, 1, 1, 1]);
  });

  it("repeated calls produce identical output (deterministic)", () => {
    const a = sliceContext(target, related, { tokenBudget: 500 });
    const b = sliceContext(target, related, { tokenBudget: 500 });
    expect(a).toEqual(b);
  });

  describe("pinning", () => {
    it("budget 0 budget with pins still includes only-pinned-first semantics — pinned emitted first", () => {
      // Budget so small NOTHING fits, but a pinned callee must still appear.
      const slice = sliceContext(target, related, { tokenBudget: 1, pin: ["callee2"] });
      expect(slice.symbols.map((n) => n.symbol.id)).toEqual(["callee2"]);
      expect(slice.symbols[0]?.pinned).toBe(true);
      expect(slice.truncationReason).toBe("token_budget");
    });

    it("pinned symbols are always present even when over budget", () => {
      // Budget = 0 width → only pinned survive; pin both the target and a callee.
      const slice = sliceContext(target, related, { tokenBudget: 1, pin: ["target", "callee1"] });
      const ids = slice.symbols.map((n) => n.symbol.id);
      expect(ids).toContain("target");
      expect(ids).toContain("callee1");
      // Pinned come FIRST, before any unpinned (none fit here).
      expect(slice.symbols.every((n) => n.pinned)).toBe(true);
    });

    it("pinned bypass budget; remaining budget then fills unpinned in order", () => {
      const each = estimateTokens(target); // all fixtures cost the same
      // Pin callee2 (always in, costs `each`) + budget for 2 more unpinned.
      const slice = sliceContext(target, related, {
        tokenBudget: each * 3,
        pin: ["callee2"],
      });
      const ids = slice.symbols.map((n) => n.symbol.id);
      // callee2 pinned first; remaining budget (2 * each) fits target + caller1.
      expect(ids[0]).toBe("callee2");
      expect(ids).toContain("target");
      expect(ids).toContain("caller1");
      // budget exhausted before all unpinned included → token_budget
      expect(slice.truncationReason).toBe("token_budget");
    });

    it("pinned tokens count toward estimatedTokens", () => {
      const slice = sliceContext(target, related, { tokenBudget: 1, pin: ["target"] });
      expect(slice.estimatedTokens).toBe(estimateTokens(target));
    });
  });

  describe("maxDepth", () => {
    it("maxDepth 0 drops depth-1 neighbours and reports max_depth", () => {
      const slice = sliceContext(target, related, { tokenBudget: 0, maxDepth: 0 });
      expect(slice.symbols.map((n) => n.symbol.id)).toEqual(["target"]);
      expect(slice.truncationReason).toBe("max_depth");
    });

    it("maxDepth 0 still keeps pinned depth-1 nodes (pin bypasses depth)", () => {
      const slice = sliceContext(target, related, {
        tokenBudget: 0,
        maxDepth: 0,
        pin: ["caller1"],
      });
      const ids = slice.symbols.map((n) => n.symbol.id);
      expect(ids).toContain("caller1");
      expect(ids).toContain("target");
    });
  });

  it("token_budget takes precedence over max_depth when both would fire", () => {
    // maxDepth 1 includes neighbours, but a tight budget truncates them.
    const each = estimateTokens(target);
    const slice = sliceContext(target, related, { tokenBudget: each, maxDepth: 1 });
    expect(slice.truncationReason).toBe("token_budget");
  });

  it("a swappable estimateTokens seam is honoured", () => {
    const slice = sliceContext(target, related, {
      tokenBudget: 3,
      estimateTokens: () => 1, // every symbol costs 1 token
    });
    // budget 3 fits 3 of the 5 symbols in BFS order
    expect(slice.symbols.map((n) => n.symbol.id)).toEqual(["target", "caller1", "caller2"]);
    expect(slice.estimatedTokens).toBe(3);
    expect(slice.truncationReason).toBe("token_budget");
  });

  it("de-dupes a symbol that is both a caller and a callee (target wins, first relation wins)", () => {
    const dup = makeSymbol("dup");
    const rel: RelatedSymbol[] = [
      { symbol: dup, relation: "caller" },
      { symbol: dup, relation: "callee" },
    ];
    const slice = sliceContext(target, rel, { tokenBudget: 0 });
    expect(slice.symbols.map((n) => n.symbol.id)).toEqual(["target", "dup"]);
  });
});
