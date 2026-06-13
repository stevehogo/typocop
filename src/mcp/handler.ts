/**
 * MCP request handler.
 * Requirements: 15.3, 15.4, 15.5, 15.7, 7.1
 */
import type { DatabaseAdapter } from "../core/ports/persistence.js";
import type { MCPRequest, MCPResponse, MCPError } from "./types.js";
import type { AuthConfig } from "./auth.js";
import { MCPValidationError, MCPAuthenticationError } from "./types.js";
import { validateMCPRequest, validateToolParams } from "./validation.js";
import { validateAuthToken, extractAuthToken } from "./auth.js";
import { executeTool } from "./tools.js";

/**
 * Connection state for MCP server.
 */
export interface ConnectionState {
  readonly sessionId: string;
  readonly connectedAt: Date;
  authenticated: boolean;
}

/**
 * MCP server context — uses DatabaseAdapter instead of Pool + Driver (Req 7.1).
 */
export interface MCPContext {
  readonly adapter: DatabaseAdapter;
  readonly authConfig: AuthConfig;
  readonly connectionStates: Map<string, ConnectionState>;
}

/**
 * Create a new connection state.
 */
export function createConnectionState(sessionId: string): ConnectionState {
  return {
    sessionId,
    connectedAt: new Date(),
    authenticated: false,
  };
}

/**
 * Handle MCP request with validation and error handling.
 * Requirements: 15.3, 15.4, 15.5, 15.7, 22.5, 7.1
 */
export async function handleMCPRequest(
  request: unknown,
  context: MCPContext,
  sessionId: string,
  headers?: Record<string, string>,
): Promise<MCPResponse | MCPError> {
  try {
    // Validate request format
    validateMCPRequest(request);

    // Get or create connection state
    let state = context.connectionStates.get(sessionId);
    if (!state) {
      state = createConnectionState(sessionId);
      context.connectionStates.set(sessionId, state);
    }

    // Validate authentication
    const token = extractAuthToken(headers, request.params);
    validateAuthToken(token, context.authConfig);
    state.authenticated = true;

    // Validate tool-specific parameters
    validateToolParams(request.method, request.params);

    // Execute the tool via DatabaseAdapter
    const result = await executeTool(
      request.method,
      request.params,
      context.adapter,
    );

    return {
      result,
      metadata: {
        sessionId,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    if (error instanceof MCPValidationError) {
      return {
        code: error.code,
        message: error.message,
        details: error.details,
      };
    }

    if (error instanceof MCPAuthenticationError) {
      return {
        code: "AUTHENTICATION_FAILED",
        message: error.message,
      };
    }

    // Unknown error
    return {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}
