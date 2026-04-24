import type {
  EmbeddingConfig,
  LadybugClientConfig,
  OllamaConfig,
} from "../config/types.js";
import { writeDiscoveryFile } from "../db-server/discovery.js";
import { ServerStartupTimeoutError, ServerUnavailableError } from "../db-server/errors.js";
import type { DiscoveryFile } from "../db-server/types.js";
import { RemoteDatabaseAdapter } from "./remote-database-adapter.js";
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
}

interface EnsureServerAndConnectOptions {
  readonly manager?: AutostartManager;
  readonly embeddingConfig?: EmbeddingConfig;
  readonly ollamaConfig?: OllamaConfig;
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

  constructor(deps: AutostartDependencies = {}) {
    this.checkHealthFn = deps.checkHealth || checkServerHealth;
    this.acquireLockFn = deps.acquireLock || acquireCrossProcessLock;
    this.spawnServerFn = deps.spawnServer || spawnConnectionServer;
    this.writeDiscoveryFn = deps.writeDiscovery || writeDiscoveryFile;
    this.readDiscoveryFn = deps.readDiscovery || readDiscoveryFile;
    this.sleepFn = deps.sleep || sleep;
    this.nowFn = deps.now || Date.now;
  }

  async ensureServer(config: LadybugClientConfig): Promise<void> {
    if (await this.checkHealthFn(config, HEALTH_TIMEOUT_MS)) {
      return;
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
}

export async function ensureServerAndConnect(
  config: LadybugClientConfig,
  options: EnsureServerAndConnectOptions = {},
): Promise<RemoteDatabaseAdapter> {
  const manager = options.manager || new DefaultAutostartManager();
  await manager.ensureServer(config);

  const adapter = new RemoteDatabaseAdapter(config, {
    embeddingConfig: options.embeddingConfig,
    ollamaConfig: options.ollamaConfig,
  });
  await adapter.initialize();
  return adapter;
}
