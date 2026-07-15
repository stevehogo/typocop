/**
 * Tasks 1 + 2 — claim/verdict types, parseClaim (discriminated-shape
 * validation), and the unresolved-symbol → graceful-uncertain helper.
 */
import { describe, it, expect } from "vitest";
import { parseClaim, unresolvedAssessment } from "./verify-claim-types.js";

describe("parseClaim", () => {
  it("parses a valid usage claim", () => {
    const r = parseClaim({ kind: "usage", symbol: "doThing" });
    expect(r).toEqual({ ok: true, claim: { kind: "usage", symbol: "doThing" } });
  });

  it("parses a valid edge claim with a known relation", () => {
    const r = parseClaim({ kind: "edge", from: "A", to: "B", relation: "calls" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claim).toEqual({ kind: "edge", from: "A", to: "B", relation: "calls" });
  });

  it("parses a valid reachability claim for both polarities", () => {
    for (const polarity of ["reachable", "independent"] as const) {
      const r = parseClaim({ kind: "reachability", from: "A", to: "B", polarity });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.claim).toEqual({ kind: "reachability", from: "A", to: "B", polarity });
    }
  });

  it("rejects a missing kind", () => {
    const r = parseClaim({ symbol: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/kind/i);
  });

  it("rejects a usage claim with no symbol", () => {
    const r = parseClaim({ kind: "usage" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/symbol/i);
  });

  it("rejects an edge claim with an unknown relation", () => {
    const r = parseClaim({ kind: "edge", from: "A", to: "B", relation: "contains" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/relation/i);
  });

  it("parses an edge claim for the Wave 8 heritage relations (overrides / methodImplements)", () => {
    for (const relation of ["overrides", "methodImplements"] as const) {
      const r = parseClaim({ kind: "edge", from: "A", to: "B", relation });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.claim).toEqual({ kind: "edge", from: "A", to: "B", relation });
    }
  });

  it("rejects an edge claim missing endpoints", () => {
    const r = parseClaim({ kind: "edge", relation: "calls" });
    expect(r.ok).toBe(false);
  });

  it("rejects a reachability claim with a bad polarity", () => {
    const r = parseClaim({ kind: "reachability", from: "A", to: "B", polarity: "maybe" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/polarity/i);
  });

  it("rejects an unknown kind", () => {
    const r = parseClaim({ kind: "membership", symbol: "x" });
    expect(r.ok).toBe(false);
  });
});

describe("unresolvedAssessment", () => {
  it("yields an uncertain assessment carrying did-you-mean suggestions", () => {
    const a = unresolvedAssessment("Symbol", "doThig", {
      kind: "not_found",
      suggestions: ["doThing", "doThings"],
    });
    expect(a.verdict).toBe("uncertain");
    expect(a.basis).toBe("absence");
    expect(a.dynamicReachable).toBe(false);
    expect(a.evidence).toEqual(["doThing", "doThings"]);
    expect(a.reason).toContain("doThing");
    expect(a.reason).toMatch(/did you mean/i);
  });

  it("handles the no-suggestions case gracefully", () => {
    const a = unresolvedAssessment("Symbol", "zzz", { kind: "not_found", suggestions: [] });
    expect(a.verdict).toBe("uncertain");
    expect(a.reason).toMatch(/no similar symbols/i);
  });
});
