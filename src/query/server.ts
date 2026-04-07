/**
 * Query server HTTP API using Fastify.
 * Requirements: 9.1, 9.2, 9.3, 20.1, 20.2, 23.3
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Driver } from "neo4j-driver";
import type { Query, QueryResult, RelationType } from "../types/index.js";
import { executeQuery } from "./execute-query.js";
import { sanitizeQuery } from "../security/sanitize.js";
import { configurationManager, ConfigurationError } from "../config/index.js";

export interface QueryServerConfig {
  readonly port: number;
  readonly host: string;
  readonly vectorPool: Pool;
  readonly graphDriver: Driver;
  readonly prefix?: string;
}

// ─── Prefix helpers ───────────────────────────────────────────────────────────

function stripPrefix(value: string, prefix: string): string {
  if (prefix && value.startsWith(prefix)) {
    return value.slice(prefix.length);
  }
  return value;
}

function stripPrefixFromResult(result: QueryResult, prefix: string): QueryResult {
  if (!prefix) return result;
  return {
    ...result,
    relationships: result.relationships.map(r => ({
      ...r,
      relType: stripPrefix(r.relType, prefix) as RelationType,
    })),
  };
}

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Create and configure the query server.
 * Requirements: 9.2, 9.3
 */
export function createQueryServer(config: QueryServerConfig): FastifyInstance {
  const server = Fastify({
    logger: true,
  });

  // Health check endpoint
  server.get("/health", async () => {
    return { status: "ok" };
  });

  // Query endpoint
  server.post<{
    Body: {
      text: string;
      context?: string;
      maxResults?: number;
    };
  }>("/query", async (request, reply) => {
    const { text, context, maxResults = 50 } = request.body;

    // Validate input
    if (!text || text.trim().length === 0) {
      return reply.code(400).send({
        error: "BadRequest",
        message: "Query text cannot be empty",
      });
    }

    if (maxResults <= 0 || maxResults > 1000) {
      return reply.code(400).send({
        error: "BadRequest",
        message: "maxResults must be between 1 and 1000",
      });
    }

    // Req 9.2: use configured prefix for graph and vector queries
    const prefix = config.prefix ?? configurationManager.getPrefix();
    request.log.debug({ prefix }, "[query-server] Using prefix for query");

    // Sanitize query input (Req 22.3)
    const sanitizedText = sanitizeQuery(text);

    const query: Query = {
      text: sanitizedText,
      context,
      maxResults,
    };

    try {
      const session = config.graphDriver.session();
      try {
        const raw = await executeQuery(query, config.vectorPool, session, prefix);
        // Req 9.3: strip prefix from relationship types and node labels in response
        const result = stripPrefixFromResult(raw, prefix);
        return result;
      } finally {
        await session.close();
      }
    } catch (error) {
      request.log.error(error, "Query execution failed");
      return reply.code(500).send({
        error: "InternalServerError",
        message: "Query execution failed",
      });
    }
  });

  return server;
}

// ─── Server startup ───────────────────────────────────────────────────────────

/**
 * Start the query server.
 * Requirements: 9.1, 9.3
 */
export async function startQueryServer(config: QueryServerConfig): Promise<FastifyInstance> {
  // Req 9.1: initialize ConfigurationManager to read TYPOCOP_PREFIX
  try {
    await configurationManager.initialize();
  } catch (err) {
    if (err instanceof ConfigurationError) {
      throw new Error(`[query-server] Failed to initialize configuration: ${err.message}`);
    }
    throw err;
  }

  const prefix = config.prefix ?? configurationManager.getPrefix();
  console.error(`[query-server] Using prefix: ${prefix}`);

  const server = createQueryServer({ ...config, prefix });

  try {
    await server.listen({
      port: config.port,
      host: config.host,
    });
    console.error(`Query server listening on ${config.host}:${config.port}`);
    return server;
  } catch (err) {
    server.log.error(err);
    throw err;
  }
}
