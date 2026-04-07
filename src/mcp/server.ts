/**
 * MCP server main entry point — connects to query server via HTTP.
 * Requirements: 15.5, 15.7, 17.1, 17.2, 17.3
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createMCPServer } from "./registration.js";
import { executeTool } from "./tools.js";
import { SessionManager } from "./session-manager.js";
import { createDriver } from "../graph/connection.js";
import { createPool } from "../vector/connection.js";
import { configurationManager, ConfigurationError, PrefixValidationError } from "../config/index.js";
import type { MCPToolResponse } from "../types/index.js";

/**
 * Get database configuration from environment variables.
 */
function getDatabaseConfig(): {
  neo4j: { uri: string; user: string; password: string };
  postgres: { host: string; port: number; database: string; user: string; password: string };
} {
  const neo4jUri = process.env.NEO4J_URI || "bolt://localhost:8687";
  const neo4jUser = process.env.NEO4J_USER || "neo4j";
  const neo4jPassword = process.env.NEO4J_PASSWORD || "password";

  const pgHost = process.env.POSTGRES_HOST || "localhost";
  const pgPort = parseInt(process.env.POSTGRES_PORT || "5432", 10);
  const pgDatabase = process.env.POSTGRES_DB || "typocop";
  const pgUser = process.env.POSTGRES_USER || "postgres";
  const pgPassword = process.env.POSTGRES_PASSWORD || "password";

  return {
    neo4j: { uri: neo4jUri, user: neo4jUser, password: neo4jPassword },
    postgres: { host: pgHost, port: pgPort, database: pgDatabase, user: pgUser, password: pgPassword },
  };
}

/**
 * Strip the configured prefix from relationship types in an MCP tool response.
 * Req 17.2: Strip prefix from node labels and relationship types in the response.
 */
function stripPrefixFromMCPResponse(response: MCPToolResponse, prefix: string): MCPToolResponse {
  if (!prefix) return response;

  return {
    ...response,
    symbols: response.symbols.map((s) => ({
      ...s,
      relationship: s.relationship.startsWith(prefix)
        ? s.relationship.slice(prefix.length)
        : s.relationship,
    })),
  };
}

/**
 * Start the MCP server with database connections.
 * Requirements: 15.5, 15.7, 17.1, 17.2, 17.3
 */
export async function startMCPServer(): Promise<void> {
  // Req 17.1, 18.1: Initialize configuration before database connections
  try {
    await configurationManager.initialize();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      if (error instanceof PrefixValidationError) {
        const lines = [
          `[mcp] Error: Invalid TYPOCOP_PREFIX value "${error.prefix}"`,
          `[mcp] Reason: ${error.reason}`,
        ];
        if (error.suggestion) {
          lines.push(`[mcp] Suggestion: ${error.suggestion}`);
        }
        console.error(lines.join("\n"));
      } else {
        console.error(`[mcp] Error: ${error.message}`);
      }
      process.exit(1);
    }
    throw error;
  }

  const prefix = configurationManager.getPrefix();
  console.error(`[mcp] Using prefix: ${prefix}`);

  const config = getDatabaseConfig();

  // Create database connections
  const driver = await createDriver(config.neo4j.uri, config.neo4j.user, config.neo4j.password);
  const pool = await createPool(config.postgres);

  // Session manager serializes Neo4j session access and cleans up on disconnect
  const sessionManager = new SessionManager();

  // Create MCP server
  const server = createMCPServer();

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      // Req 17.1: Use the configured prefix for all database queries (via singleton)
      const result = await executeTool(
        request.params.name,
        request.params.arguments || {},
        pool,
        driver,
        sessionManager,
        prefix,
      );

      // Req 17.2: Strip prefix from response before returning
      const stripped = stripPrefixFromMCPResponse(result, prefix);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(stripped, null, 2),
          },
        ],
      };
    } catch (error) {
      // Req 17.3: Return descriptive error for ConfigurationError
      if (error instanceof ConfigurationError) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "ConfigurationError",
                message: error.message,
                prefix: error.prefix,
                reason: error.reason,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          },
        ],
        isError: true,
      };
    }
  });

  // Start server with stdio transport
  const transport = new StdioServerTransport();

  // Close all tracked sessions when the transport disconnects to prevent
  // zombie transactions on the next reconnect. (Requirements: 2.2, 2.3, 2.4)
  transport.onclose = async () => {
    await sessionManager.closeAll();
  };

  await server.connect(transport);

  console.error("MCP server started");
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startMCPServer().catch((error) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  });
}
