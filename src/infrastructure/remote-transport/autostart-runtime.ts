import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as lockfile from "proper-lockfile";

import type { LadybugClientConfig } from "../../platform/config/types.js";
import type { DiscoveryFile } from "./types.js";
import { loadConnectionProtoPackage } from "./proto-loader.js";
import { createGrpcClientOptions, toGrpcTarget, waitForReady } from "./remote-grpc.js";

// dist/infrastructure/remote-transport/autostart-runtime.js -> climb three to
// <root>, then dist/apps/ladybug-server/main.js (the server binary it spawns).
// §13.3: runtime-only path — typecheck won't catch a wrong depth.
const DEFAULT_SERVER_SCRIPT = fileURLToPath(
  new URL("../../../dist/apps/ladybug-server/main.js", import.meta.url),
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
  const client = createHealthClient(config);
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
      "--grpc-max-message-bytes",
      String(config.grpcMaxMessageBytes),
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

/** Outcome of {@link stopConnectionServer}. */
export interface StopServerResult {
  /** True when a live server process was signalled (and, when waited, observed to exit). */
  readonly stopped: boolean;
  /** The discovery-file pid that was found/signalled, when any. */
  readonly pid?: number;
  /** Human-readable reason when `stopped` is false (no server / stale / timed out). */
  readonly reason?: string;
}

/** True if `pid` is a live process this user can signal (EPERM ⇒ alive but not ours). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Stop a running connection (LadybugDB) server by reading its discovery file for
 * the owning pid and sending SIGTERM — the server's own signal handler drains
 * in-flight requests, closes the DB, and removes the discovery file (graceful
 * shutdown). Returns `{stopped:false}` when no live server is found (missing or
 * stale discovery file). Polls up to `timeoutMs` for the process to actually exit.
 *
 * Discovery-file based (not a port scan) so it targets exactly the server this
 * client config points at, and works even if the server is wedged / not serving
 * gRPC. Idempotent: calling it with no server running is a clean no-op.
 */
export async function stopConnectionServer(
  discoveryPath: string,
  options: { readonly timeoutMs?: number; readonly signal?: NodeJS.Signals } = {},
): Promise<StopServerResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const signal = options.signal ?? "SIGTERM";

  const discovery = await readDiscoveryFile(discoveryPath);
  if (!discovery || typeof discovery.pid !== "number") {
    return { stopped: false, reason: "no running server found (no discovery file)" };
  }
  const pid = discovery.pid;

  if (!isProcessAlive(pid)) {
    return { stopped: false, pid, reason: `no running server (discovery pid ${pid} is not alive — stale discovery file)` };
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { stopped: false, pid, reason: `process ${pid} already exited` };
    if (code === "EPERM") return { stopped: false, pid, reason: `not permitted to signal process ${pid}` };
    throw error;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return { stopped: true, pid };
    await sleep(150);
  }
  // Signal delivered but the process is still up after the grace window.
  return isProcessAlive(pid)
    ? { stopped: false, pid, reason: `signalled but process ${pid} did not exit within ${timeoutMs}ms` }
    : { stopped: true, pid };
}

function createHealthClient(config: LadybugClientConfig): HealthClient {
  const Ctor = loadHealthClientCtor();
  return new Ctor(
    toGrpcTarget(config.serverUrl),
    grpc.credentials.createInsecure(),
    createGrpcClientOptions(config.grpcMaxMessageBytes),
  );
}

function loadHealthClientCtor(): HealthClientConstructor {
  if (healthClientCtor) {
    return healthClientCtor;
  }

  const pkg = loadConnectionProtoPackage();
  const health = pkg["Health"];
  if (typeof health !== "function") {
    throw new Error("Health client constructor is unavailable");
  }
  healthClientCtor = health as HealthClientConstructor;
  return healthClientCtor;
}
