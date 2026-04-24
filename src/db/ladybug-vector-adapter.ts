/**
 * LadybugVectorAdapter — VectorAdapter implementation backed by LadybugDB's
 * SQL interface for embedding storage and ANN semantic search.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */

import type { Connection, LbugValue } from "@ladybugdb/core";
import type { VectorAdapter } from "./types.js";
import type { Embedding, SearchResult } from "../types/index.js";

/** Minimum cosine similarity score for search results. Requirement 3.4 */
export const SEMANTIC_SEARCH_THRESHOLD = 0.60;

/**
 * Implements `VectorAdapter` using LadybugDB's Connection.query() SQL interface.
 * Table names are prefix-aware for per-project isolation.
 */
export class LadybugVectorAdapter implements VectorAdapter {
  private readonly tableName: string;

  constructor(
    private readonly connection: Connection,
    private readonly prefix: string,
  ) {
    this.tableName = `${prefix}embeddings`;
  }

  /** Execute a SQL query and return all rows. */
  private async sql(query: string): Promise<Record<string, LbugValue>[]> {
    const result = await this.connection.query(query);
    if (Array.isArray(result)) {
      return result[0] ? await result[0].getAll() : [];
    }
    return result.getAll();
  }

  async createTables(): Promise<void> {
    await this.sql(
      `CREATE NODE TABLE IF NOT EXISTS ${this.tableName} (
        symbol_id STRING PRIMARY KEY,
        embedding DOUBLE[],
        dimensions INT64,
        metadata STRING DEFAULT '{}'
      )`,
    );
  }

  async indexSymbol(
    symbolId: string,
    embedding: Embedding,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    const vecStr = toDoubleArrayLiteral(embedding.vector);
    const metaStr = JSON.stringify(JSON.stringify(metadata));
    await this.sql(
      `MERGE (n:${this.tableName} {symbol_id: "${symbolId}"})
       SET n.embedding = ${vecStr}, n.dimensions = ${embedding.dimensions}, n.metadata = ${metaStr}`,
    );
  }

  async semanticSearch(
    queryEmbedding: Embedding,
    limit: number,
  ): Promise<SearchResult[]> {
    // Use Cypher-based cosine similarity computation
    const vecStr = toDoubleArrayLiteral(queryEmbedding.vector);
    const rows = await this.sql(
      `MATCH (n:${this.tableName})
       WHERE n.embedding IS NOT NULL
       WITH n, n.symbol_id AS symbol_id, n.metadata AS metadata,
            array_cosine_similarity(n.embedding, ${vecStr}) AS score
       WHERE score >= ${SEMANTIC_SEARCH_THRESHOLD}
       RETURN symbol_id, score, metadata
       ORDER BY score DESC
       LIMIT ${limit}`,
    );

    return rows.map((row) => ({
      symbolId: String(row["symbol_id"] ?? ""),
      score: Number(row["score"] ?? 0),
      metadata: typeof row["metadata"] === "string"
        ? (JSON.parse(row["metadata"]) as Record<string, string>)
        : ({} as Record<string, string>),
    }));
  }

  async deleteAll(): Promise<number> {
    const countRows = await this.sql(
      `MATCH (n:${this.tableName}) RETURN count(n) as count`,
    );
    const count = Number(countRows[0]?.count ?? 0);
    await this.sql(`MATCH (n:${this.tableName}) DETACH DELETE n`);
    return count;
  }
}

function toDoubleArrayLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => (
    Number.isInteger(value) ? value.toFixed(1) : String(value)
  )).join(",")}]`;
}
