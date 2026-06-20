/**
 * LadybugVectorAdapter — VectorAdapter implementation backed by LadybugDB's
 * SQL interface for embedding storage and ANN semantic search.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */

import type { Connection, LbugValue } from "@ladybugdb/core";
import type { VectorAdapter } from "../../core/ports/persistence.js";
import type { Embedding, SearchResult } from "../../core/domain.js";

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

  /** Execute a parameterized query using prepare + execute. */
  private async sqlWithParams(
    query: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, LbugValue>[]> {
    const ps = await this.connection.prepare(query);
    if (!ps.isSuccess()) {
      throw new Error(`Query preparation failed: ${ps.getErrorMessage()}`);
    }
    const result = await this.connection.execute(ps, params as Record<string, LbugValue>);
    if (Array.isArray(result)) {
      return result[0] ? await result[0].getAll() : [];
    }
    return result.getAll();
  }

  async createTables(): Promise<void> {
    // `file_path` (A4) is an indexable column written from `metadata.filePath`,
    // enabling clean per-file vector deletes (deleteByFilePaths) without a slow
    // JSON_EXTRACT scan over the `metadata` blob.
    await this.sql(
      `CREATE NODE TABLE IF NOT EXISTS ${this.tableName} (
        symbol_id STRING PRIMARY KEY,
        embedding DOUBLE[],
        dimensions INT64,
        metadata STRING DEFAULT '{}',
        file_path STRING DEFAULT ''
      )`,
    );
    // In-place migration: embeddings tables created before A4 lack the
    // indexable file_path column; add it if missing (idempotent).
    await this.addColumnIfMissing("file_path", "STRING");
  }

  /**
   * Add a column to the embeddings table if absent — in-place schema migration
   * for DBs created by an older typocop. Idempotent: "already exists" is
   * swallowed; anything else rethrows.
   */
  private async addColumnIfMissing(column: string, type: string): Promise<void> {
    try {
      await this.sql(`ALTER TABLE ${this.tableName} ADD ${column} ${type}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // LadybugDB/Kùzu reports a duplicate column as "<table> table already has
      // property <col>." (older builds: "... already exists").
      if (!/already exists|already has property/i.test(msg)) throw error;
    }
  }

  async indexSymbol(
    symbolId: string,
    embedding: Embedding,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    const vecStr = toDoubleArrayLiteral(embedding.vector);
    const metaStr = JSON.stringify(JSON.stringify(metadata));
    // A4: mirror metadata.filePath into the indexable file_path column.
    const filePathStr = JSON.stringify(metadata.filePath ?? "");
    await this.sql(
      `MERGE (n:${this.tableName} {symbol_id: "${symbolId}"})
       SET n.embedding = ${vecStr}, n.dimensions = ${embedding.dimensions}, n.metadata = ${metaStr}, n.file_path = ${filePathStr}`,
    );
  }

  /**
   * Batch fast-path: index many embeddings in ONE parameterized query.
   * `entries` is a bounded chunk (pipeline-chunked) — not re-chunked here.
   *
   * Metadata round-trip: the per-row {@link indexSymbol} stores the metadata
   * column as a JSON string (the result of `JSON.stringify(metadata)`) — it
   * builds a Cypher string literal via `JSON.stringify(JSON.stringify(metadata))`
   * so the value actually stored is the single-encoded JSON. Here we bind
   * `JSON.stringify(metadata)` directly as a string parameter, producing the
   * IDENTICAL stored representation, so `semanticSearch`'s `JSON.parse(metadata)`
   * round-trips the same on either write path.
   */
  async indexSymbols(
    entries: ReadonlyArray<{
      readonly symbolId: string;
      readonly embedding: Embedding;
      readonly metadata?: Record<string, string>;
    }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const rows = entries.map((entry) => ({
      symbol_id: entry.symbolId,
      embedding: [...entry.embedding.vector],
      dimensions: entry.embedding.dimensions,
      metadata: JSON.stringify(entry.metadata ?? {}),
      // A4: mirror metadata.filePath into the indexable file_path column,
      // identical to the per-row indexSymbol path.
      file_path: entry.metadata?.filePath ?? "",
    }));
    await this.sqlWithParams(
      `UNWIND $rows AS row MERGE (n:${this.tableName} {symbol_id: row.symbol_id})
       SET n.embedding = row.embedding, n.dimensions = row.dimensions, n.metadata = row.metadata, n.file_path = row.file_path`,
      { rows },
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

  /**
   * A4 diff-write: delete every embedding row whose stored `file_path` is in
   * `paths`, returning the count deleted. Parameterized (`$paths`) so the
   * delete matches on the indexable column rather than scanning the metadata
   * JSON blob. An empty `paths` is a no-op (nothing matches `IN []`).
   */
  async deleteByFilePaths(paths: readonly string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const pathList = [...paths];
    const countRows = await this.sqlWithParams(
      `MATCH (n:${this.tableName}) WHERE n.file_path IN $paths RETURN count(n) as count`,
      { paths: pathList },
    );
    const count = Number(countRows[0]?.count ?? 0);
    await this.sqlWithParams(
      `MATCH (n:${this.tableName}) WHERE n.file_path IN $paths DETACH DELETE n`,
      { paths: pathList },
    );
    return count;
  }
}

function toDoubleArrayLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => (
    Number.isInteger(value) ? value.toFixed(1) : String(value)
  )).join(",")}]`;
}
