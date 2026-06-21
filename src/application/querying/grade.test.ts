/**
 * Task 6 — confidence + honest-uncertainty grader (D5, mandatory).
 *
 * Truth table over (verdict × basis × dynamicReachable). The keystone case: an
 * absence-based confirm/refute that a dynamic relationship could flip MUST be
 * downgraded to `uncertain` — never a false confirm/refute.
 */
import { describe, it, expect } from "vitest";
import { gradeVerdict, type ClaimAssessment } from "./verify-claim-types.js";

function assess(over: Partial<ClaimAssessment>): ClaimAssessment {
  return {
    verdict: "confirmed",
    reason: "r",
    evidence: [],
    basis: "presence",
    dynamicReachable: false,
    ...over,
  };
}

describe("gradeVerdict — truth table", () => {
  it("presence + confirmed → confirmed, high confidence", () => {
    const v = gradeVerdict(assess({ verdict: "confirmed", basis: "presence" }));
    expect(v.verdict).toBe("confirmed");
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("presence + refuted → refuted (high), carries the trueAnswer", () => {
    const v = gradeVerdict(
      assess({ verdict: "refuted", basis: "presence", trueAnswer: "called by X" }),
    );
    expect(v.verdict).toBe("refuted");
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
    expect(v.trueAnswer).toBe("called by X");
  });

  it("absence + confirmed + no dynamic risk → confirmed, moderate confidence", () => {
    const v = gradeVerdict(assess({ verdict: "confirmed", basis: "absence", dynamicReachable: false }));
    expect(v.verdict).toBe("confirmed");
    expect(v.confidence).toBeGreaterThan(0.5);
    expect(v.confidence).toBeLessThan(0.95);
  });

  it("absence + refuted + no dynamic risk → refuted, moderate confidence", () => {
    const v = gradeVerdict(assess({ verdict: "refuted", basis: "absence", dynamicReachable: false }));
    expect(v.verdict).toBe("refuted");
    expect(v.confidence).toBeGreaterThan(0.5);
  });

  it("KEYSTONE: absence + confirmed + dynamic risk → DOWNGRADED to uncertain (not a false confirm)", () => {
    const v = gradeVerdict(assess({ verdict: "confirmed", basis: "absence", dynamicReachable: true }));
    expect(v.verdict).toBe("uncertain");
    expect(v.confidence).toBe(0.5);
    expect(v.reason).toMatch(/dynamic/i);
  });

  it("absence + refuted + dynamic risk → downgraded to uncertain", () => {
    const v = gradeVerdict(assess({ verdict: "refuted", basis: "absence", dynamicReachable: true }));
    expect(v.verdict).toBe("uncertain");
  });

  it("an already-uncertain verdict stays uncertain", () => {
    const v = gradeVerdict(assess({ verdict: "uncertain", basis: "absence", dynamicReachable: false }));
    expect(v.verdict).toBe("uncertain");
    expect(v.confidence).toBe(0.5);
  });

  it("confidence is always within [0, 1]", () => {
    for (const verdict of ["confirmed", "refuted", "uncertain"] as const) {
      for (const basis of ["presence", "absence"] as const) {
        for (const dynamicReachable of [true, false]) {
          const v = gradeVerdict(assess({ verdict, basis, dynamicReachable }));
          expect(v.confidence).toBeGreaterThanOrEqual(0);
          expect(v.confidence).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
