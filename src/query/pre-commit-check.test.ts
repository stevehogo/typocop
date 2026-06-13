/**
 * Unit tests for pre-commit check query logic.
 * Validates: Requirements 11b.1, 11b.2, 11b.3, 11b.4, 11b.5
 */
import { describe, it, expect } from "vitest";
import { calculatePreCommitRisk } from "./pre-commit-check.js";
import type { Symbol } from "../core/domain.js";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createSymbol(id: string, name: string): Symbol {
  return {
    id,
    name,
    kind: "function",
    location: {
      filePath: "test.ts",
      startLine: 1,
      startColumn: 0,
      endLine: 10,
      endColumn: 0,
    },
    visibility: "public",
    modifiers: [],
  };
}

// ─── Risk Level Calculation Tests ─────────────────────────────────────────────

describe("calculatePreCommitRisk", () => {
  it("returns 'low' when 0-2 non-core symbols are affected", () => {
    const symbols = [
      createSymbol("s1", "getUserData"),
      createSymbol("s2", "formatOutput"),
    ];
    expect(calculatePreCommitRisk(symbols)).toBe("low");
  });

  it("returns 'medium' when 3-10 non-core symbols are affected", () => {
    const symbols = [
      createSymbol("s1", "getUserData"),
      createSymbol("s2", "formatOutput"),
      createSymbol("s3", "validateInput"),
      createSymbol("s4", "processRequest"),
      createSymbol("s5", "sendResponse"),
    ];
    expect(calculatePreCommitRisk(symbols)).toBe("medium");
  });

  it("returns 'high' when 11+ non-core symbols are affected", () => {
    const symbols = Array.from({ length: 15 }, (_, i) =>
      createSymbol(`s${i}`, `function${i}`),
    );
    expect(calculatePreCommitRisk(symbols)).toBe("high");
  });

  it("returns 'critical' when any core component is affected", () => {
    const symbols = [
      createSymbol("s1", "getUserData"),
      createSymbol("s2", "authService"),
    ];
    expect(calculatePreCommitRisk(symbols)).toBe("critical");
  });

  it("returns 'critical' for payment-related components", () => {
    const symbols = [createSymbol("s1", "processPayment")];
    expect(calculatePreCommitRisk(symbols)).toBe("critical");
  });

  it("returns 'critical' for security-related components", () => {
    const symbols = [createSymbol("s1", "validateSecurityToken")];
    expect(calculatePreCommitRisk(symbols)).toBe("critical");
  });

  it("returns 'low' for empty symbol list", () => {
    expect(calculatePreCommitRisk([])).toBe("low");
  });
});
