/**
 * MCP Server — Model Context Protocol integration.
 * Requirements: 15.1–15.8, 22.5
 */
export { createMCPServer, registerTools, registerPrompts } from "./registration.js";
export { handleMCPRequest, createConnectionState } from "./handler.js";
export type { MCPContext, ConnectionState } from "./handler.js";
export { createAuthConfig, validateAuthToken, extractAuthToken } from "./auth.js";
export type { AuthConfig } from "./auth.js";
export { validateMCPRequest, validateToolParams } from "./validation.js";
export { executeTool } from "./tools.js";
export type { MCPRequest, MCPResponse, MCPError } from "./types.js";
export { MCPValidationError, MCPAuthenticationError } from "./types.js";
export { startMCPServer } from "./server.js";
