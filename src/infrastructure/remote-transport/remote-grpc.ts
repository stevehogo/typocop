import * as grpc from "@grpc/grpc-js";

import {
  DEFAULT_GRPC_MAX_MESSAGE_BYTES,
  GRPC_KEEPALIVE_TIME_MS,
  GRPC_KEEPALIVE_TIMEOUT_MS,
} from "../../platform/utils/limits.js";
import { loadConnectionProtoPackage } from "./proto-loader.js";
import type { RpcClientBundle } from "./remote-rpc-client.js";

export const CONNECT_READY_TIMEOUT_MS = 2_000;

/**
 * Overall budget (per client) for establishing the gRPC channel, across retries
 * + backoff. A single short `waitForReady` hard-fails ("Failed to connect before
 * the deadline") when the server is cold/busy and needs more than one attempt to
 * accept the channel; this budget lets a slow cold-start (or a transient blip)
 * recover instead of failing the whole run. Override with `TYPOCOP_CONNECT_TIMEOUT_MS`.
 */
export const CONNECT_TOTAL_TIMEOUT_MS = 15_000;
export const CONNECT_TIMEOUT_ENV = "TYPOCOP_CONNECT_TIMEOUT_MS";
const CONNECT_RETRY_BACKOFF_MS = 250;

/** Resolve the connect budget from {@link CONNECT_TIMEOUT_ENV} (positive int) or default. */
export function getConnectTotalTimeoutMs(): number {
  const raw = process.env[CONNECT_TIMEOUT_ENV];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return CONNECT_TOTAL_TIMEOUT_MS;
}

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

export function createGrpcClientOptions(
  maxMessageBytes = DEFAULT_GRPC_MAX_MESSAGE_BYTES,
): grpc.ClientOptions {
  return {
    "grpc.max_receive_message_length": maxMessageBytes,
    "grpc.max_send_message_length": maxMessageBytes,
    // Keepalive: ping the server during long idle windows (the --pdg compute gap)
    // so the channel stays warm and a later write doesn't hit a dropped conn.
    // `permit_without_calls` is essential — the gap has NO active RPCs.
    "grpc.keepalive_time_ms": GRPC_KEEPALIVE_TIME_MS,
    "grpc.keepalive_timeout_ms": GRPC_KEEPALIVE_TIMEOUT_MS,
    "grpc.keepalive_permit_without_calls": 1,
    "grpc.http2.max_pings_without_data": 0,
  };
}

export function createRpcClients(
  target: string,
  maxMessageBytes = DEFAULT_GRPC_MAX_MESSAGE_BYTES,
): RpcClientBundle {
  const constructors = loadClientConstructors();
  const options = createGrpcClientOptions(maxMessageBytes);
  return {
    graph: new constructors.Graph(target, grpc.credentials.createInsecure(), options),
    vector: new constructors.Vector(target, grpc.credentials.createInsecure(), options),
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

/**
 * Establish a gRPC channel, retrying {@link waitForReady} with exponential
 * backoff up to a total budget. gRPC auto-reconnects the channel internally
 * between attempts, so this tolerates a server whose cold-start exceeds a single
 * attempt's deadline — the failure mode behind intermittent
 * "Failed to connect before the deadline" on `parse`/`status`.
 */
export async function waitForReadyWithRetry(
  client: { waitForReady(deadline: Date, callback: (error?: Error | null) => void): void },
  opts: { perAttemptMs?: number; totalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const perAttemptMs = opts.perAttemptMs ?? CONNECT_READY_TIMEOUT_MS;
  const totalMs = opts.totalMs ?? getConnectTotalTimeoutMs();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + totalMs;
  let backoff = CONNECT_RETRY_BACKOFF_MS;
  let lastError: unknown;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      await waitForReady(client, Math.min(perAttemptMs, remaining));
      return;
    } catch (error) {
      lastError = error;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(backoff, left));
      backoff = Math.min(backoff * 2, CONNECT_READY_TIMEOUT_MS);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("gRPC channel did not become ready within the connect budget");
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
