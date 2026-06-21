/**
 * Tests for MCP validation.
 */
import { describe, it, expect } from "vitest";
import { validateMCPRequest, validateToolParams } from "./validation.js";
import { MCPValidationError } from "./types.js";

describe("validateMCPRequest", () => {
  it("accepts valid request", () => {
    const request = { method: "test", params: {} };
    expect(() => validateMCPRequest(request)).not.toThrow();
  });

  it("throws for null request", () => {
    expect(() => validateMCPRequest(null)).toThrow(MCPValidationError);
    expect(() => validateMCPRequest(null)).toThrow("Request must be an object");
  });

  it("throws for non-object request", () => {
    expect(() => validateMCPRequest("invalid")).toThrow(MCPValidationError);
    expect(() => validateMCPRequest(123)).toThrow(MCPValidationError);
  });

  it("throws for missing method", () => {
    expect(() => validateMCPRequest({ params: {} })).toThrow(MCPValidationError);
    expect(() => validateMCPRequest({ params: {} })).toThrow("method");
  });

  it("throws for non-string method", () => {
    expect(() => validateMCPRequest({ method: 123, params: {} })).toThrow(MCPValidationError);
  });

  it("throws for missing params", () => {
    expect(() => validateMCPRequest({ method: "test" })).toThrow(MCPValidationError);
    expect(() => validateMCPRequest({ method: "test" })).toThrow("params");
  });

  it("throws for non-object params", () => {
    expect(() => validateMCPRequest({ method: "test", params: "invalid" })).toThrow(MCPValidationError);
    expect(() => validateMCPRequest({ method: "test", params: [] })).toThrow(MCPValidationError);
  });
});

describe("validateToolParams", () => {
  describe("get_symbol_context", () => {
    it("accepts valid params", () => {
      expect(() => validateToolParams("get_symbol_context", { symbolName: "test" })).not.toThrow();
    });

    it("throws for missing symbolName", () => {
      expect(() => validateToolParams("get_symbol_context", {})).toThrow(MCPValidationError);
      expect(() => validateToolParams("get_symbol_context", {})).toThrow("symbolName");
    });

    it("throws for non-string symbolName", () => {
      expect(() => validateToolParams("get_symbol_context", { symbolName: 123 })).toThrow(MCPValidationError);
    });

    // D4 token-budgeted slicing params
    it("accepts valid tokenBudget / pin / maxDepth", () => {
      expect(() =>
        validateToolParams("get_symbol_context", {
          symbolName: "test",
          tokenBudget: 500,
          pin: ["a", "b"],
          maxDepth: 2,
        }),
      ).not.toThrow();
    });

    it("accepts tokenBudget 0 (unlimited)", () => {
      expect(() =>
        validateToolParams("get_symbol_context", { symbolName: "test", tokenBudget: 0 }),
      ).not.toThrow();
    });

    it("throws for negative tokenBudget", () => {
      expect(() =>
        validateToolParams("get_symbol_context", { symbolName: "test", tokenBudget: -1 }),
      ).toThrow("tokenBudget");
    });

    it("throws for non-number tokenBudget", () => {
      expect(() =>
        validateToolParams("get_symbol_context", { symbolName: "test", tokenBudget: "lots" }),
      ).toThrow(MCPValidationError);
    });

    it("throws for non-array pin", () => {
      expect(() =>
        validateToolParams("get_symbol_context", { symbolName: "test", pin: "a" }),
      ).toThrow("pin");
    });

    it("throws for pin with non-string elements", () => {
      expect(() =>
        validateToolParams("get_symbol_context", { symbolName: "test", pin: ["a", 2] }),
      ).toThrow("pin");
    });

    it("throws for non-number maxDepth", () => {
      expect(() =>
        validateToolParams("get_symbol_context", { symbolName: "test", maxDepth: "deep" }),
      ).toThrow("maxDepth");
    });
  });

  describe("trace_data_flow", () => {
    it("accepts valid params", () => {
      expect(() => validateToolParams("trace_data_flow", { entryPoint: "test" })).not.toThrow();
    });

    it("throws for missing entryPoint", () => {
      expect(() => validateToolParams("trace_data_flow", {})).toThrow(MCPValidationError);
    });
  });

  describe("impact_analysis", () => {
    it("accepts valid params", () => {
      expect(() => validateToolParams("impact_analysis", { symbolName: "test" })).not.toThrow();
      expect(() => validateToolParams("impact_analysis", { symbolName: "test", changeType: "modify" })).not.toThrow();
      expect(() => validateToolParams("impact_analysis", { symbolName: "test", changeType: "delete" })).not.toThrow();
      expect(() => validateToolParams("impact_analysis", { symbolName: "test", changeType: "rename" })).not.toThrow();
      // maxDepth folded in from the former find_dependents.
      expect(() => validateToolParams("impact_analysis", { symbolName: "test", maxDepth: 5 })).not.toThrow();
    });

    it("throws for missing symbolName", () => {
      expect(() => validateToolParams("impact_analysis", {})).toThrow(MCPValidationError);
    });

    it("throws for invalid changeType", () => {
      expect(() => validateToolParams("impact_analysis", { symbolName: "test", changeType: "invalid" })).toThrow(MCPValidationError);
    });

    it("throws for non-number maxDepth", () => {
      expect(() => validateToolParams("impact_analysis", { symbolName: "test", maxDepth: "5" })).toThrow(MCPValidationError);
    });
  });

  describe("shape_check", () => {
    it("accepts no params (graph-wide) and an optional string route", () => {
      expect(() => validateToolParams("shape_check", {})).not.toThrow();
      expect(() => validateToolParams("shape_check", { route: "GET /users" })).not.toThrow();
    });

    it("throws for a non-string route", () => {
      expect(() => validateToolParams("shape_check", { route: 5 })).toThrow(MCPValidationError);
    });

    it("no longer accepts api_impact (merged into shape_check)", () => {
      expect(() => validateToolParams("api_impact", { route: "GET /users" })).toThrow(MCPValidationError);
    });
  });

  describe("trace", () => {
    it("accepts valid params", () => {
      expect(() => validateToolParams("trace", { fromSymbol: "a", toSymbol: "b" })).not.toThrow();
      expect(() => validateToolParams("trace", { fromSymbol: "a", toSymbol: "b", maxDepth: 5 })).not.toThrow();
    });

    it("throws for missing fromSymbol", () => {
      expect(() => validateToolParams("trace", { toSymbol: "b" })).toThrow(MCPValidationError);
    });

    it("throws for missing toSymbol", () => {
      expect(() => validateToolParams("trace", { fromSymbol: "a" })).toThrow(MCPValidationError);
    });

    it("throws for non-number maxDepth", () => {
      expect(() => validateToolParams("trace", { fromSymbol: "a", toSymbol: "b", maxDepth: "5" })).toThrow(MCPValidationError);
    });
  });

  describe("unknown tool", () => {
    it("throws for unknown tool", () => {
      expect(() => validateToolParams("unknown_tool", {})).toThrow(MCPValidationError);
      expect(() => validateToolParams("unknown_tool", {})).toThrow("Unknown tool");
    });
  });
});
