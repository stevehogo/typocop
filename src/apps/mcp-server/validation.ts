/**
 * MCP request validation.
 * Requirements: 15.3, 15.4
 */
import type { MCPRequest } from "./types.js";
import { MCPValidationError } from "./types.js";

/**
 * Validate MCP request format.
 * Requirements: 15.3, 15.4
 * 
 * @throws {MCPValidationError} If request is malformed
 */
export function validateMCPRequest(request: unknown): asserts request is MCPRequest {
  if (!request || typeof request !== "object") {
    throw new MCPValidationError(
      "Request must be an object",
      "INVALID_REQUEST_FORMAT",
      { received: typeof request },
    );
  }

  const req = request as Record<string, unknown>;

  if (!req.method || typeof req.method !== "string") {
    throw new MCPValidationError(
      "Request must have a 'method' field of type string",
      "MISSING_METHOD",
      { method: req.method },
    );
  }

  if (!req.params || typeof req.params !== "object" || Array.isArray(req.params)) {
    throw new MCPValidationError(
      "Request must have a 'params' field of type object",
      "INVALID_PARAMS",
      { params: req.params },
    );
  }
}

/**
 * Validate tool-specific parameters.
 * 
 * @throws {MCPValidationError} If parameters are invalid
 */
export function validateToolParams(
  toolName: string,
  params: Record<string, unknown>,
): void {
  switch (toolName) {
    case "get_symbol_context":
      if (!params.symbolName || typeof params.symbolName !== "string") {
        throw new MCPValidationError(
          "get_symbol_context requires 'symbolName' parameter",
          "MISSING_PARAMETER",
          { tool: toolName, missing: "symbolName" },
        );
      }
      // D4 — token-budgeted slicing params (all optional).
      if (params.tokenBudget !== undefined) {
        if (typeof params.tokenBudget !== "number" || params.tokenBudget < 0) {
          throw new MCPValidationError(
            "get_symbol_context 'tokenBudget' must be a non-negative number",
            "INVALID_PARAMETER_TYPE",
            { tool: toolName, parameter: "tokenBudget", expected: "non-negative number" },
          );
        }
      }
      if (params.pin !== undefined) {
        if (!Array.isArray(params.pin) || params.pin.some((p) => typeof p !== "string")) {
          throw new MCPValidationError(
            "get_symbol_context 'pin' must be an array of symbol id strings",
            "INVALID_PARAMETER_TYPE",
            { tool: toolName, parameter: "pin", expected: "string[]" },
          );
        }
      }
      if (params.maxDepth !== undefined && typeof params.maxDepth !== "number") {
        throw new MCPValidationError(
          "get_symbol_context 'maxDepth' must be a number",
          "INVALID_PARAMETER_TYPE",
          { tool: toolName, parameter: "maxDepth", expected: "number" },
        );
      }
      break;

    case "find_dependents":
      if (!params.symbolName || typeof params.symbolName !== "string") {
        throw new MCPValidationError(
          "find_dependents requires 'symbolName' parameter",
          "MISSING_PARAMETER",
          { tool: toolName, missing: "symbolName" },
        );
      }
      if (params.maxDepth !== undefined && typeof params.maxDepth !== "number") {
        throw new MCPValidationError(
          "find_dependents 'maxDepth' must be a number",
          "INVALID_PARAMETER_TYPE",
          { tool: toolName, parameter: "maxDepth", expected: "number" },
        );
      }
      break;

    case "trace_data_flow":
      if (!params.entryPoint || typeof params.entryPoint !== "string") {
        throw new MCPValidationError(
          "trace_data_flow requires 'entryPoint' parameter",
          "MISSING_PARAMETER",
          { tool: toolName, missing: "entryPoint" },
        );
      }
      break;

    case "impact_analysis":
      if (!params.symbolName || typeof params.symbolName !== "string") {
        throw new MCPValidationError(
          "impact_analysis requires 'symbolName' parameter",
          "MISSING_PARAMETER",
          { tool: toolName, missing: "symbolName" },
        );
      }
      if (params.changeType !== undefined) {
        const validTypes = ["modify", "delete", "rename"];
        if (!validTypes.includes(params.changeType as string)) {
          throw new MCPValidationError(
            `impact_analysis 'changeType' must be one of: ${validTypes.join(", ")}`,
            "INVALID_PARAMETER_VALUE",
            { tool: toolName, parameter: "changeType", validValues: validTypes },
          );
        }
      }
      break;

    case "smart_search":
      if (!params.query || typeof params.query !== "string" || params.query.trim() === "") {
        throw new MCPValidationError(
          "smart_search requires a non-empty 'query' parameter",
          "MISSING_PARAMETER",
          { tool: toolName, missing: "query" },
        );
      }
      if (params.maxResults !== undefined) {
        if (typeof params.maxResults !== "number" || params.maxResults <= 0) {
          throw new MCPValidationError(
            "smart_search 'maxResults' must be a positive number",
            "INVALID_PARAMETER_TYPE",
            { tool: toolName, parameter: "maxResults", expected: "positive number" },
          );
        }
      }
      break;

    case "trace":
      if (!params.fromSymbol || typeof params.fromSymbol !== "string") {
        throw new MCPValidationError(
          "trace requires 'fromSymbol' parameter",
          "MISSING_PARAMETER",
          { tool: toolName, missing: "fromSymbol" },
        );
      }
      if (!params.toSymbol || typeof params.toSymbol !== "string") {
        throw new MCPValidationError(
          "trace requires 'toSymbol' parameter",
          "MISSING_PARAMETER",
          { tool: toolName, missing: "toSymbol" },
        );
      }
      if (params.maxDepth !== undefined && typeof params.maxDepth !== "number") {
        throw new MCPValidationError(
          "trace 'maxDepth' must be a number",
          "INVALID_PARAMETER_TYPE",
          { tool: toolName, parameter: "maxDepth", expected: "number" },
        );
      }
      break;

    case "detect_changes": {
      if (params.scope !== undefined) {
        const validScopes = ["unstaged", "staged", "all", "compare"];
        if (typeof params.scope !== "string" || !validScopes.includes(params.scope)) {
          throw new MCPValidationError(
            `detect_changes 'scope' must be one of: ${validScopes.join(", ")}`,
            "INVALID_PARAMETER_VALUE",
            { tool: toolName, parameter: "scope", validValues: validScopes },
          );
        }
        if (params.scope === "compare" && (!params.baseRef || typeof params.baseRef !== "string")) {
          throw new MCPValidationError(
            "detect_changes 'baseRef' is required (string) when scope is 'compare'",
            "MISSING_PARAMETER",
            { tool: toolName, missing: "baseRef" },
          );
        }
      }
      if (params.baseRef !== undefined && typeof params.baseRef !== "string") {
        throw new MCPValidationError(
          "detect_changes 'baseRef' must be a string",
          "INVALID_PARAMETER_TYPE",
          { tool: toolName, parameter: "baseRef", expected: "string" },
        );
      }
      if (params.maxResults !== undefined) {
        if (typeof params.maxResults !== "number" || params.maxResults <= 0) {
          throw new MCPValidationError(
            "detect_changes 'maxResults' must be a positive number",
            "INVALID_PARAMETER_TYPE",
            { tool: toolName, parameter: "maxResults", expected: "positive number" },
          );
        }
      }
      break;
    }

    case "find_dead_code": {
      const validKinds = [
        "function", "class", "method", "interface",
        "variable", "import", "export", "type",
      ];
      if (params.kind !== undefined) {
        if (typeof params.kind !== "string" || !validKinds.includes(params.kind)) {
          throw new MCPValidationError(
            `find_dead_code 'kind' must be one of: ${validKinds.join(", ")}`,
            "INVALID_PARAMETER_VALUE",
            { tool: toolName, parameter: "kind", validValues: validKinds },
          );
        }
      }
      if (params.maxResults !== undefined) {
        if (typeof params.maxResults !== "number" || params.maxResults <= 0) {
          throw new MCPValidationError(
            "find_dead_code 'maxResults' must be a positive number",
            "INVALID_PARAMETER_TYPE",
            { tool: toolName, parameter: "maxResults", expected: "positive number" },
          );
        }
      }
      break;
    }

    case "find_hotspots": {
      for (const key of ["minComplexity", "maxResults", "offset"] as const) {
        if (params[key] !== undefined && typeof params[key] !== "number") {
          throw new MCPValidationError(
            `find_hotspots '${key}' must be a number`,
            "INVALID_PARAMETER_TYPE",
            { tool: toolName, parameter: key, expected: "number" },
          );
        }
      }
      if (params.maxResults !== undefined && (params.maxResults as number) <= 0) {
        throw new MCPValidationError(
          "find_hotspots 'maxResults' must be a positive number",
          "INVALID_PARAMETER_TYPE",
          { tool: toolName, parameter: "maxResults", expected: "positive number" },
        );
      }
      break;
    }

    case "rename": {
      if (!params.symbolName || typeof params.symbolName !== "string") {
        throw new MCPValidationError(
          "rename requires 'symbolName' parameter",
          "MISSING_PARAMETER",
          { tool: toolName, missing: "symbolName" },
        );
      }
      if (!params.newName || typeof params.newName !== "string") {
        throw new MCPValidationError(
          "rename requires 'newName' parameter",
          "MISSING_PARAMETER",
          { tool: toolName, missing: "newName" },
        );
      }
      // Identifier-shape check: a valid JS/TS-style identifier — starts with a
      // letter / _ / $, then letters / digits / _ / $.
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(params.newName)) {
        throw new MCPValidationError(
          "rename 'newName' must be a valid identifier (letters, digits, _ or $; not starting with a digit)",
          "INVALID_PARAMETER_VALUE",
          { tool: toolName, parameter: "newName" },
        );
      }
      if (params.filePath !== undefined && typeof params.filePath !== "string") {
        throw new MCPValidationError(
          "rename 'filePath' must be a string",
          "INVALID_PARAMETER_TYPE",
          { tool: toolName, parameter: "filePath", expected: "string" },
        );
      }
      break;
    }

    case "shape_check":
      // No required params (v1 checks the whole graph; no options).
      break;

    case "api_impact":
      if (!params.route || typeof params.route !== "string") {
        throw new MCPValidationError(
          "api_impact requires a 'route' parameter (route symbol name)",
          "MISSING_PARAMETER",
          { tool: toolName, missing: "route" },
        );
      }
      break;

    default:
      throw new MCPValidationError(
        `Unknown tool: ${toolName}`,
        "UNKNOWN_TOOL",
        { tool: toolName },
      );
  }
}
