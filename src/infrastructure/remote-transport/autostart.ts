import type { LadybugClientConfig } from "../../platform/config/types.js";
import type { EmbeddingAdapter } from "../../core/ports/persistence.js";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeDiscoveryFile } from "./discovery.js";
import { ServerStartupTimeoutError, ServerUnavailableError } from "./errors.js";
import type { DiscoveryFile } from "./types.js";
import { RemoteDatabaseAdapter } from "./remote-adapters/remote-database-adapter.js";
import {
  acquireCrossProcessLock,
  checkServerHealth,
  readDiscoveryFile,
  sleep,
  spawnConnectionServer,
  type SpawnResult,
} from "./autostart-runtime.js";

const HEALTH_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 200;
/**
 * Upper bound for awaiting a server that appears to be mid-restart (a fresh,
 * healthy-looking discovery record or a live owning pid). Keeps a brief outage
 * from triggering an immediate re-spawn that would race other clients on the
 * lock (resilience Phase E).
 */
const RESTART_AWAIT_DEADLINE_MS = 3_000;

interface AutostartDependencies {
  readonly checkHealth?: (
    config: LadybugClientConfig,
    timeoutMs: number,
  ) => Promise<boolean>;
  readonly acquireLock?: (lockPath: string, timeoutMs: number) => Promise<() => Promise<void>>;
  readonly spawnServer?: (config: LadybugClientConfig) => Promise<SpawnResult>;
  readonly writeDiscovery?: (path: string, discovery: DiscoveryFile) => Promise<void>;
  readonly readDiscovery?: (path: string) => Promise<DiscoveryFile | null>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly listDiscoveryFiles?: () => Promise<readonly string[]>;
  readonly killPid?: (pid: number) => void;
  /**
   * Liveness probe for a discovered pid. Default uses `process.kill(pid, 0)`,
   * which is a no-op signal that throws `ESRCH` when the pid is gone. Injectable
   * so tests never poke real pids (resilience Phase E, failure mode #8).
   */
  readonly isPidAlive?: (pid: number) => boolean;
}

interface EnsureServerAndConnectOptions {
  readonly manager?: AutostartManager;
  /** Embedding adapter injected by the composition root (§14). */
  readonly embeddingAdapter?: EmbeddingAdapter;
}

export interface AutostartManager {
  ensureServer(config: LadybugClientConfig): Promise<void>;
  readDiscovery(discoveryPath: string): Promise<DiscoveryFile | null>;
}

export class DefaultAutostartManager implements AutostartManager {
  private readonly checkHealthFn: (config: LadybugClientConfig, timeoutMs: number) => Promise<boolean>;
  private readonly acquireLockFn: (lockPath: string, timeoutMs: number) => Promise<() => Promise<void>>;
  private readonly spawnServerFn: (config: LadybugClientConfig) => Promise<SpawnResult>;
  private readonly writeDiscoveryFn: (path: string, discovery: DiscoveryFile) => Promise<void>;
  private readonly readDiscoveryFn: (path: string) => Promise<DiscoveryFile | null>;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly listDiscoveryFilesFn: () => Promise<readonly string[]>;
  private readonly killPidFn: (pid: number) => void;
  private readonly isPidAliveFn: (pid: number) => boolean;

  constructor(deps: AutostartDependencies = {}) {
    this.checkHealthFn = deps.checkHealth || checkServerHealth;
    this.acquireLockFn = deps.acquireLock || acquireCrossProcessLock;
    this.spawnServerFn = deps.spawnServer || spawnConnectionServer;
    this.writeDiscoveryFn = deps.writeDiscovery || writeDiscoveryFile;
    this.readDiscoveryFn = deps.readDiscovery || readDiscoveryFile;
    this.sleepFn = deps.sleep || sleep;
    this.nowFn = deps.now || Date.now;
    this.listDiscoveryFilesFn = deps.listDiscoveryFiles || listDefaultDiscoveryFiles;
    this.killPidFn = deps.killPid || ((pid) => process.kill(pid, "SIGTERM"));
    this.isPidAliveFn = deps.isPidAlive || defaultIsPidAlive;
  }

