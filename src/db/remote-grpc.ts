import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import type { RpcClientBundle } from "./remote-rpc-client.js";

const PROTO_PATH = fileURLToPath(
  new URL("../../proto/ladybug_connection.proto", import.meta.url),
);
const PROTO_PACKAGE = "typocop.ladybug.v1";
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

  const definition = protoLoader.loadSync(PROTO_PATH, {
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    keepCase: false,
  });
  const descriptor = grpc.loadPackageDefinition(definition) as Record<string, unknown>;
  const root = resolveProtoPackage(descriptor, PROTO_PACKAGE);

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

function resolveProtoPackage(
  root: Record<string, unknown>,
  packageName: string,
): Record<string, unknown> {
  let current: unknown = root;
  for (const key of packageName.split(".")) {
    if (!current || typeof current !== "object" || !(key in current)) {
      throw new Error(`Proto package "${packageName}" is unavailable`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (!current || typeof current !== "object") {
    throw new Error(`Proto package "${packageName}" is invalid`);
  }
  return current as Record<string, unknown>;
}
