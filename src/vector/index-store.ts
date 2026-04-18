/**
 * Vector store indexing operations.
 * Requirements: 17.1, 17.5
 */
import type { Pool } from "pg";
import type { Embedding } from "../types/index.js";

/**
 * Store a symbol embedding in pgvector.
 * Uses UPSERT to handle re-indexing.
 * Requirements: 17.1, 2.5
 */
export async function indexSymbol(
  pool: Pool,
  symbolId: string,
  embedding: Embedding,
  metadata: Record<string, string> = {},
  prefix: string,
): Promise<void> {
  const table = `${prefix}embeddings`;
  await pool.query(
    `INSERT INTO ${table} (symbol_id, embedding, metadata)
     VALUES ($1, $2, $3)
     ON CONFLICT (symbol_id) DO UPDATE
     SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`,
    [symbolId, JSON.stringify(embedding.vector), JSON.stringify(metadata)],
  );
}

/**
 * Clear all embeddings for a given prefix from pgvector table.
 * Deletes all rows where symbol_id starts with the prefix.
 * Idempotent: safe to call multiple times.
 * Requirements: 3.7, 17.5
 */
export async function clearVectorData(pool: Pool, prefix: string): Promise<number> {
  const client = await pool.connect();
  try {
    // Delete all embeddings for the prefix
    const result = await client.query(
      `DELETE FROM ${prefix}embeddings`
    );

    const deleteCount = result.rowCount ?? 0;

    // Log deletion count
    console.error(`[clearVectorData] Deleted ${deleteCount} embeddings with prefix "${prefix}"`);
    
    return deleteCount;
  } catch (err) {
    // Handle errors gracefully and propagate
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[clearVectorData] Error clearing vector data for prefix "${prefix}": ${message}`);
    throw err;
  } finally {
    // Properly release database connection
    client.release();
  }
}
