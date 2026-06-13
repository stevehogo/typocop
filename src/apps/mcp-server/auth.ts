/**
 * MCP authentication.
 * Requirements: 22.5
 */
import { MCPAuthenticationError } from "./types.js";

/**
 * Authentication configuration.
 */
export interface AuthConfig {
  readonly tokens: Set<string>;
  readonly enabled: boolean;
}

/**
 * Create authentication configuration.
 * 
 * @param tokens - Valid authentication tokens
 * @param enabled - Whether authentication is enabled (default: true)
 */
export function createAuthConfig(tokens: string[], enabled = true): AuthConfig {
  return {
    tokens: new Set(tokens),
    enabled,
  };
}

/**
 * Validate authentication token.
 * Requirements: 22.5
 * 
 * @throws {MCPAuthenticationError} If token is invalid or missing
 */
export function validateAuthToken(token: string | undefined, config: AuthConfig): void {
  if (!config.enabled) {
    return; // Authentication disabled
  }

  if (!token) {
    throw new MCPAuthenticationError("Authentication token required");
  }

  if (!config.tokens.has(token)) {
    throw new MCPAuthenticationError("Invalid authentication token");
  }
}

/**
 * Extract authentication token from request headers or params.
 */
export function extractAuthToken(
  headers?: Record<string, string>,
  params?: Record<string, unknown>,
): string | undefined {
  // Check Authorization header first
  if (headers?.["authorization"]) {
    const auth = headers["authorization"];
    if (auth.startsWith("Bearer ")) {
      return auth.substring(7);
    }
    return auth;
  }

  // Check params as fallback
  if (params?.["token"] && typeof params["token"] === "string") {
    return params["token"];
  }

  return undefined;
}
