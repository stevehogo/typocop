/**
 * Property tests for impact analysis risk level consistency.
 * Property 12: Risk Level Consistency — risk level must match affected symbol count thresholds.
 * Validates: Requirements 10.4, 10.5, 10.6, 10.7
 */
import { describe, it } from "vitest";
import * as fc from "fast-check";
import { calculateImpactRisk } from "./impact-analysis.js";
import { symbolArbitrary } from "../../types/arbitraries.js";
import type { Symbol } from "../../core/domain.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Override symbol name to avoid core-component pattern matches. */
const neutralSymbol = (): fc.Arbitrary<Symbol> =>
  symbolArbitrary().map((s) => ({
    ...s,
    name: `symbol_${s.id.replace(/[^a-z0-9]/gi, "_")}`,
  }));

/** Symbols whose names match a core-component pattern (auth, payment, etc.). */
const coreComponentSymbol = (): fc.Arbitrary<Symbol> =>
  symbolArbitrary().map((s) => ({ ...s, name: `authService_${s.id}` }));

// ─── Property 12: Risk Level Consistency ─────────────────────────────────────

describe("calculateImpactRisk — Property 12: Risk Level Consistency", () => {
  /**
   * Req 10.4: LOW risk → 0–2 affected symbols (no core components).
   */
  it("returns 'low' when 0–2 non-core symbols are affected", () => {
    fc.assert(
      fc.property(
        fc.array(neutralSymbol(), { minLength: 0, maxLength: 2 }),
        (symbols) => {
          return calculateImpactRisk(symbols) === "low";
        },
      ),
    );
  });

  /**
   * Req 10.5: MEDIUM risk → 3–10 affected symbols (no core components).
   */
  it("returns 'medium' when 3–10 non-core symbols are affected", () => {
    fc.assert(
      fc.property(
        fc.array(neutralSymbol(), { minLength: 3, maxLength: 10 }),
        (symbols) => {
          return calculateImpactRisk(symbols) === "medium";
        },
      ),
    );
  });

  /**
   * Req 10.6: HIGH risk → 11+ affected symbols (no core components).
   */
  it("returns 'high' when 11 or more non-core symbols are affected", () => {
    fc.assert(
      fc.property(
        fc.array(neutralSymbol(), { minLength: 11, maxLength: 50 }),
        (symbols) => {
          return calculateImpactRisk(symbols) === "high";
        },
      ),
    );
  });

  /**
   * Req 10.7: CRITICAL risk → core system components are affected,
   * regardless of count.
   */
  it("returns 'critical' when any core component symbol is present", () => {
    fc.assert(
      fc.property(
        fc.array(neutralSymbol(), { minLength: 0, maxLength: 20 }),
        coreComponentSymbol(),
        (others, core) => {
          // Insert the core component at a random position
          const symbols = [...others, core];
          return calculateImpactRisk(symbols) === "critical";
        },
      ),
    );
  });

  /**
   * Consistency invariant: the returned risk level must always correspond
   * to the correct threshold bucket for non-core symbols.
   * This is the canonical Property 12 from design-correctness.md.
   */
  it("risk level always matches the count-based threshold for non-core symbols", () => {
    fc.assert(
      fc.property(
        fc.array(neutralSymbol(), { minLength: 0, maxLength: 50 }),
        (symbols) => {
          const risk = calculateImpactRisk(symbols);
          const count = symbols.length;
          switch (risk) {
            case "low":      return count <= 2;
            case "medium":   return count >= 3 && count <= 10;
            case "high":     return count >= 11;
            case "critical": return false; // neutralSymbol() never triggers critical
          }
        },
      ),
    );
  });
});
