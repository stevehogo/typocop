import * as grpc from "@grpc/grpc-js";

import { loadConnectionProtoPackage } from "./proto-loader.js";
import type { RpcClientBundle } from "./remote-rpc-client.js";

export const CONNECT_READY_TIMEOUT_MS = 2_000;

const TRANSIENT_GRPC_CODES = new Set<number>([
  grpc.status.UNAVAILABLE,
  grpc.status.DEADLINE_EXCEEDED,
  grpc.status.RESOURCE_EXHAUSTED,
]);

interface ProtoClientConstructor {
  new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: grpc.ClientOptions,
  ): { close(): void; waitForReady(deadline: Date, callback: (error?: Error | null) => void): void; [method: string]: unknown };
}

let cachedClientConstructors:
  | {
    readonly Graph: ProtoClientConstructor;
    readonly Vector: ProtoClientConstructor;
  }
  | null = null;

export function createRpcClients(target: string): RpcClientBundle {
  const constructors = loadClientConstructors();
  return {
    graph: new constructors.Graph(target, grpc.credentials.createInsecure()),
    vector: new constructors.Vector(target, grpc.credentials.createInsecure()),
  };
}

export function toGrpcTarget(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  if (parsed.host === "") {
    throw new Error(`Invalid serverUrl: ${serverUrl}`);
  }
  return parsed.host;
}

export function waitForReady(
  client: { waitForReady(deadline: Date, callback: (error?: Error | null) => void): void },
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.waitForReady(
      new Date(Date.now() + timeoutMs),
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export function closeClients(clients: RpcClientBundle): void {
  clients.graph.close();
  if (clients.vector !== clients.graph) {
    clients.vector.close();
  }
}

export function isTransientGrpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "number" && TRANSIENT_GRPC_CODES.has(code);
}

function loadClientConstructors(): {
  readonly Graph: ProtoClientConstructor;
  readonly Vector: ProtoClientConstructor;
} {
  if (cachedClientConstructors) {
    return cachedClientConstructors;
  }

  const root = loadConnectionProtoPackage();

  const graphCtor = root["Graph"];
  const vectorCtor = root["Vector"];
  if (typeof graphCtor !== "function" || typeof vectorCtor !== "function") {
    throw new Error("Graph/Vector client constructors not found in proto descriptor");
  }

  cachedClientConstructors = {
    Graph: graphCtor as ProtoClientConstructor,
    Vector: vectorCtor as ProtoClientConstructor,
  };
  return cachedClientConstructors;
}

