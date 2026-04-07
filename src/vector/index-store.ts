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
