/**
 * Simple unit test for MCP find_dependents tool using mocks
 * Tests the tool logic without requiring full database setup
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../src/core/ports/persistence.js";
import { executeTool } from "../src/mcp/tools.js";
import type { MCPToolResponse } from "../src/core/domain.js";

// Mock the query modules
vi.mock("../src/query/impact-analysis.js", () => ({
  executeImpactAnalysis: vi.fn(),
}));

import { executeImpactAnalysis } from "../src/query/impact-analysis.js";

describe("MCP find_dependents tool (mocked)", () => {
  let mockAdapter: DatabaseAdapter;

  beforeEach(() => {
    // Create a mock adapter
    mockAdapter = {
      getGraphAdapter: vi.fn(),
      getVectorAdapter: vi.fn(),
      getEmbeddingAdapter: vi.fn(),
      initialize: vi.fn(),
      close: vi.fn(),
    } as any;
  });

  it("should find dependents of add() function", async () => {
    // Mock the impact analysis result
    (executeImpactAnalysis as any).mockResolvedValue({
      resolution: { kind: "exact", node: { id: "add", labels: ["Symbol"], properties: { id: "add", name: "add" } } },
      targetKind: "symbol",
      symbols: [
        {
          id: "processData",
          name: "processData",
          kind: "function",
          location: { filePath: "main.ts", startLine: 10, startColumn: 0, endLine: 15, endColumn: 0 },
          visibility: "export",
          modifiers: [],
        },
      ],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.92,
      riskLevel: "low",
      affectedFlows: [],
    });

    const result = (await executeTool("find_dependents", {
      symbolName: "add",
      maxResults: 50,
    }, mockAdapter)) as MCPToolResponse;

    expect(result).toBeDefined();
    expect(result.symbols).toBeDefined();
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.symbols[0].name).toBe("processData");
    expect(result.summary).toContain("dependents");
  });

  it("should return empty array for symbol with no dependents", async () => {
    // Mock the impact analysis result with no dependents
    (executeImpactAnalysis as any).mockResolvedValue({
      resolution: { kind: "exact", node: { id: "multiply", labels: ["Symbol"], properties: { id: "multiply", name: "multiply" } } },
      targetKind: "symbol",
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.75,
      riskLevel: "low",
      affectedFlows: [],
    });

    const result = (await executeTool("find_dependents", {
      symbolName: "multiply",
      maxResults: 50,
    }, mockAdapter)) as MCPToolResponse;

    expect(result).toBeDefined();
    expect(result.symbols).toBeDefined();
    expect(result.symbols.length).toBe(0);
  });

  it("should handle non-existent symbol gracefully", async () => {
    // Mock the impact analysis result for non-existent symbol
    (executeImpactAnalysis as any).mockResolvedValue({
      resolution: { kind: "not_found", suggestions: ["add", "multiply"] },
      targetKind: "symbol",
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.5,
      riskLevel: "low",
      affectedFlows: [],
    });

    const result = (await executeTool("find_dependents", {
      symbolName: "nonExistentSymbol",
      maxResults: 50,
    }, mockAdapter)) as MCPToolResponse;

    expect(result).toBeDefined();
    expect(result.symbols).toBeDefined();
    expect(result.symbols.length).toBe(0);
    expect(result.summary).toContain("not found");
  });

  it("should include confidence and risk level in result", async () => {
    // Mock the impact analysis result
    (executeImpactAnalysis as any).mockResolvedValue({
      resolution: { kind: "exact", node: { id: "add", labels: ["Symbol"], properties: { id: "add", name: "add" } } },
      targetKind: "symbol",
      symbols: [
        {
          id: "processData",
          name: "processData",
          kind: "function",
          location: { filePath: "main.ts", startLine: 10, startColumn: 0, endLine: 15, endColumn: 0 },
          visibility: "export",
          modifiers: [],
        },
      ],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.92,
      riskLevel: "high",
      affectedFlows: ["flow1", "flow2"],
    });

    const result = (await executeTool("find_dependents", {
      symbolName: "add",
      maxResults: 50,
    }, mockAdapter)) as MCPToolResponse;

    expect(result.confidence).toBe(0.92);
    expect(result.riskLevel).toBe("high");
    expect(result.affectedFlows.length).toBe(2);
  });

  it("should return valid MCPToolResponse structure", async () => {
    // Mock the impact analysis result
    (executeImpactAnalysis as any).mockResolvedValue({
      resolution: { kind: "exact", node: { id: "add", labels: ["Symbol"], properties: { id: "add", name: "add" } } },
      targetKind: "symbol",
      symbols: [
        {
          id: "processData",
          name: "processData",
          kind: "function",
          location: { filePath: "main.ts", startLine: 10, startColumn: 0, endLine: 15, endColumn: 0 },
          visibility: "export",
          modifiers: [],
        },
      ],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.92,
      riskLevel: "low",
      affectedFlows: [],
    });

    const result = (await executeTool("find_dependents", {
      symbolName: "add",
      maxResults: 50,
    }, mockAdapter)) as MCPToolResponse;

    // Verify MCPToolResponse structure
    expect(result).toHaveProperty("symbols");
    expect(result).toHaveProperty("clusters");
    expect(result).toHaveProperty("processes");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("riskLevel");
    expect(result).toHaveProperty("affectedFlows");
    expect(result).toHaveProperty("summary");

    // Verify array properties
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(Array.isArray(result.clusters)).toBe(true);
    expect(Array.isArray(result.processes)).toBe(true);
    expect(Array.isArray(result.affectedFlows)).toBe(true);

    // Verify types
    expect(typeof result.confidence).toBe("number");
    expect(typeof result.riskLevel).toBe("string");
    expect(typeof result.summary).toBe("string");
  });

  it("should include summary in result", async () => {
    // Mock the impact analysis result
    (executeImpactAnalysis as any).mockResolvedValue({
      resolution: { kind: "exact", node: { id: "add", labels: ["Symbol"], properties: { id: "add", name: "add" } } },
      targetKind: "symbol",
      symbols: [
        {
          id: "processData",
          name: "processData",
          kind: "function",
          location: { filePath: "main.ts", startLine: 10, startColumn: 0, endLine: 15, endColumn: 0 },
          visibility: "export",
          modifiers: [],
        },
      ],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.92,
      riskLevel: "low",
      affectedFlows: [],
    });

    const result = (await executeTool("find_dependents", {
      symbolName: "add",
      maxResults: 50,
    }, mockAdapter)) as MCPToolResponse;

    expect(result.summary).toBeDefined();
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).toContain("dependents");
  });

  it("should respect maxResults parameter", async () => {
    // Mock the impact analysis result with multiple dependents
    // Note: executeImpactAnalysis already slices to maxResults, so we mock that behavior
    (executeImpactAnalysis as any).mockImplementation(async (target: string, maxResults: number) => ({
      resolution: { kind: "exact", node: { id: "add", labels: ["Symbol"], properties: { id: "add", name: "add" } } },
      targetKind: "symbol",
      symbols: Array.from({ length: Math.min(5, maxResults) }, (_, i) => ({
        id: `sym-${i}`,
        name: `symbol${i}`,
        kind: "function",
        location: { filePath: "main.ts", startLine: 10 + i, startColumn: 0, endLine: 15 + i, endColumn: 0 },
        visibility: "export",
        modifiers: [],
      })),
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.92,
      riskLevel: "low",
      affectedFlows: [],
    }));

    const result = (await executeTool("find_dependents", {
      symbolName: "add",
      maxResults: 5,
    }, mockAdapter)) as MCPToolResponse;

    // The tool should respect maxResults and limit to 5
    expect(result.symbols.length).toBeLessThanOrEqual(5);
  });

  it("should handle fuzzy matching", async () => {
    // Mock the impact analysis result with fuzzy matching
    (executeImpactAnalysis as any).mockResolvedValue({
      resolution: { kind: "fuzzy", matchedName: "add", suggestions: [] },
      targetKind: "symbol",
      symbols: [
        {
          id: "processData",
          name: "processData",
          kind: "function",
          location: { filePath: "main.ts", startLine: 10, startColumn: 0, endLine: 15, endColumn: 0 },
          visibility: "export",
          modifiers: [],
        },
      ],
      relationships: [],
      clusters: [],
      processes: [],
      confidence: 0.85,
      riskLevel: "low",
      affectedFlows: [],
    });

    const result = (await executeTool("find_dependents", {
      symbolName: "ad",
      maxResults: 50,
    }, mockAdapter)) as MCPToolResponse;

    expect(result.summary).toContain("Fuzzy matched");
    expect(result.summary).toContain("add");
  });
});
