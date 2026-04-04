/**
 * Query server HTTP API using Fastify.
 * Requirements: 9.3, 20.1, 20.2, 23.3
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Driver } from "neo4j-driver";
import type { Query, QueryResult } from "../types/index.js";
import { executeQuery } from "./execute-query.js";
import { sanitizeQuery } from "../security/sanitize.js";

export interface QueryServerConfig {
  readonly port: number;
  readonly host: string;
  readonly vectorPool: Pool;
  readonly graphDriver: Driver;
}

/**
 * Create and configure the query server.
 * Requirements: 9.3
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
        const result = await executeQuery(query, config.vectorPool, session);
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

/**
 * Start the query server.
 * Requirements: 9.3
 */
export async function startQueryServer(config: QueryServerConfig): Promise<FastifyInstance> {
  const server = createQueryServer(config);

  try {
    await server.listen({
      port: config.port,
      host: config.host,
    });
    console.log(`Query server listening on ${config.host}:${config.port}`);
    return server;
  } catch (err) {
    server.log.error(err);
    throw err;
  }
}
