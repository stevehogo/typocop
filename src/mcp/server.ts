/**
 * MCP server main entry point — connects to query server via HTTP.
 * Requirements: 15.5, 15.7
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createMCPServer, registerTools, registerPrompts } from "./registration.js";
import { executeTool } from "./tools.js";
import { SessionManager } from "./session-manager.js";
import { createDriver, type Driver } from "../graph/connection.js";
import { createPool } from "../vector/connection.js";

/**
 * Get database configuration from environment variables.
 */
function getDatabaseConfig() {
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
 * Start the MCP server with database connections.
 * Requirements: 15.5, 15.7
 */
export async function startMCPServer(): Promise<void> {
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
      const result = await executeTool(
        request.params.name,
        request.params.arguments || {},
        pool,
        driver,
        sessionManager,
      );
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
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
    } finally {
      // sessions are managed per-query inside each tool function
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
