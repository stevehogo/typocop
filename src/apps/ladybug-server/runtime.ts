import type { Connection, Database } from "@ladybugdb/core";

import { createEmbeddedConnection, type LadybugConnection } from "../../infrastructure/persistence/index.js";
import { LadybugGraphAdapter } from "../../infrastructure/persistence/ladybug-graph-adapter.js";
import { LadybugVectorAdapter } from "../../infrastructure/persistence/ladybug-vector-adapter.js";
import { logServerEvent } from "../../platform/logging/logger.js";

export interface EmbeddedDatabaseRuntime {
  open(dbPath: string, prefix: string): Promise<void>;
  getConnection(): Connection;
  getDatabase(): Database;
  close(): Promise<void>;
  isHealthy(): boolean;
}

export class LadybugEmbeddedDatabaseRuntime implements EmbeddedDatabaseRuntime {
  private runtime: LadybugConnection | null = null;
  private healthy = false;
  private openedDbPath: string | null = null;
  private openedPrefix: string | null = null;

  async open(dbPath: string, prefix: string): Promise<void> {
    if (this.runtime !== null) {
      if (this.openedDbPath !== dbPath || this.openedPrefix !== prefix) {
        throw new Error(
          `EmbeddedDatabaseRuntime is already open for dbPath=${this.openedDbPath} prefix=${this.openedPrefix}`,
        );
      }
      return;
    }

    logServerEvent("info", "database_opening", { dbPath, prefix });
    const connection = await createEmbeddedConnection(dbPath);
    const graphAdapter = new LadybugGraphAdapter(connection.connection, prefix);
    const vectorAdapter = new LadybugVectorAdapter(connection.connection, prefix);

    await graphAdapter.initializeSchema();
    await vectorAdapter.createTables();

    this.runtime = connection;
    this.openedDbPath = dbPath;
    this.openedPrefix = prefix;
    this.healthy = true;
    logServerEvent("info", "database_ready", { dbPath, prefix });
  }

  getConnection(): Connection {
    if (this.runtime === null) {
      throw new Error("EmbeddedDatabaseRuntime is not open");
    }
    return this.runtime.connection;
  }

  getDatabase(): Database {
    if (this.runtime === null) {
      throw new Error("EmbeddedDatabaseRuntime is not open");
    }
    return this.runtime.database;
  }

  async close(): Promise<void> {
    if (this.runtime === null) {
      this.healthy = false;
      return;
    }

    const runtime = this.runtime;
    const dbPath = this.openedDbPath;
    this.healthy = false;

    try {
      logServerEvent("info", "database_closing", { dbPath: dbPath ?? "unknown" });
      await runtime.close();
    } finally {
      this.runtime = null;
      this.openedDbPath = null;
      this.openedPrefix = null;
      logServerEvent("info", "database_closed", { dbPath: dbPath ?? "unknown" });
    }
  }

  isHealthy(): boolean {
    return this.healthy && this.runtime !== null;
  }
}
