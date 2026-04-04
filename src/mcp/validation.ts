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

    default:
      throw new MCPValidationError(
        `Unknown tool: ${toolName}`,
        "UNKNOWN_TOOL",
        { tool: toolName },
      );
  }
}