  async ensureServer(config: LadybugClientConfig): Promise<void> {
    if (await this.checkHealthFn(config, HEALTH_TIMEOUT_MS)) {
      const discovery = await this.findDiscoveryForServerUrl(config.serverUrl);
      if (!discovery || discovery.prefix === config.prefix) {
        return;
      }
      if (!config.autostart) {
        throw new ServerUnavailableError(config.serverUrl);
      }

      const release = await this.acquireLockFn(config.lockPath, config.startupTimeoutMs);
      try {
        if (!(await this.checkHealthFn(config, HEALTH_TIMEOUT_MS))) {
          return;
        }

        const latest = await this.findDiscoveryForServerUrl(config.serverUrl);
        if (!latest || latest.prefix === config.prefix) {
          return;
        }

        const pid = typeof latest.pid === "number" ? latest.pid : -1;
        const shouldKill = pid > 0 && (await this.isOurLiveServer(config, latest, pid));
        if (!shouldKill) {
          // The discovery record points at a dead or recycled/foreign pid: do
          // NOT signal it. Treat the advertisement as stale, skip the kill, and
          // fall through to the normal spawn path (resilience Phase E, #8).
          console.error(
            `[typocop] Skipping termination of stale/foreign discovery pid ${pid} for ${latest.url}; proceeding to normal startup`,
          );
        } else {
          try {
            this.killPidFn(pid);
          } catch {
            // Best-effort. If termination fails, spawning may fail with EADDRINUSE.
          }
        }

        const deadline = this.nowFn() + HEALTH_TIMEOUT_MS;
        while (this.nowFn() < deadline) {
          await this.sleepFn(POLL_INTERVAL_MS);
          if (!(await this.checkHealthFn(config, 500))) {
            break;
          }
        }
      } finally {
        await release();
      }
    }

    // Stale discovery files are ignored; health is the source of truth.
    await this.readDiscoveryFn(config.discoveryPath).catch(() => null);

    if (!config.autostart) {
      throw new ServerUnavailableError(config.serverUrl);
    }

    const release = await this.acquireLockFn(config.lockPath, config.startupTimeoutMs);
    try {
      if (await this.checkHealthFn(config, HEALTH_TIMEOUT_MS)) {
        return;
      }

      // Health is briefly down. Before re-spawning (which would race other
      // clients on the lock), check whether a server appears to be mid-restart:
      // a live owning pid in the latest discovery record. If so, await it with
      // backoff up to a bounded deadline rather than immediately spawning
      // (resilience Phase E — avoid spawn storms).
      if (await this.awaitRestartingServer(config)) {
        return;
      }

      console.error(`[typocop] Spawning connection server at ${config.serverUrl}...`);
      const spawned = await this.spawnServerFn(config);
      console.error(`[typocop] Server spawned with PID ${spawned.pid}`);
      
      const startedAt = new Date().toISOString();
      const deadline = this.nowFn() + config.startupTimeoutMs;
      let attempts = 0;

      while (this.nowFn() < deadline) {
        await this.sleepFn(POLL_INTERVAL_MS);
        attempts++;
        if (await this.checkHealthFn(config, 1_000)) {
          console.error(`[typocop] Server became healthy after ${attempts} attempts`);
          await this.writeDiscoveryFn(config.discoveryPath, {
            pid: spawned.pid ?? -1,
            startedAt,
            prefix: config.prefix,
            dbPath: config.dbPath,
            url: config.serverUrl,
          });
          return;
        }
      }

      console.error(`[typocop] Server health check failed after ${attempts} attempts over ${config.startupTimeoutMs}ms`);
      throw new ServerStartupTimeoutError(config.startupTimeoutMs);
    } finally {
      await release();
    }
  }

  async readDiscovery(discoveryPath: string): Promise<DiscoveryFile | null> {
    return this.readDiscoveryFn(discoveryPath);
  }

  /**
   * Identity + liveness gate before terminating a discovered wrong-prefix
   * server. The pid must be alive (so we never SIGTERM a recycled/foreign pid)
   * AND a health probe on the *advertised* url must respond (confirming a real
   * typocop server is listening there, consistent with the discovery record).
   * Only then is the kill considered safe (resilience Phase E, failure mode #8).
   */
  private async isOurLiveServer(
    config: LadybugClientConfig,
    discovery: DiscoveryFile,
    pid: number,
  ): Promise<boolean> {
    let alive: boolean;
    try {
      alive = this.isPidAliveFn(pid);
    } catch {
      alive = false;
    }
    if (!alive) {
      return false;
    }

    // Probe health on the server's own advertised url to confirm identity:
    // a live process plus a responding gRPC health endpoint at the discovered
    // address is our server, not a recycled pid that merely reuses the number.
    const probeConfig: LadybugClientConfig = { ...config, serverUrl: discovery.url };
    try {
      return await this.checkHealthFn(probeConfig, HEALTH_TIMEOUT_MS);
    } catch {
      return false;
    }
  }

