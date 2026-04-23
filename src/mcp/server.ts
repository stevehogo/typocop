/**
 * MCP server main entry point — uses DatabaseAdapter for all database access.
 * Requirements: 15.5, 15.7, 17.1, 17.2, 17.3, 7.1
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createMCPServer } from "./registration.js";
import { executeTool } from "./tools.js";
import { createDatabaseAdapter } from "../db/database-adapter.js";
import { drainAllPools } from "../db/pool-registry.js";
import { configurationManager, ConfigurationError, PrefixValidationError } from "../config/index.js";
import type { MCPToolResponse } from "../types/index.js";
import type { DatabaseAdapter } from "../db/types.js";

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
 * Start the MCP server with DatabaseAdapter.
 * Requirements: 15.5, 15.7, 17.1, 17.2, 17.3, 7.1
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
  const config = configurationManager.getConfiguration();
  console.error(`[mcp] Using prefix: ${prefix}`);

  // Create DatabaseAdapter from FullConfig (Req 7.1)
  const adapter: DatabaseAdapter = await createDatabaseAdapter(config);

  // Create MCP server
  const server = createMCPServer();

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      // Req 17.1: Use the configured prefix for all database queries (via singleton)
      const result = await executeTool(
        request.params.name,
        request.params.arguments || {},
        adapter,
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

  // Drain all pools when the transport disconnects (Req 11.1)
  transport.onclose = async () => {
    await drainAllPools();
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
