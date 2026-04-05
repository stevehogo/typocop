/**
 * Vector store connection and retry logic.
 * Requirements: 17.1, 19.3, 19.4
 */
import { Pool } from "pg";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff — max 3 attempts (Req 19.3, 19.4).
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
 * Create a PostgreSQL connection pool with retry on first query.
 * Throws after 3 failed attempts (Req 19.3, 19.4).
 */
export async function createPool(config: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): Promise<Pool> {
  return withRetry(async () => {
    const pool = new Pool(config);
    // Verify connectivity
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return pool;
  });
}

/**
 * Initialize pgvector extension and create embeddings table with HNSW index.
 * Using 1536 dimensions (text-embedding-3-large reduced) to stay within
 * pgvector's 2000-dimension index limit.
 * Requirements: 17.1, 17.5
 */
export async function initVectorStore(pool: Pool): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS embeddings (
      symbol_id TEXT PRIMARY KEY,
      embedding vector(1536),
      metadata JSONB DEFAULT '{}'
    )
  `);
  // HNSW index for approximate nearest neighbor search (Req 17.5)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx
    ON embeddings USING hnsw (embedding vector_cosine_ops)
  `);
}
