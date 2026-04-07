/**
 * Vector store semantic search operations.
 * Requirements: 17.2, 17.3, 17.4, 20.4
 */
import type { Pool } from "pg";
import type { SearchResult, Embedding } from "../types/index.js";
import { SEMANTIC_SEARCH_THRESHOLD } from "../utils/limits.js";

/**
 * Perform semantic similarity search using cosine distance.
 * Returns results ordered by descending similarity score (1 - distance).
 * Only results with score >= SEMANTIC_SEARCH_THRESHOLD (0.70) are returned.
 * Target: <100ms (Req 17.2, 20.4).
 * Requirements: 17.2, 17.3, 17.4, 2.4
 */
export async function semanticSearch(
  pool: Pool,
  queryEmbedding: Embedding,
  limit: number,
  prefix: string,
): Promise<SearchResult[]> {
  const table = `${prefix}embeddings`;
  
  // Log to console for debugging (more reliable than file I/O)
  const logMsg = `[semanticSearch] Querying table: ${table}, prefix: ${prefix}, limit: ${limit}, threshold: ${SEMANTIC_SEARCH_THRESHOLD}, embedding dims: ${queryEmbedding.vector.length}`;
  console.error(logMsg);
  
  const result = await pool.query(
    `SELECT
       symbol_id,
       1 - (embedding <=> $1::vector) AS score,
       metadata
     FROM ${table}
     WHERE 1 - (embedding <=> $1::vector) >= $3
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [JSON.stringify(queryEmbedding.vector), limit, SEMANTIC_SEARCH_THRESHOLD],
  );

  const resultMsg = `[semanticSearch] Found ${result.rows.length} results from table ${table}`;
  console.error(resultMsg);
  
  return result.rows.map((row) => ({
    symbolId: row.symbol_id as string,
    score: parseFloat(row.score as string),
    metadata: (row.metadata as Record<string, string>) ?? {},
  }));
}
