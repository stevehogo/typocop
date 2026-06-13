/**
 * MCP protocol types and structures.
 * Requirements: 15.3, 15.4
 */

/**
 * MCP request structure.
 */
export interface MCPRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * MCP response structure.
 */
export interface MCPResponse {
  readonly result: unknown;
  readonly metadata: Record<string, string>;
}

/**
 * MCP error response.
 */
export interface MCPError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Validation error for malformed requests.
 */
export class MCPValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MCPValidationError";
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Authentication error for invalid tokens.
 */
export class MCPAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPAuthenticationError";
    Error.captureStackTrace(this, this.constructor);
  }
}
