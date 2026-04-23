/**
 * LadybugDatabaseAdapter — DatabaseAdapter facade wiring LadybugDB connection
 * to graph, vector, and embedding adapters.
 *
 * Requirements: 1.1, 4.5, 5.1, 6.1, 6.2, 6.3, 6.4
 */

import type { FullConfig } from "../config/types.js";
import type {
  DatabaseAdapter,
  EmbeddingAdapter,
  GraphAdapter,
  VectorAdapter,
} from "./types.js";
import type { PooledConnection } from "./pool-types.js";
import type { ConnectionPool } from "./connection-pool.js";
import { getPool } from "./pool-registry.js";
import { LadybugGraphAdapter } from "./ladybug-graph-adapter.js";
import { LadybugVectorAdapter } from "./ladybug-vector-adapter.js";
import { HuggingFaceEmbeddingAdapter } from "./huggingface-embedding-adapter.js";
import { OllamaEmbeddingAdapter } from "./ollama-embedding-adapter.js";
import { NoOpEmbeddingAdapter } from "./noop-embedding-adapter.js";

/**
 * Facade combining graph, vector, and embedding adapters over a single
 * LadybugDB connection. Must be initialized before use.
 *
 * - Req 1.1: Implements `DatabaseAdapter` interface
 * - Req 8.1: Acquires connections from pool via `getPool()`
 * - Req 6.3: `close()` releases connection back to pool
 * - Req 6.1–6.4: Selects embedding adapter via provider-based switch
 *   (`huggingface` | `ollama` | `none`)
 */
export class LadybugDatabaseAdapter implements DatabaseAdapter {
  private pool: ConnectionPool | null = null;
  private activeConn: PooledConnection | null = null;
  private graphAdapter: GraphAdapter | null = null;
  private vectorAdapter: VectorAdapter | null = null;
  private embeddingAdapter: EmbeddingAdapter | null = null;

  constructor(private readonly config: FullConfig) {}

  async initialize(): Promise<void> {
    this.pool = await getPool(this.config.ladybugdb.dbPath);
    this.activeConn = await this.pool.acquire();

    const graphAdapter = new LadybugGraphAdapter(
      this.activeConn.connection,
      this.config.prefix,
    );

    await graphAdapter.initializeSchema();
    this.graphAdapter = graphAdapter;

    this.vectorAdapter = new LadybugVectorAdapter(
      this.activeConn.connection,
      this.config.prefix,
    );

    // Req 6.1–6.4: Select embedding adapter based on configured provider
    switch (this.config.embedding.provider) {
      case "huggingface":
        this.embeddingAdapter = new HuggingFaceEmbeddingAdapter(this.config.embedding.huggingface);
        break;
      case "ollama":
        this.embeddingAdapter = new OllamaEmbeddingAdapter(this.config.ollama);
        break;
      case "none":
        this.embeddingAdapter = new NoOpEmbeddingAdapter();
        break;
    }

    await this.vectorAdapter.createTables();
  }

  async close(): Promise<void> {
    if (this.activeConn && this.pool) {
      await this.pool.release(this.activeConn);
      this.activeConn = null;
    }
  }

  getGraphAdapter(): GraphAdapter {
    if (!this.graphAdapter) {
      throw new Error("DatabaseAdapter not initialized — call initialize() first");
    }
    return this.graphAdapter;
  }

  getVectorAdapter(): VectorAdapter {
    if (!this.vectorAdapter) {
      throw new Error("DatabaseAdapter not initialized — call initialize() first");
    }
    return this.vectorAdapter;
  }

  getEmbeddingAdapter(): EmbeddingAdapter {
    if (!this.embeddingAdapter) {
      throw new Error("DatabaseAdapter not initialized — call initialize() first");
    }
    return this.embeddingAdapter;
  }
}

/**
 * Factory: creates and initializes a `DatabaseAdapter` from config.
 * Selects the embedding adapter based on `config.embedding.provider`:
 * - `"huggingface"` → HuggingFaceEmbeddingAdapter (Req 6.1)
 * - `"ollama"` → OllamaEmbeddingAdapter (Req 6.2)
 * - `"none"` → NoOpEmbeddingAdapter (Req 6.3)
 */
export async function createDatabaseAdapter(
  config: FullConfig,
): Promise<DatabaseAdapter> {
  const adapter = new LadybugDatabaseAdapter(config);
  await adapter.initialize();
  return adapter;
}
