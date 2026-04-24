import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as lockfile from "proper-lockfile";

import type { LadybugClientConfig } from "../config/types.js";
import type { DiscoveryFile } from "../db-server/types.js";
import { toGrpcTarget, waitForReady } from "./remote-grpc.js";

const PROTO_PATH = fileURLToPath(
  new URL("../../proto/ladybug_connection.proto", import.meta.url),
);
const PROTO_PACKAGE = "typocop.ladybug.v1";
const DEFAULT_SERVER_SCRIPT = fileURLToPath(
  new URL("../../dist/db-server/main.js", import.meta.url),
);

interface HealthCheckResponse {
  readonly status?: string | number;
}

interface HealthClient {
  Check(
    request: Record<string, never>,
    metadata: grpc.Metadata,
    options: { readonly deadline: Date },
    callback: (error: Error | null, response?: HealthCheckResponse) => void,
  ): void;
  waitForReady(deadline: Date, callback: (error?: Error | null) => void): void;
  close(): void;
}

interface HealthClientConstructor {
  new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: grpc.ClientOptions,
  ): HealthClient;
}

export interface SpawnResult {
  readonly pid: number | undefined;
}

let healthClientCtor: HealthClientConstructor | null = null;

export async function checkServerHealth(
  config: LadybugClientConfig,
  timeoutMs: number,
): Promise<boolean> {
  const client = createHealthClient(config.serverUrl);
  try {
    await waitForReady(client, timeoutMs);
    const metadata = new grpc.Metadata();
    if (config.authToken !== "") {
      metadata.set("authorization", `Bearer ${config.authToken}`);
    }

    const response = await new Promise<HealthCheckResponse>((resolve, reject) => {
      client.Check(
        {},
        metadata,
        { deadline: new Date(Date.now() + timeoutMs) },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result || {});
        },
      );
    });

    return response.status === 1 || response.status === "SERVING";
  } catch {
    return false;
  } finally {
    client.close();
  }
}

export async function acquireCrossProcessLock(
  lockPath: string,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, "", { flag: "a" });
  return lockfile.lock(lockPath, {
    stale: Math.max(timeoutMs, 1_000),
    retries: {
      retries: Math.max(1, Math.ceil(timeoutMs / 200)),
      minTimeout: 50,
      maxTimeout: 200,
    },
  });
}

export async function spawnConnectionServer(
  config: LadybugClientConfig,
): Promise<SpawnResult> {
  const parsed = new URL(config.serverUrl);
  const child = spawn(
    process.execPath,
    [
      DEFAULT_SERVER_SCRIPT,
      "--db-path",
      config.dbPath,
      "--prefix",
      config.prefix,
      "--host",
      parsed.hostname,
      "--port",
      parsed.port || "7617",
      "--auth-token",
      config.authToken,
      "--discovery-path",
      config.discoveryPath,
    ],
    { detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );

  // Capture stderr to log server startup errors
  if (child.stderr) {
    child.stderr.on("data", (data: Buffer) => {
      console.error(`[ladybug-server] ${data.toString().trim()}`);
    });
  }

  child.unref();
  return { pid: child.pid };
}

export async function readDiscoveryFile(path: string): Promise<DiscoveryFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as DiscoveryFile;
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHealthClient(serverUrl: string): HealthClient {
  const Ctor = loadHealthClientCtor();
  return new Ctor(
    toGrpcTarget(serverUrl),
    grpc.credentials.createInsecure(),
  );
}

function loadHealthClientCtor(): HealthClientConstructor {
  if (healthClientCtor) {
    return healthClientCtor;
  }

  const definition = protoLoader.loadSync(PROTO_PATH, {
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    keepCase: false,
  });
  const descriptor = grpc.loadPackageDefinition(definition) as Record<string, unknown>;
  const pkg = resolveProtoPackage(descriptor, PROTO_PACKAGE);
  const health = pkg["Health"];
  if (typeof health !== "function") {
    throw new Error("Health client constructor is unavailable");
  }
  healthClientCtor = health as HealthClientConstructor;
  return healthClientCtor;
}

function resolveProtoPackage(
  root: Record<string, unknown>,
  packageName: string,
): Record<string, unknown> {
  let current: unknown = root;
  for (const part of packageName.split(".")) {
    if (!current || typeof current !== "object" || !(part in current)) {
      throw new Error(`Proto package "${packageName}" is unavailable`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current as Record<string, unknown>;
}
