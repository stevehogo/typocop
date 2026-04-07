/**
 * VectorStore class — prefix-aware PostgreSQL vector store.
 * Requirements: 3.1–3.6 (PostgreSQL Table Prefix Implementation)
 */
import type { Pool } from "pg";
import type { Embedding, SearchResult } from "../types/index.js";

type BaseTableName = "embeddings" | "metadata";

/**
 * Wraps all vector store operations with a configurable schema prefix.
 * Empty prefix uses base table names unchanged.
 */
export class VectorStore {
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
    console.debug(`[vector-store] Initialized with prefix: "${prefix}"`);
  }

  /** Returns the prefixed table name, e.g. 'tpc_embeddings'. */
  getTableName(baseName: BaseTableName): string {
    return `${this.prefix}${baseName}`;
  }

  /**
   * Create pgvector extension and prefixed embeddings table with HNSW index.
   * Requirements: 3.4, 3.6
   */
  async createTables(pool: Pool): Promise<void> {
    const table = this.getTableName("embeddings");
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        symbol_id TEXT PRIMARY KEY,
        embedding vector(1536),
        metadata JSONB DEFAULT '{}'
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${table}_hnsw
      ON ${table} USING hnsw (embedding vector_cosine_ops)
    `);
  }

  /**
   * Store a symbol embedding using UPSERT.
   * Requirements: 3.5
   */
  async indexSymbol(
    pool: Pool,
    symbolId: string,
    embedding: Embedding,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    const table = this.getTableName("embeddings");
    await pool.query(
      `INSERT INTO ${table} (symbol_id, embedding, metadata)
       VALUES ($1, $2, $3)
       ON CONFLICT (symbol_id) DO UPDATE
       SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`,
      [symbolId, JSON.stringify(embedding.vector), JSON.stringify(metadata)],
    );
  }

  /**
   * Semantic similarity search using cosine distance.
   * Requirements: 3.5
   */
  async semanticSearch(
    pool: Pool,
    queryEmbedding: Embedding,
    limit: number,
  ): Promise<SearchResult[]> {
    const table = this.getTableName("embeddings");
    const result = await pool.query(
      `SELECT
         symbol_id,
         1 - (embedding <=> $1::vector) AS score,
         metadata
       FROM ${table}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [JSON.stringify(queryEmbedding.vector), limit],
    );

    return result.rows.map((row) => ({
      symbolId: row.symbol_id as string,
      score: parseFloat(row.score as string),
      metadata: (row.metadata as Record<string, string>) ?? {},
    }));
  }
}