  /**
   * When health is briefly down, decide whether a server is coming up (so we
   * should wait rather than spawn). If the latest discovery record names a live
   * owning pid, poll health with backoff up to `RESTART_AWAIT_DEADLINE_MS`.
   * Returns true if the server became healthy within the deadline (caller
   * should NOT spawn); false to proceed to the normal spawn path.
   */
  private async awaitRestartingServer(config: LadybugClientConfig): Promise<boolean> {
    const discovery = await this.findDiscoveryForServerUrl(config.serverUrl);
    // Only await a server that is genuinely ours coming back up: a wrong-prefix
    // record is a foreign/old server, not our restart. Spawn normally in that
    // case (e.g. right after terminating a mismatched server).
    if (!discovery || discovery.prefix !== config.prefix) {
      return false;
    }
    const pid = typeof discovery.pid === "number" ? discovery.pid : -1;
    let ownerAlive = false;
    if (pid > 0) {
      try {
        ownerAlive = this.isPidAliveFn(pid);
      } catch {
        ownerAlive = false;
      }
    }
    if (!ownerAlive) {
      // No live owning process suggests a restart in progress; spawn normally.
      return false;
    }

    console.error(
      `[typocop] Live server pid ${pid} appears to be restarting; awaiting health up to ${RESTART_AWAIT_DEADLINE_MS}ms before spawning`,
    );

    const deadline = this.nowFn() + RESTART_AWAIT_DEADLINE_MS;
    let backoff = POLL_INTERVAL_MS;
    while (this.nowFn() < deadline) {
      await this.sleepFn(backoff);
      if (await this.checkHealthFn(config, 1_000)) {
        return true;
      }
      // If the owning process died while we waited, stop awaiting and spawn.
      try {
        if (!this.isPidAliveFn(pid)) {
          return false;
        }
      } catch {
        return false;
      }
      backoff = Math.min(backoff * 2, HEALTH_TIMEOUT_MS);
    }
    return false;
  }

  private async findDiscoveryForServerUrl(serverUrl: string): Promise<DiscoveryFile | null> {
    const target = parseGrpcUrl(serverUrl);
    const candidates = await this.listDiscoveryFilesFn().catch(() => []);
    for (const filePath of candidates) {
      const discovery = await this.readDiscoveryFn(filePath).catch(() => null);
      if (!discovery) continue;
      if (!target) {
        if (discovery.url === serverUrl) return discovery;
        continue;
      }

      // Hostnames often differ between client and server discovery:
      // server binds to 0.0.0.0 but client connects via 127.0.0.1/localhost.
      // Since only one process can bind a port, matching by port is enough.
      const candidate = parseGrpcUrl(discovery.url);
      if (candidate && candidate.port === target.port) {
        return discovery;
      }
    }
    return null;
  }
}

export async function ensureServerAndConnect(
  config: LadybugClientConfig,
  options: EnsureServerAndConnectOptions = {},
): Promise<RemoteDatabaseAdapter> {
  const manager = options.manager || new DefaultAutostartManager();
  await manager.ensureServer(config);

  const adapter = new RemoteDatabaseAdapter(config, {
    embeddingAdapter: options.embeddingAdapter,
  });
  await adapter.initialize();
  return adapter;
}

async function listDefaultDiscoveryFiles(): Promise<readonly string[]> {
  const root = join(homedir(), ".typocop");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "locks")
    .map((entry) => join(root, entry.name, "ladybug-server.json"));
}

/**
 * Default pid-liveness probe. `process.kill(pid, 0)` sends no signal but
 * performs the permission/existence check: it returns normally when the pid
 * exists and throws `ESRCH` when it does not. `EPERM` means the process exists
 * but is owned by another user — still "alive" for our purposes.
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

function parseGrpcUrl(value: string): { readonly port: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "grpc:" || url.port.trim() === "") return null;
    return { port: url.port };
  } catch {
    return null;
  }
}
