import { join } from "node:path";

import type { FullConfig, LadybugClientConfig, LadybugServerConfig } from "../platform/config/types.js";
import { createDatabaseAdapter } from "../db/database-adapter.js";
import type { RemoteDatabaseAdapter } from "../db/remote-database-adapter.js";

export function makeServerConfig(root: string, overrides: Partial<LadybugServerConfig> = {}): LadybugServerConfig {
  return {
    runtimeMode: "server",
    prefix: "tpc_",
    dbPath: join(root, "db.ladybug"),
    host: "127.0.0.1",
    port: 7617,
    authToken: "",
    maxConcurrency: 4,
    maxQueue: 32,
    idleTtlMs: 0,
    discoveryPath: join(root, "ladybug-server.json"),
    ...overrides,
  };
}

export function makeClientConfig(server: LadybugServerConfig, overrides: Partial<LadybugClientConfig> = {}): LadybugClientConfig {
  return {
    runtimeMode: "client",
    prefix: server.prefix,
    dbPath: server.dbPath,
    serverUrl: `grpc://${server.host}:${server.port}`,
    authToken: server.authToken,
    autostart: false,
    startupTimeoutMs: 2_000,
    lockPath: join(dirnameSafe(server.discoveryPath), "ladybug-server.lock"),
    discoveryPath: server.discoveryPath,
    ...overrides,
  };
}

export function makeFullConfig(dbPath: string): FullConfig {
  return {
    prefix: "tpc_",
    ollama: {
      enabled: false,
      url: "http://localhost:11434",
      model: "mxbai-embed-large",
      dimensions: 1024,
    },
    embedding: {
      provider: "none",
      huggingface: {
        model: "mixedbread-ai/mxbai-embed-large-v1",
        dtype: "fp32",
        dimensions: 1024,
        pooling: "cls",
      },
    },
    ladybugdb: {
      dbPath,
      runtimeMode: "server",
      serverUrl: "grpc://127.0.0.1:7617",
      serverHost: "127.0.0.1",
      serverPort: 7617,
      serverAuthToken: "",
      serverMaxConcurrency: 4,
      serverMaxQueue: 32,
      serverAutostart: false,
      serverStartupTimeoutMs: 2_000,
      serverLockPath: `${dbPath}.lock`,
      serverDiscoveryPath: `${dbPath}.discovery.json`,
      serverIdleTtlMs: 0,
    },
    loadedAt: new Date(),
    source: "default",
  };
}

export function invokeUnary(
  handler: (call: unknown, callback: (error: unknown, response?: unknown) => void) => void | Promise<void>,
  request: unknown,
  metadata?: { get: (key: string) => string[] },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    void handler({ request, metadata }, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function sortNodes(nodes: readonly { readonly id: string }[]): readonly { readonly id: string }[] {
  return [...nodes].sort((left, right) => left.id.localeCompare(right.id));
}

export function sortRelationships(
  relationships: readonly { readonly type: string; readonly sourceId?: string; readonly targetId?: string }[],
): readonly { readonly type: string; readonly sourceId?: string; readonly targetId?: string }[] {
  return [...relationships].sort((left, right) =>
    `${left.sourceId ?? ""}:${left.targetId ?? ""}:${left.type}`.localeCompare(
      `${right.sourceId ?? ""}:${right.targetId ?? ""}:${right.type}`,
    ),
  );
}

export async function applyWorkload(
  adapter: Awaited<ReturnType<typeof createDatabaseAdapter>> | RemoteDatabaseAdapter,
): Promise<void> {
  const vector = adapter.getVectorAdapter();

  await writeSymbol(adapter, "symbol-a");
  await writeSymbol(adapter, "symbol-b");
  await linkSymbols(adapter, "symbol-a", "symbol-b");
  await vector.indexSymbol("symbol-a", { vector: [1, 0], dimensions: 2 }, { kind: "function" });
  await vector.indexSymbol("symbol-b", { vector: [0.8, 0.2], dimensions: 2 }, { kind: "function" });
}

export async function writeSymbol(
  adapter: Awaited<ReturnType<typeof createDatabaseAdapter>> | RemoteDatabaseAdapter,
  id: string,
): Promise<void> {
  await adapter.getGraphAdapter().runCypherWrite(
    `MERGE (n:Symbol {id: "${id}"}) SET n.name = "${id}", n.kind = "function"`,
  );
}

export async function linkSymbols(
  adapter: Awaited<ReturnType<typeof createDatabaseAdapter>> | RemoteDatabaseAdapter,
  fromId: string,
  toId: string,
): Promise<void> {
  await adapter.getGraphAdapter().runCypherWrite(
    `MATCH (a:Symbol {id: "${fromId}"}), (b:Symbol {id: "${toId}"}) MERGE (a)-[:CALLS]->(b)`,
  );
}

function dirnameSafe(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}
