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

import type { LadybugClientConfig } from "../../platform/config/types.js";
import type { DiscoveryFile } from "./types.js";
import { DEFAULT_GRPC_MAX_MESSAGE_BYTES } from "../../platform/utils/limits.js";
import { ServerStartupTimeoutError, ServerUnavailableError } from "./errors.js";
import { DefaultAutostartManager } from "./autostart.js";

const baseConfig: LadybugClientConfig = {
  runtimeMode: "client",
  prefix: "tpc_",
  dbPath: "/tmp/db.ladybug",
  serverUrl: "grpc://127.0.0.1:7617",
  authToken: "",
  grpcMaxMessageBytes: DEFAULT_GRPC_MAX_MESSAGE_BYTES,
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
      // Phase E: keep the prior discovery's pid "dead" so the restart-await
      // fast-skip applies and this test still exercises the spawn path.
      isPidAlive: vi.fn().mockReturnValue(false),
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

  it("force-kills a wedged spawned server, drops its DB lock, and respawns until healthy", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    // top(false), after-lock(false), attempt-1 while(false), attempt-2 while(true)
    const checkHealth = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const spawnServer = vi
      .fn()
      .mockResolvedValueOnce({ pid: 1001 }) // wedges
      .mockResolvedValueOnce({ pid: 1002 }); // healthy
    const writeDiscovery = vi.fn().mockResolvedValue(undefined);
    const forceKillPid = vi.fn();
    const clearDbLock = vi.fn();

    const manager = new DefaultAutostartManager({
      checkHealth,
      readDiscovery: vi.fn().mockResolvedValue(null),
      listDiscoveryFiles: vi.fn().mockResolvedValue([]),
      acquireLock: vi.fn().mockResolvedValue(release),
      spawnServer,
      writeDiscovery,
      forceKillPid,
      clearDbLock,
      sleep: vi.fn().mockResolvedValue(undefined),
      isPidAlive: vi.fn().mockReturnValue(false),
      // startupTimeoutMs 30s → perAttempt 10s. Sequence walks attempt 1 past its
      // window (10001), then attempt 2 connects (10200), all under 30000.
      now: vi
        .fn()
        .mockReturnValueOnce(0) // overallDeadline base → 30000
        .mockReturnValueOnce(0) // attempt-1 attemptDeadline base → 10000
        .mockReturnValueOnce(200) // attempt-1 while #1 (<10000)
        .mockReturnValueOnce(10_001) // attempt-1 while #2 (exit window)
        .mockReturnValueOnce(10_001) // attempt-1 overall-deadline check (<30000)
        .mockReturnValueOnce(10_001) // attempt-2 attemptDeadline base → 20001
        .mockReturnValueOnce(10_200), // attempt-2 while #1 (<20001) → healthy
    });

    await manager.ensureServer({ ...baseConfig, startupTimeoutMs: 30_000 });

    expect(spawnServer).toHaveBeenCalledTimes(2);
    expect(forceKillPid).toHaveBeenCalledWith(1001); // the wedged server
    expect(clearDbLock).toHaveBeenCalledWith(baseConfig.dbPath);
    expect(writeDiscovery).toHaveBeenCalledWith(
      baseConfig.discoveryPath,
      expect.objectContaining({ pid: 1002 }), // the healthy respawn
    );
    expect(release).toHaveBeenCalledOnce();
  });

  describe("Phase E — liveness/identity gate before killing a wrong-prefix pid", () => {
    const mismatchDiscovery: DiscoveryFile = {
      pid: 4242,
      startedAt: "2026-01-01T00:00:00.000Z",
      prefix: "other_",
      dbPath: "/tmp/db.ladybug",
      url: "grpc://0.0.0.0:7617",
    };

    function mismatchDeps(overrides: {
      isPidAlive: (pid: number) => boolean;
      healthAnswers: boolean[];
    }) {
      const release = vi.fn().mockResolvedValue(undefined);
      const killPid = vi.fn();
      const spawnServer = vi.fn().mockResolvedValue({ pid: 99 });
      const writeDiscovery = vi.fn().mockResolvedValue(undefined);
      const answers = [...overrides.healthAnswers];
      const checkHealth = vi
        .fn<(...args: unknown[]) => Promise<boolean>>()
        .mockImplementation(async () => {
          const next = answers.shift();
          return typeof next === "boolean" ? next : false;
        });
      const manager = new DefaultAutostartManager({
        checkHealth,
        readDiscovery: vi.fn().mockResolvedValue(mismatchDiscovery),
        listDiscoveryFiles: vi
          .fn()
          .mockResolvedValue(["/home/user/.typocop/other_/ladybug-server.json"]),
        acquireLock: vi.fn().mockResolvedValue(release),
        spawnServer,
        writeDiscovery,
        sleep: vi.fn().mockResolvedValue(undefined),
        now: vi.fn(() => 0),
        killPid,
        isPidAlive: vi.fn(overrides.isPidAlive),
      });
      return { manager, killPid, spawnServer, release };
    }

    it("never signals a pid that is not alive (recycled/dead pid)", async () => {
      const { manager, killPid, spawnServer } = mismatchDeps({
        isPidAlive: () => false,
        // 1) entry healthy, 2) lock-recheck healthy; identity gate fails on
        //    liveness so no kill; 3) poll loop sees unhealthy -> break,
        //    4) spawn-path recheck unhealthy, 5) spawn poll becomes healthy.
        healthAnswers: [true, true, false, false, true],
      });

      await manager.ensureServer(baseConfig);

      expect(killPid).not.toHaveBeenCalled();
      expect(spawnServer).toHaveBeenCalled();
    });

    it("never signals a pid that is alive but fails the identity health probe (foreign pid)", async () => {
      // pid alive, but the health probe on the advertised url does NOT respond.
      const { manager, killPid, spawnServer } = mismatchDeps({
        isPidAlive: () => true,
        // 1) entry healthy, 2) lock-recheck healthy, 3) identity probe FAILS
        //    (no kill), 4) poll loop unhealthy -> break, 5) spawn-path recheck
        //    unhealthy, 6) spawn poll becomes healthy.
        healthAnswers: [true, true, false, false, false, true],
      });

      await manager.ensureServer(baseConfig);

      expect(killPid).not.toHaveBeenCalled();
      expect(spawnServer).toHaveBeenCalled();
    });

    it("signals a live, identity-confirmed wrong-prefix pid (legitimate kill preserved)", async () => {
      const { manager, killPid } = mismatchDeps({
        isPidAlive: () => true,
        // 1) entry healthy, 2) lock-recheck healthy, 3) identity probe responds
        //    -> kill, 4) becomes unhealthy after kill -> break out of poll loop,
        //    5) spawn-path recheck unhealthy, 6) spawn poll becomes healthy.
        healthAnswers: [true, true, true, false, false, true],
      });

      await manager.ensureServer(baseConfig);

      expect(killPid).toHaveBeenCalledWith(4242);
    });
  });

  describe("Phase E — bounded restart-await avoids spawn storms", () => {
    it("awaits a live restarting server instead of double-spawning across concurrent callers", async () => {
      // A single shared server that is briefly down then comes up. The owning
      // pid (matching prefix) is alive, so callers must await its health rather
      // than each spawning a new one.
      const ourDiscovery: DiscoveryFile = {
        pid: 5555,
        startedAt: "2026-01-01T00:00:00.000Z",
        prefix: baseConfig.prefix,
        dbPath: baseConfig.dbPath,
        url: baseConfig.serverUrl,
      };

      const spawnServer = vi.fn().mockResolvedValue({ pid: 777 });
      // Real cross-process lock would serialize; here a shared in-memory mutex
      // models the lock so only one caller is in the critical section at a time.
      let locked = false;
      const acquireLock = vi.fn(async () => {
        while (locked) {
          await new Promise((r) => setTimeout(r, 5));
        }
        locked = true;
        return async () => {
          locked = false;
        };
      });

      // Health: down for the first few probes, then up. The restart-await loop
      // polls until it observes health, so no caller should reach spawn.
      let probes = 0;
      const checkHealth = vi.fn(async () => {
        probes++;
        return probes > 3;
      });

      let nowMs = 0;
      const makeManager = () =>
        new DefaultAutostartManager({
          checkHealth,
          readDiscovery: vi.fn().mockResolvedValue(ourDiscovery),
          listDiscoveryFiles: vi
            .fn()
            .mockResolvedValue(["/home/user/.typocop/tpc_/ladybug-server.json"]),
          acquireLock,
          spawnServer,
          writeDiscovery: vi.fn().mockResolvedValue(undefined),
          sleep: vi.fn(async () => {
            nowMs += 200;
          }),
          now: vi.fn(() => nowMs),
          isPidAlive: vi.fn(() => true),
        });

      const managers = [makeManager(), makeManager()];
      await Promise.all(managers.map((m) => m.ensureServer(baseConfig)));

      expect(spawnServer).not.toHaveBeenCalled();
    });
  });
});
