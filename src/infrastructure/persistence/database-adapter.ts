/**
 * LadybugDatabaseAdapter — DatabaseAdapter facade wiring LadybugDB connection
 * to graph, vector, and embedding adapters.
 *
 * Requirements: 1.1, 4.5, 5.1, 6.1, 6.2, 6.3, 6.4
 */

import type { FullConfig } from "../../platform/config/types.js";
import type { LadybugClientConfig, LadybugRuntimeMode } from "../../platform/config/types.js";
import type {
  DatabaseAdapter,
  EmbeddingAdapter,
  GraphAdapter,
  VectorAdapter,
} from "../../core/ports/persistence.js";
import type { PooledConnection } from "./pool-types.js";
import type { ConnectionPool } from "./connection-pool.js";
import { getPool } from "./pool-registry.js";
import { LadybugGraphAdapter } from "./ladybug-graph-adapter.js";
import { LadybugVectorAdapter } from "./ladybug-vector-adapter.js";

/**
 * Facade combining graph, vector, and embedding adapters over a single
 * LadybugDB connection. Must be initialized before use.
 *
 * - Req 1.1: Implements `DatabaseAdapter` interface
 * - Req 8.1: Acquires connections from pool via `getPool()`
 * - Req 6.3: `close()` releases connection back to pool
 * - Req 6.1–6.4: The embedding adapter is **injected** (provider selection
 *   happens at the composition root via `createEmbeddingAdapter`), so this
 *   facade never imports a concrete embeddings adapter (§14).
 */
export class LadybugDatabaseAdapter implements DatabaseAdapter {
  private pool: ConnectionPool | null = null;
  private activeConn: PooledConnection | null = null;
  private graphAdapter: GraphAdapter | null = null;
  private vectorAdapter: VectorAdapter | null = null;
  private embeddingAdapter: EmbeddingAdapter | null = null;

  constructor(
    private readonly config: FullConfig,
    private readonly embedding: EmbeddingAdapter,
  ) {}

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

    this.embeddingAdapter = this.embedding;

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
 *
 * The `embeddingAdapter` is injected by the caller (composition root), which
 * selects the provider via `createEmbeddingAdapter`. This factory — and the
 * adapters it builds — never reference concrete embeddings (§14). The same
 * instance is used for both the embedded and the remote (client) runtime.
 */
export async function createDatabaseAdapter(
  config: FullConfig,
  embeddingAdapter: EmbeddingAdapter,
): Promise<DatabaseAdapter> {
  validateAdapterFactoryConfig(config);

  if (config.ladybugdb.runtimeMode === "client") {
    const { ensureServerAndConnect } = await import("../remote-transport/autostart.js");
    return ensureServerAndConnect(toLadybugClientConfig(config), { embeddingAdapter });
  }

  const adapter = new LadybugDatabaseAdapter(config, embeddingAdapter);
  await adapter.initialize();
  return adapter;
}

export function toLadybugClientConfig(config: FullConfig): LadybugClientConfig {
  return {
    runtimeMode: "client",
    prefix: config.prefix,
    dbPath: config.ladybugdb.dbPath,
    serverUrl: config.ladybugdb.serverUrl,
    authToken: config.ladybugdb.serverAuthToken,
    autostart: config.ladybugdb.serverAutostart,
    startupTimeoutMs: config.ladybugdb.serverStartupTimeoutMs,
    lockPath: config.ladybugdb.serverLockPath,
    discoveryPath: config.ladybugdb.serverDiscoveryPath,
  };
}

function validateAdapterFactoryConfig(config: FullConfig): void {
  requireNonEmpty(config.prefix, "prefix");
  requireNonEmpty(config.ladybugdb.dbPath, "ladybugdb.dbPath");
  validateRuntimeMode(config.ladybugdb.runtimeMode);
  requireNonEmpty(config.ladybugdb.serverHost, "ladybugdb.serverHost");
  validateIntegerRange(config.ladybugdb.serverPort, "ladybugdb.serverPort", 1, 65_535);
  validateMinimum(config.ladybugdb.serverMaxConcurrency, "ladybugdb.serverMaxConcurrency", 1);
  validateMinimum(config.ladybugdb.serverMaxQueue, "ladybugdb.serverMaxQueue", 1);
  validateMinimum(config.ladybugdb.serverStartupTimeoutMs, "ladybugdb.serverStartupTimeoutMs", 1);
  validateMinimum(config.ladybugdb.serverIdleTtlMs, "ladybugdb.serverIdleTtlMs", 0);
  requireNonEmpty(config.ladybugdb.serverLockPath, "ladybugdb.serverLockPath");
  requireNonEmpty(config.ladybugdb.serverDiscoveryPath, "ladybugdb.serverDiscoveryPath");

  if (config.ladybugdb.runtimeMode === "client") {
    validateGrpcUrl(config.ladybugdb.serverUrl);
  }
}

function validateRuntimeMode(runtimeMode: LadybugRuntimeMode): void {
  if (runtimeMode !== "server" && runtimeMode !== "client") {
    throw new Error(`ladybugdb.runtimeMode must be "server" or "client", received ${runtimeMode}`);
  }
}

function validateGrpcUrl(serverUrl: string): void {
  requireNonEmpty(serverUrl, "ladybugdb.serverUrl");
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error(`ladybugdb.serverUrl must be a valid grpc:// URL, received ${serverUrl}`);
  }
  if (parsed.protocol !== "grpc:" || parsed.host === "") {
    throw new Error(`ladybugdb.serverUrl must be a valid grpc:// URL, received ${serverUrl}`);
  }
}

function validateIntegerRange(value: number, field: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}, received ${value}`);
  }
}

function validateMinimum(value: number, field: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${field} must be an integer >= ${min}, received ${value}`);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new Error(`${field} is required`);
  }
}
