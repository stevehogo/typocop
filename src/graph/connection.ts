/**
 * Graph database types and connection management.
 * Requirements: 16.1, 16.2, 19.1, 19.2
 */
import neo4j, { type Driver, type Session } from "neo4j-driver";

export interface GraphNode {
  readonly id: string;
  readonly labels: string[];
  readonly properties: Record<string, string>;
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly relType: string;
  readonly properties: Record<string, string>;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff — max 3 attempts (Req 19.1, 19.2).
 */
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await sleep(Math.pow(2, attempt) * 100);
    }
  }
  throw new Error("unreachable");
}

/**
 * Create a Neo4j driver with retry on first verify.
 * Throws after 3 failed attempts (Req 19.1, 19.2).
 */
export async function createDriver(uri: string, user: string, password: string): Promise<Driver> {
  return withRetry(async () => {
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      // Neo4j 5 Docker image uses unencrypted Bolt by default.
      // neo4j-driver 6.x defaults to encrypted — disable to match.
      encrypted: false,
    });
    await driver.verifyConnectivity();
    return driver;
  });
}
