import { describe, expect, it, vi } from "vitest";

vi.mock("@grpc/proto-loader", () => ({
  loadSync: vi.fn(() => ({})),
}));

vi.mock("@grpc/grpc-js", () => ({
  status: {
    UNAVAILABLE: 14,
    DEADLINE_EXCEEDED: 4,
    RESOURCE_EXHAUSTED: 8,
  },
  Metadata: class {
    set(): void {}
  },
  credentials: {
    createInsecure: () => ({}),
  },
  loadPackageDefinition: (definition: unknown) => definition,
}));

import type { LadybugClientConfig } from "../platform/config/types.js";
import { ServerStartupTimeoutError, ServerUnavailableError } from "../db-server/errors.js";
import { DefaultAutostartManager } from "./autostart.js";

const baseConfig: LadybugClientConfig = {
  runtimeMode: "client",
  prefix: "tpc_",
  dbPath: "/tmp/db.ladybug",
  serverUrl: "grpc://127.0.0.1:7617",
  authToken: "",
  autostart: true,
  startupTimeoutMs: 1_000,
  lockPath: "/tmp/server.lock",
  discoveryPath: "/tmp/discovery.json",
};

describe("DefaultAutostartManager", () => {
  it("fails with ServerUnavailableError when autostart is disabled and server is unreachable", async () => {
    const manager = new DefaultAutostartManager({
      checkHealth: vi.fn().mockResolvedValue(false),
      readDiscovery: vi.fn().mockResolvedValue(null),
    });

    await expect(
      manager.ensureServer({ ...baseConfig, autostart: false }),
    ).rejects.toBeInstanceOf(ServerUnavailableError);
  });

  it("acquires the lock, waits for readiness, writes discovery, and releases the lock", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const checkHealth = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const writeDiscovery = vi.fn().mockResolvedValue(undefined);
    const spawnServer = vi.fn().mockResolvedValue({ pid: 4321 });

    const manager = new DefaultAutostartManager({
      checkHealth,
      readDiscovery: vi.fn().mockResolvedValue({
        pid: 1,
        startedAt: new Date(0).toISOString(),
        prefix: "tpc_",
        dbPath: "/tmp/old.ladybug",
        url: "grpc://127.0.0.1:7617",
      }),
      acquireLock: vi.fn().mockResolvedValue(release),
      spawnServer,
      writeDiscovery,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(200),
    });

    await manager.ensureServer(baseConfig);

    expect(spawnServer).toHaveBeenCalledWith(baseConfig);
    expect(writeDiscovery).toHaveBeenCalledWith(
      baseConfig.discoveryPath,
      expect.objectContaining({
        pid: 4321,
        prefix: baseConfig.prefix,
        dbPath: baseConfig.dbPath,
        url: baseConfig.serverUrl,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("re-checks health after acquiring the lock and skips spawning when another process already started the server", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const checkHealth = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const spawnServer = vi.fn();

    const manager = new DefaultAutostartManager({
      checkHealth,
      readDiscovery: vi.fn().mockResolvedValue(null),
      acquireLock: vi.fn().mockResolvedValue(release),
      spawnServer,
    });

    await manager.ensureServer(baseConfig);

    expect(spawnServer).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the lock when startup times out", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const checkHealth = vi.fn().mockResolvedValue(false);

    const manager = new DefaultAutostartManager({
      checkHealth,
      readDiscovery: vi.fn().mockResolvedValue(null),
      acquireLock: vi.fn().mockResolvedValue(release),
      spawnServer: vi.fn().mockResolvedValue({ pid: 123 }),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(200)
        .mockReturnValueOnce(400)
        .mockReturnValueOnce(600)
        .mockReturnValueOnce(800)
        .mockReturnValueOnce(1_000),
    });

    await expect(manager.ensureServer(baseConfig)).rejects.toBeInstanceOf(
      ServerStartupTimeoutError,
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
