/**
 * Integration test for pre-commit check query (via GraphAdapter).
 * Demonstrates the complete flow from changed files to risk assessment.
 * Requirements: 11b.1, 11b.2, 11b.3, 11b.4, 11b.5, 7.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphAdapter, GraphNode } from "../db/types.js";
import { executePreCommitCheck } from "./pre-commit-check.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGraphAdapter(responses: unknown[][]): GraphAdapter {
  let callIndex = 0;
  return {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn(),
    queryRelationships: vi.fn(),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher: vi.fn().mockImplementation(() => {
      const result = responses[callIndex] ?? [];
      callIndex++;
      return Promise.resolve(result);
    }),
    runCypherWrite: vi.fn(),
  };
}

function symbolRow(id: string, name: string, filePath: string): unknown {
  return {
    s: {
      labels: ["Symbol"],
      properties: {
        id, name, kind: "function", filePath,
        startLine: "1", startColumn: "0", endLine: "10", endColumn: "0", visibility: "public",
      },
    },
  };
}

function nodeRow(id: string, name: string): unknown {
  return {
    n: {
      labels: ["Symbol"],
      properties: {
        id, name, kind: "function", filePath: `/src/${id}.ts`,
        startLine: "1", startColumn: "0", endLine: "10", endColumn: "0", visibility: "public",
      },
    },
  };
}

function processRow(id: string, name: string): unknown {
  return {
    p: {
      labels: ["Process"],
      properties: { id, name, entryPoint: "entry1" },
    },
  };
}

// ─── Integration Tests ────────────────────────────────────────────────────────

describe("executePreCommitCheck - integration (GraphAdapter)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns low risk when no symbols are found in changed files", async () => {
    const adapter = makeGraphAdapter([
      [],  // findSymbolsInFiles → empty
    ]);

    const result = await executePreCommitCheck(["src/utils/helper.ts"], 10, adapter);

    expect(result.riskLevel).toBe("low");
    expect(result.confidence).toBe(0.95);
    expect(result.symbols).toHaveLength(0);
  });

  it("identifies changed symbols and their dependents", async () => {
    const adapter = makeGraphAdapter([
      [symbolRow("s1", "getUserData", "src/user.ts")],  // findSymbolsInFiles
      [nodeRow("s2", "processUser"), nodeRow("s3", "displayUser")],  // findDependents for s1
      [],  // findProcessesBySymbol for s1
      [],  // findProcessesBySymbol for s2
      [],  // findProcessesBySymbol for s3
      [],  // findClustersBySymbol for s1
    ]);

    const result = await executePreCommitCheck(["src/user.ts"], 10, adapter);

    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.riskLevel).toBe("medium"); // 3 symbols total
    expect(result.confidence).toBe(0.93);
  });

  it("identifies affected business processes", async () => {
    const adapter = makeGraphAdapter([
      [symbolRow("s1", "authService", "src/auth.ts")],  // findSymbolsInFiles
      [],  // findDependents for s1
      [processRow("p1", "User Login Flow"), processRow("p2", "User Registration Flow")],  // findProcessesBySymbol for s1
      [],  // findProcessSteps for p1
      [],  // findProcessSteps for p2
      [],  // findClustersBySymbol for s1
    ]);

    const result = await executePreCommitCheck(["src/auth.ts"], 10, adapter);

    expect(result.riskLevel).toBe("critical"); // auth is a core component
    expect(result.processes).toHaveLength(2);
    expect(result.affectedFlows).toContain("User Login Flow");
    expect(result.affectedFlows).toContain("User Registration Flow");
  });

  it("generates appropriate test recommendations based on risk level", async () => {
    const adapter = makeGraphAdapter([
      [symbolRow("s1", "formatDate", "src/utils.ts")],  // findSymbolsInFiles
      [],  // findDependents for s1
      [],  // findProcessesBySymbol for s1
      [],  // findClustersBySymbol for s1
    ]);

    const result = await executePreCommitCheck(["src/utils.ts"], 10, adapter);

    expect(result.riskLevel).toBe("low");
    expect(result.affectedFlows.some((rec) => rec.includes("unit tests"))).toBe(true);
  });
});
